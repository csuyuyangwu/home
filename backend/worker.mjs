const encoder = new TextEncoder();
const REVIEW_TTL = 14 * 24 * 60 * 60 * 1000;
const MAX_BODY = 8192;
class HttpError extends Error {
    constructor(status, message) { super(message); this.status = status; }
}
const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const json = (value, status = 200) => Response.json(value, { status });

async function sign(secret, value) {
    const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const bytes = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(value)));
    return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}
function equalTokens(a, b) {
    if (typeof a !== 'string' || a.length !== b.length) return false;
    let difference = 0;
    for (let i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return difference === 0;
}
function configured(env) {
    if (!env.DB || !env.MODERATION_SECRET || env.MODERATION_SECRET.length < 32) throw new HttpError(503, 'Service is not configured');
}
function mailConfigured(env) {
    if (!env.RESEND_API_KEY || !env.MODERATOR_EMAIL || !env.MAIL_FROM || env.MAIL_FROM.includes('REPLACE_') ||
        !env.PUBLIC_API_URL || env.PUBLIC_API_URL.includes('REPLACE_') || !env.PUBLIC_API_URL.startsWith('https://')) {
        throw new HttpError(503, 'Email moderation is not configured');
    }
}
async function readBody(request) {
    if (!request.body) throw new HttpError(400, 'Missing body');
    const reader = request.body.getReader();
    let size = 0;
    const decoder = new TextDecoder();
    let text = '';
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > MAX_BODY) { await reader.cancel(); throw new HttpError(413, 'Request too large'); }
            text += decoder.decode(value, { stream: true });
        }
        return text + decoder.decode();
    } finally { reader.releaseLock(); }
}
async function readJson(request) {
    if (!request.headers.get('Content-Type')?.startsWith('application/json')) throw new HttpError(415, 'JSON required');
    try {
        const body = JSON.parse(await readBody(request));
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
        return body;
    } catch (error) {
        if (error instanceof HttpError) throw error;
        throw new HttpError(400, 'Invalid JSON');
    }
}
function visitor(value) {
    if (typeof value !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)) {
        throw new HttpError(400, 'Invalid visitor identifier');
    }
    return value.toLowerCase();
}
async function rateLimit(request, env, action, limit) {
    // Cloudflare supplies this header. Store only a keyed hash, never the raw IP.
    const ip = request.headers.get('CF-Connecting-IP') || 'local-development';
    const hour = Math.floor(Date.now() / 3600000);
    const key = await sign(env.MODERATION_SECRET, `rate:${action}:${hour}:${ip}`);
    const row = await env.DB.prepare(`INSERT INTO rate_limits (key, count, expires_at) VALUES (?, 1, ?)
        ON CONFLICT(key) DO UPDATE SET count = count + 1 RETURNING count`)
        .bind(key, (hour + 1) * 3600000).first();
    if (row.count > limit) throw new HttpError(429, 'Please try again in an hour');
}
async function likeStats(env, id) {
    return env.DB.prepare(`SELECT (SELECT COUNT(*) FROM likes) AS count,
        EXISTS(SELECT 1 FROM likes WHERE visitor = ?) AS liked`).bind(id).first()
        .then(row => ({ count: row.count, liked: Boolean(row.liked) }));
}
async function reviewToken(env, comment) {
    return sign(env.MODERATION_SECRET, `review:${comment.reference}:${comment.created_at}`);
}
async function notify(env, comment) {
    mailConfigured(env);
    const token = await reviewToken(env, comment);
    const link = new URL('/moderate', env.PUBLIC_API_URL);
    link.searchParams.set('id', comment.reference);
    link.searchParams.set('token', token);
    const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${env.RESEND_API_KEY}`,
            'Content-Type': 'application/json',
            'Idempotency-Key': `comment-${comment.reference}`
        },
        signal: AbortSignal.timeout(10000),
        body: JSON.stringify({
            from: env.MAIL_FROM,
            to: [env.MODERATOR_EMAIL],
            subject: '个人主页：有一条新留言等待审核',
            text: `昵称：${comment.name}\n提交时间：${comment.created_at}\n\n${comment.message}\n\n审核链接（14 天内有效，请勿转发）：\n${link}\n\n打开链接后选择通过或拒绝。通过后才会在主页公开显示。\n\n站主管理（登录后可删除留言）：${new URL('/admin', env.PUBLIC_API_URL)}`,
            html: `<h2>个人主页新留言</h2><p>昵称：${escapeHtml(comment.name)}</p><p>提交时间：${escapeHtml(comment.created_at)}</p><pre style="white-space:pre-wrap">${escapeHtml(comment.message)}</pre><p><a href="${escapeHtml(link)}">打开审核页面</a></p><p>链接 14 天内有效，请勿转发。打开链接不会直接发布留言，请在页面中选择通过或拒绝。</p><p><a href="${escapeHtml(new URL('/admin', env.PUBLIC_API_URL))}">站主管理：登录后可删除留言</a></p>`
        })
    });
    if (!response.ok) throw new Error('Email provider rejected notification');
    await env.DB.prepare('UPDATE comments SET notified = 1 WHERE id = ?').bind(comment.id).run();
}
async function tryNotify(env, comment) {
    try { await notify(env, comment); }
    catch {
        // Keep the pending comment. The scheduled handler retries failed mail.
        const attempts = comment.notification_attempts + 1;
        const delay = Math.min(3600000, 60000 * 2 ** Math.min(attempts, 6));
        await env.DB.prepare('UPDATE comments SET notification_attempts = ?, notification_next_at = ? WHERE id = ?')
            .bind(attempts, Date.now() + delay, comment.id).run();
    }
}
function reviewPage(title, content, status = 200) {
    return new Response(`<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>body{background:#0d1117;color:#e6edf3;font:17px/1.8 system-ui;padding:24px}main{max-width:680px;margin:40px auto;background:#161b22;border:1px solid #30363d;border-radius:12px;padding:28px}pre{font:inherit;white-space:pre-wrap;overflow-wrap:anywhere}button{padding:12px 22px;margin:8px;border:0;border-radius:6px;font:inherit;cursor:pointer}button[value=approve]{background:#3fb950;color:#071108}h1{font-size:24px}a{color:#58a6ff}article{margin-top:24px}button[value=delete]{background:#da3633;color:white}</style></head><body><main><h1>${escapeHtml(title)}</h1>${content}</main></body></html>`, {
        status,
        headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
            // Send only the origin, never the URL containing a private token.
            // no-referrer makes browser form POSTs send Origin: null, which
            // conflicts with the same-origin validation on review/admin forms.
            'Referrer-Policy': 'strict-origin',
            'X-Robots-Tag': 'noindex, nofollow'
        }
    });
}
async function moderate(request, env, url) {
    let reference = url.searchParams.get('id'), token = url.searchParams.get('token'), action;
    if (request.method === 'POST') {
        if (request.headers.get('Origin') !== url.origin) throw new HttpError(403, 'Invalid origin');
        if (!request.headers.get('Content-Type')?.startsWith('application/x-www-form-urlencoded')) throw new HttpError(415, 'Form required');
        const form = new URLSearchParams(await readBody(request));
        reference = form.get('id'); token = form.get('token'); action = form.get('action');
    }
    if (!reference || !/^[a-f0-9-]{36}$/.test(reference)) throw new HttpError(403, 'Invalid review link');
    const comment = await env.DB.prepare('SELECT * FROM comments WHERE reference = ?').bind(reference).first();
    if (!comment || !equalTokens(token, await reviewToken(env, comment))) throw new HttpError(403, 'Invalid review link');
    if (Date.now() - Date.parse(comment.created_at) > REVIEW_TTL) throw new HttpError(410, 'Review link expired');
    if (request.method === 'POST') {
        if (!['approve', 'reject'].includes(action)) throw new HttpError(400, 'Invalid decision');
        const status = action === 'approve' ? 'approved' : 'rejected';
        await env.DB.prepare("UPDATE comments SET status = ?, reviewed_at = ? WHERE reference = ? AND status = 'pending'")
            .bind(status, new Date().toISOString(), reference).run();
        // Post/Redirect/Get: refreshing the result cannot repeat the action.
        const destination = new URL('/moderate', url.origin);
        destination.searchParams.set('id', reference); destination.searchParams.set('token', token);
        return new Response(null, { status: 303, headers: { Location: destination.href } });
    }
    const detail = `<p>昵称：${escapeHtml(comment.name)}</p><pre>${escapeHtml(comment.message)}</pre>`;
    if (comment.status !== 'pending') return reviewPage('留言已审核', detail + `<p>${comment.status === 'approved' ? '已通过，留言已在主页公开。' : '已拒绝，留言不会在主页显示。'}</p><p><a href="/admin">站主管理：登录后可删除留言</a></p>`);
    return reviewPage('审核留言', detail + `<p>通过后，昵称和留言内容会公开显示在主页。</p><form method="post" action="/moderate"><input type="hidden" name="id" value="${escapeHtml(reference)}"><input type="hidden" name="token" value="${escapeHtml(token)}"><button name="action" value="approve">通过并发布</button><button name="action" value="reject">拒绝</button></form>`);
}
const OWNER_COOKIE = '__Host-home-admin';
const OWNER_SESSION_TTL = 7 * 24 * 3600000;
const randomToken = () => crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '');
async function ownerTokenHash(env, token) {
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return null;
    return sign(env.MODERATION_SECRET, 'owner:' + token);
}
function ownerLoginPage(sent = false) {
    return reviewPage('站主登录', `<p>只有站主邮箱可以收到登录链接。登录后可查看和删除留言。</p>${sent ? '<p>登录邮件已发送，请检查站主邮箱。链接 15 分钟有效，只能使用一次。</p>' : '<form method="post" action="/admin/login"><button name="action" value="login">发送登录链接到站主邮箱</button></form>'}`);
}
async function admin(request, env, url) {
    let form;
    if (request.method === 'POST') {
        if (request.headers.get('Origin') !== url.origin) throw new HttpError(403, 'Invalid origin');
        if (!request.headers.get('Content-Type')?.startsWith('application/x-www-form-urlencoded')) throw new HttpError(415, 'Form required');
        form = new URLSearchParams(request.body ? await readBody(request) : '');
    }
    if (url.pathname === '/admin/login' && request.method === 'POST') {
        mailConfigured(env);
        await rateLimit(request, env, 'owner-login', 3);
        const token = randomToken();
        const tokenHash = await ownerTokenHash(env, token);
        await env.DB.prepare("INSERT INTO owner_tokens (token_hash, kind, expires_at) VALUES (?, 'login', ?)")
            .bind(tokenHash, Date.now() + 15 * 60000).run();
        const link = new URL('/admin/confirm', env.PUBLIC_API_URL);
        link.searchParams.set('token', token);
        const response = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
            signal: AbortSignal.timeout(10000),
            body: JSON.stringify({
                from: env.MAIL_FROM, to: [env.MODERATOR_EMAIL], subject: '个人主页：站主管理登录',
                text: `站主登录链接（15 分钟有效，只能使用一次，请勿转发）：\n${link}\n\n打开页面后点击“确认登录”，即可管理和删除留言。若非你本人操作，可忽略本邮件。`,
                html: `<h2>站主管理登录</h2><p><a href="${escapeHtml(link)}">打开站主登录页面</a></p><p>15 分钟有效，只能使用一次，请勿转发。打开后点击“确认登录”才会生效。若非你本人操作，可忽略本邮件。</p>`
            })
        });
        if (!response.ok) {
            await env.DB.prepare('DELETE FROM owner_tokens WHERE token_hash = ?').bind(tokenHash).run();
            throw new HttpError(502, 'Could not send login email');
        }
        return ownerLoginPage(true);
    }
    if (url.pathname === '/admin/confirm' && ['GET', 'POST'].includes(request.method)) {
        const token = request.method === 'GET' ? url.searchParams.get('token') : form.get('token');
        const hash = await ownerTokenHash(env, token);
        const entry = hash && await env.DB.prepare("SELECT token_hash FROM owner_tokens WHERE token_hash = ? AND kind = 'login' AND expires_at > ?").bind(hash, Date.now()).first();
        if (!entry) return reviewPage('登录链接不可用', '<p>链接已过期或已使用，请<a href="/admin">重新登录</a>。</p>', 403);
        if (request.method === 'GET') return reviewPage('确认站主登录', `<p>点击按钮登录留言管理。请勿转发此页面链接。</p><form method="post" action="/admin/confirm"><input type="hidden" name="token" value="${escapeHtml(token)}"><button>确认登录</button></form>`);
        const consumed = await env.DB.prepare("DELETE FROM owner_tokens WHERE token_hash = ? AND kind = 'login' AND expires_at > ? RETURNING token_hash")
            .bind(hash, Date.now()).first();
        if (!consumed) throw new HttpError(403, 'Login link already used');
        const session = randomToken();
        await env.DB.prepare("INSERT INTO owner_tokens (token_hash, kind, expires_at) VALUES (?, 'session', ?)")
            .bind(await ownerTokenHash(env, session), Date.now() + OWNER_SESSION_TTL).run();
        return new Response(null, { status: 303, headers: {
            Location: '/admin',
            'Set-Cookie': `${OWNER_COOKIE}=${session}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=604800`
        } });
    }
    const cookie = request.headers.get('Cookie')?.split(';').map(s => s.trim()).find(s => s.startsWith(OWNER_COOKIE + '='))?.slice(OWNER_COOKIE.length + 1);
    const sessionHash = await ownerTokenHash(env, cookie);
    const session = sessionHash && await env.DB.prepare("SELECT token_hash FROM owner_tokens WHERE token_hash = ? AND kind = 'session' AND expires_at > ?")
        .bind(sessionHash, Date.now()).first();
    if (!session) {
        if (url.pathname === '/admin' && request.method === 'GET') return ownerLoginPage();
        throw new HttpError(403, 'Owner login required');
    }
    if (url.pathname === '/admin/logout' && request.method === 'POST') {
        await env.DB.prepare('DELETE FROM owner_tokens WHERE token_hash = ?').bind(sessionHash).run();
        return new Response(null, { status: 303, headers: { Location: '/admin', 'Set-Cookie': `${OWNER_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0` } });
    }
    if (url.pathname === '/admin/delete' && ['GET', 'POST'].includes(request.method)) {
        const id = request.method === 'GET' ? url.searchParams.get('id') : form.get('id');
        if (!/^\d+$/.test(id || '') || !Number.isSafeInteger(Number(id)) || Number(id) < 1) throw new HttpError(400, 'Invalid comment ID');
        if (request.method === 'POST') {
            if (form.get('confirm') !== 'delete') throw new HttpError(400, 'Deletion confirmation required');
            await env.DB.prepare('DELETE FROM comments WHERE id = ?').bind(Number(id)).run();
            return new Response(null, { status: 303, headers: { Location: '/admin?deleted=1' } });
        }
        const comment = await env.DB.prepare('SELECT name, message FROM comments WHERE id = ?').bind(Number(id)).first();
        if (!comment) throw new HttpError(404, 'Comment not found');
        return reviewPage('确认删除留言', `<p>昵称：${escapeHtml(comment.name)}</p><pre>${escapeHtml(comment.message)}</pre><p>删除后会从主页和数据库移除，无法恢复。</p><form method="post" action="/admin/delete"><input type="hidden" name="id" value="${Number(id)}"><button name="confirm" value="delete">确认删除</button></form><p><a href="/admin">取消，返回管理页</a></p>`);
    }
    if (url.pathname === '/admin' && request.method === 'GET') {
        const before = url.searchParams.get('before');
        if (before !== null && (!/^\d+$/.test(before) || !Number.isSafeInteger(Number(before)) || Number(before) < 1)) throw new HttpError(400, 'Invalid cursor');
        const { results } = await env.DB.prepare('SELECT id, name, message, status, created_at FROM comments WHERE id < ? ORDER BY id DESC LIMIT 21')
            .bind(before ? Number(before) : Number.MAX_SAFE_INTEGER).all();
        const statuses = { pending: '待审核', approved: '已公开', rejected: '已拒绝' };
        const entries = results.slice(0, 20).map(comment => `<article><hr><p><strong>${escapeHtml(comment.name)}</strong> · ${statuses[comment.status]} · ${escapeHtml(comment.created_at)}</p><pre>${escapeHtml(comment.message)}</pre><a href="/admin/delete?id=${comment.id}">删除这条留言</a></article>`).join('');
        const more = results.length > 20 ? `<p><a href="/admin?before=${results[19].id}">更早的留言</a></p>` : '';
        return reviewPage('留言管理', `<p>站主已登录。删除后，主页刷新即可看到变化。</p><form method="post" action="/admin/logout"><button name="action" value="logout">退出登录</button></form>${url.searchParams.get('deleted') === '1' ? '<p>留言已删除。</p>' : ''}${entries || '<p>暂无留言。</p>'}${more}`);
    }
    throw new HttpError(404, 'Not found');
}
async function route(request, env) {
    configured(env);
    const url = new URL(request.url);
    if (url.pathname === '/admin' || url.pathname.startsWith('/admin/')) return admin(request, env, url);
    if (url.pathname === '/moderate' && ['GET', 'POST'].includes(request.method)) return moderate(request, env, url);
    const origin = request.headers.get('Origin');
    if (origin && origin !== env.SITE_ORIGIN) throw new HttpError(403, 'Origin not allowed');
    if (request.method === 'OPTIONS') return new Response(null, { status: 204 });
    if (request.method === 'POST' && origin !== env.SITE_ORIGIN) throw new HttpError(403, 'Origin required');
    if (url.pathname === '/api/likes' && request.method === 'GET') {
        return json(await likeStats(env, visitor(url.searchParams.get('visitor'))));
    }
    if (url.pathname === '/api/likes' && request.method === 'POST') {
        const id = visitor((await readJson(request)).visitor);
        await rateLimit(request, env, 'likes', 30);
        await env.DB.prepare('INSERT OR IGNORE INTO likes (visitor) VALUES (?)').bind(id).run();
        return json(await likeStats(env, id));
    }
    if (url.pathname === '/api/comments' && request.method === 'GET') {
        const before = url.searchParams.get('before');
        if (before !== null && (!/^\d+$/.test(before) || !Number.isSafeInteger(Number(before)) || Number(before) < 1)) throw new HttpError(400, 'Invalid cursor');
        const { results } = await env.DB.prepare(`SELECT id, name, message, created_at AS createdAt FROM comments
            WHERE status = 'approved' AND id < ? ORDER BY id DESC LIMIT 21`).bind(before ? Number(before) : Number.MAX_SAFE_INTEGER).all();
        const items = results.slice(0, 20);
        return json({ items, nextCursor: results.length > 20 ? items.at(-1).id : null });
    }
    if (url.pathname === '/api/comments' && request.method === 'POST') {
        mailConfigured(env);
        const body = await readJson(request);
        if (body.website) throw new HttpError(400, 'Invalid submission');
        const name = typeof body.name === 'string' ? body.name.trim() : '';
        const message = typeof body.message === 'string' ? body.message.trim() : '';
        if (!name || name.length > 40 || !message || message.length > 1000) throw new HttpError(400, 'Invalid name or message');
        await rateLimit(request, env, 'comments', 3);
        const reference = crypto.randomUUID();
        const comment = await env.DB.prepare('INSERT INTO comments (reference, name, message, created_at) VALUES (?, ?, ?, ?) RETURNING *')
            .bind(reference, name, message, new Date().toISOString()).first();
        await tryNotify(env, comment);
        return json({ status: 'pending' }, 202);
    }
    throw new HttpError(404, 'Not found');
}
export default {
    async fetch(request, env) {
        let response;
        try { response = await route(request, env); }
        catch (error) {
            const status = error instanceof HttpError ? error.status : 500;
            // Do not log request URLs: moderation links contain private bearer tokens.
            response = /^\/(moderate|admin)(\/|$)/.test(new URL(request.url).pathname)
                ? reviewPage('无法审核', `<p>${escapeHtml(status === 410 ? '审核链接已过期，请联系网站管理员。' : '链接无效或服务暂不可用。')}</p>`, status)
                : json({ error: status === 500 ? 'Internal server error' : error.message }, status);
        }
        const headers = new Headers(response.headers);
        headers.set('Cache-Control', 'no-store');
        headers.set('X-Content-Type-Options', 'nosniff');
        headers.set('Vary', 'Origin');
        if (request.headers.get('Origin') === env.SITE_ORIGIN) {
            headers.set('Access-Control-Allow-Origin', env.SITE_ORIGIN);
            headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
            headers.set('Access-Control-Allow-Headers', 'Content-Type');
        }
        if (response.status === 429) headers.set('Retry-After', '3600');
        return new Response(response.body, { status: response.status, headers });
    },
    async scheduled(_event, env) {
        configured(env);
        await env.DB.prepare('DELETE FROM rate_limits WHERE expires_at < ?').bind(Date.now()).run();
        await env.DB.prepare('DELETE FROM owner_tokens WHERE expires_at < ?').bind(Date.now()).run();
        const { results } = await env.DB.prepare("SELECT * FROM comments WHERE notified = 0 AND status = 'pending' AND notification_next_at <= ? AND created_at >= ? ORDER BY id LIMIT 10")
            .bind(Date.now(), new Date(Date.now() - REVIEW_TTL).toISOString()).all();
        for (const comment of results) await tryNotify(env, comment);
    }
};
