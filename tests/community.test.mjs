import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker from '../backend/worker.mjs';

class D1 {
    constructor() {
        this.sqlite = new DatabaseSync(':memory:');
        this.sqlite.exec(readFileSync(new URL('../backend/schema.sql', import.meta.url), 'utf8'));
    }
    prepare(sql) {
        const statement = this.sqlite.prepare(sql);
        let values = [];
        const query = {
            bind(...args) { values = args; return query; },
            async first() { return statement.get(...values) || null; },
            async all() { return { results: statement.all(...values) }; },
            async run() { return statement.run(...values); }
        };
        return query;
    }
}
function fixture() {
    const env = {
        DB: new D1(), MODERATION_SECRET: 'test-only-secret-with-at-least-32-random-characters',
        SITE_ORIGIN: 'https://csuyuyangwu.github.io', PUBLIC_API_URL: 'https://community.example.test',
        MAIL_FROM: 'Test <test@example.test>', MODERATOR_EMAIL: '2995824036@qq.com', RESEND_API_KEY: 'test-not-real'
    };
    function request(path, method = 'GET', body, extra = {}) {
        return worker.fetch(new Request('https://community.example.test' + path, {
            method,
            headers: { Origin: env.SITE_ORIGIN, 'Content-Type': 'application/json', 'CF-Connecting-IP': '192.0.2.1', ...extra },
            ...(body !== undefined ? { body: JSON.stringify(body) } : {})
        }), env);
    }
    return { env, request };
}
function reviewRequest(link, action) {
    const url = new URL(link);
    if (!action) return new Request(url);
    return new Request(new URL('/moderate', url), {
        method: 'POST', headers: { Origin: url.origin, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ id: url.searchParams.get('id'), token: url.searchParams.get('token'), action })
    });
}
function captureMail(t, status = 200) {
    const emails = [];
    t.mock.method(globalThis, 'fetch', async (url, options) => {
        assert.equal(url, 'https://api.resend.com/emails');
        emails.push({ body: JSON.parse(options.body), headers: options.headers });
        return Response.json({ id: 'test-mail' }, { status });
    });
    return emails;
}
const linkFrom = mail => mail.body.text.match(/https:\/\/community\.example\.test\/moderate\?[^\s]+/)[0];
function adminRequest(env, path, fields, cookie, origin = 'https://community.example.test') {
    return worker.fetch(new Request('https://community.example.test' + path, {
        method: fields ? 'POST' : 'GET',
        headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}), ...(fields ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}), 'CF-Connecting-IP': '192.0.2.2' },
        ...(fields ? { body: new URLSearchParams(fields) } : {})
    }), env);
}
async function loginOwner(env, emails) {
    assert.equal((await adminRequest(env, '/admin/login', {})).status, 200);
    const email = emails.at(-1).body;
    assert.deepEqual(email.to, ['2995824036@qq.com']);
    const link = new URL(email.text.match(/https:\/\/community\.example\.test\/admin\/confirm\?[^\s]+/)[0]);
    const token = link.searchParams.get('token');
    assert.equal((await adminRequest(env, link.pathname + link.search)).status, 200);
    // Link previews do not consume the one-time token.
    assert.equal((await adminRequest(env, link.pathname + link.search)).status, 200);
    const response = await adminRequest(env, '/admin/confirm', { token });
    assert.equal(response.status, 303);
    const setCookie = response.headers.get('Set-Cookie');
    assert(setCookie.includes('HttpOnly')); assert(setCookie.includes('Secure')); assert(setCookie.includes('SameSite=Strict'));
    return { cookie: setCookie.split(';')[0], token };
}

test('shared like count is persistent and repeated visitor IDs are idempotent', async () => {
    const { request } = fixture();
    const a = crypto.randomUUID(), b = crypto.randomUUID();
    assert.deepEqual(await (await request('/api/likes?visitor=' + a)).json(), { count: 0, liked: false });
    const replies = await Promise.all(Array.from({ length: 5 }, () => request('/api/likes', 'POST', { visitor: a })));
    assert(replies.every(r => r.status === 200));
    assert.deepEqual(await (await request('/api/likes?visitor=' + a)).json(), { count: 1, liked: true });
    assert.deepEqual(await (await request('/api/likes?visitor=' + b)).json(), { count: 1, liked: false });
    assert.deepEqual(await (await request('/api/likes', 'POST', { visitor: b })).json(), { count: 2, liked: true });
});

test('pending comments stay private; email preview cannot approve; signed POST can approve', async t => {
    const { env, request } = fixture();
    const emails = captureMail(t);
    const message = '<script>alert("xss")</script>\nHello';
    assert.equal((await request('/api/comments', 'POST', { name: '<b>Alice</b>', message })).status, 202);
    assert.equal(emails.length, 1);
    assert.deepEqual(emails[0].body.to, ['2995824036@qq.com']);
    assert(!emails[0].body.html.includes('<script>'));
    assert(emails[0].body.html.includes('&lt;script&gt;'));
    assert.equal((await (await request('/api/comments')).json()).items.length, 0);
    const link = linkFrom(emails[0]);
    const preview = await worker.fetch(reviewRequest(link), env);
    assert.equal(preview.status, 200);
    assert((await preview.text()).includes('&lt;script&gt;'));
    assert.equal((await (await request('/api/comments')).json()).items.length, 0);
    assert.equal((await worker.fetch(reviewRequest(link, 'approve'), env)).status, 303);
    const result = await (await request('/api/comments')).json();
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].message, message);
    assert.deepEqual(Object.keys(result.items[0]).sort(), ['createdAt', 'id', 'message', 'name']);
    // A second action does not reverse a completed review.
    await worker.fetch(reviewRequest(link, 'reject'), env);
    assert.equal((await (await request('/api/comments')).json()).items.length, 1);
});

test('invalid tokens, expired links and foreign moderation origins cannot publish', async t => {
    const { env, request } = fixture();
    const emails = captureMail(t);
    await request('/api/comments', 'POST', { name: 'Alice', message: 'Private' });
    const link = linkFrom(emails[0]);
    const bad = new URL(link); bad.searchParams.set('token', '0'.repeat(64));
    assert.equal((await worker.fetch(reviewRequest(bad, 'approve'), env)).status, 403);
    const forged = reviewRequest(link, 'approve');
    const foreign = new Request(forged, { headers: { Origin: 'https://attacker.test', 'Content-Type': 'application/x-www-form-urlencoded' } });
    assert.equal((await worker.fetch(foreign, env)).status, 403);
    const originalNow = Date.now;
    t.mock.method(Date, 'now', () => originalNow() + 15 * 24 * 3600000);
    assert.equal((await worker.fetch(reviewRequest(link, 'approve'), env)).status, 410);
    assert.equal((await (await request('/api/comments')).json()).items.length, 0);
});

test('rejected comments are never returned publicly', async t => {
    const { env, request } = fixture();
    const emails = captureMail(t);
    await request('/api/comments', 'POST', { name: 'Guest', message: 'Do not publish' });
    assert.equal((await worker.fetch(reviewRequest(linkFrom(emails[0]), 'reject'), env)).status, 303);
    assert.equal((await (await request('/api/comments')).json()).items.length, 0);
});

test('failed email notifications remain queued and cron retries with the same idempotency key', async t => {
    const { env, request } = fixture();
    let failing = true;
    const mails = [];
    t.mock.method(globalThis, 'fetch', async (_url, options) => {
        mails.push(options.headers['Idempotency-Key']);
        return Response.json({}, { status: failing ? 503 : 200 });
    });
    assert.equal((await request('/api/comments', 'POST', { name: 'A', message: 'Queued' })).status, 202);
    let row = await env.DB.prepare('SELECT * FROM comments').first();
    assert.equal(row.notified, 0); assert.equal(row.notification_attempts, 1); assert.equal(row.status, 'pending');
    failing = false;
    await env.DB.prepare('UPDATE comments SET notification_next_at = 0').run();
    await worker.scheduled({}, env);
    row = await env.DB.prepare('SELECT * FROM comments').first();
    assert.equal(row.notified, 1); assert.equal(row.status, 'pending');
    assert.equal(mails[0], mails[1]);
});

test('validates length and origin, rate limits comments, fails closed without mail setup', async t => {
    const { env, request } = fixture();
    captureMail(t);
    assert.equal((await request('/api/comments', 'POST', { name: '', message: 'x' })).status, 400);
    assert.equal((await request('/api/comments', 'POST', { name: 'A', message: 'x'.repeat(1001) })).status, 400);
    assert.equal((await request('/api/comments', 'POST', { name: 'A', message: 'x', website: 'spam' })).status, 400);
    assert.equal((await request('/api/likes', 'POST', { visitor: crypto.randomUUID() }, { Origin: 'https://attacker.test' })).status, 403);
    assert.equal((await request('/api/comments', 'POST', { name: 'A', message: 'x' }, { Origin: 'https://attacker.test' })).status, 403);
    assert.equal((await request('/api/comments', 'POST', { name: 'A', message: 'x'.repeat(9000) })).status, 413);
    for (let i = 0; i < 3; i++) assert.equal((await request('/api/comments', 'POST', { name: 'A', message: 'x' })).status, 202);
    const limited = await request('/api/comments', 'POST', { name: 'A', message: 'x' });
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get('Retry-After'), '3600');
    env.RESEND_API_KEY = '';
    assert.equal((await request('/api/comments', 'POST', { name: 'A', message: 'x' })).status, 503);
});

test('public pagination only returns approved messages and excludes private fields', async () => {
    const { env, request } = fixture();
    for (let i = 0; i < 25; i++) {
        await env.DB.prepare("INSERT INTO comments (reference, name, message, created_at, status) VALUES (?, ?, ?, ?, 'approved')")
            .bind(crypto.randomUUID(), 'Guest', String(i), new Date().toISOString()).run();
    }
    const first = await (await request('/api/comments')).json();
    assert.equal(first.items.length, 20);
    const second = await (await request('/api/comments?before=' + first.nextCursor)).json();
    assert.equal(second.items.length, 5); assert.equal(second.nextCursor, null);
    assert.equal(new Set(first.items.concat(second.items).map(c => c.id)).size, 25);
    const response = await request('/api/comments');
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), env.SITE_ORIGIN);
    assert.equal((await request('/api/comments?before=oops')).status, 400);
});

test('only emailed owner login can delete; previews and foreign requests cannot delete', async t => {
    const { env, request } = fixture();
    const emails = captureMail(t);
    await request('/api/comments', 'POST', { name: 'Guest', message: '<script>Do not execute</script>' });
    const reviewLink = linkFrom(emails[0]);
    await worker.fetch(reviewRequest(reviewLink, 'approve'), env);
    const id = (await (await request('/api/comments')).json()).items[0].id;
    assert.equal((await adminRequest(env, '/admin/delete', { id, confirm: 'delete' })).status, 403);
    assert.equal((await request('/api/comments/' + id, 'DELETE')).status, 404);
    assert.equal((await adminRequest(env, '/admin/delete?id=' + id)).status, 403);
    const { cookie, token } = await loginOwner(env, emails);
    const replay = await adminRequest(env, '/admin/confirm', { token });
    assert.equal(replay.status, 403);
    const publicBody = await (await request('/api/comments')).text();
    assert(!publicBody.includes(token)); assert(!publicBody.includes('token_hash'));
    const adminPage = await adminRequest(env, '/admin', undefined, cookie);
    const adminHtml = await adminPage.text();
    assert(adminHtml.includes('&lt;script&gt;')); assert(!adminHtml.includes('<script>'));
    const preview = await adminRequest(env, '/admin/delete?id=' + id, undefined, cookie);
    assert.equal(preview.status, 200);
    assert((await preview.text()).includes('确认删除'));
    assert.equal((await (await request('/api/comments')).json()).items.length, 1);
    assert.equal((await adminRequest(env, '/admin/delete', { id, confirm: 'delete' }, cookie, 'https://attacker.test')).status, 403);
    assert.equal((await adminRequest(env, '/admin/delete', { id }, cookie)).status, 400);
    assert.equal((await adminRequest(env, '/admin/delete', { id, confirm: 'delete' }, cookie)).status, 303);
    assert.equal((await (await request('/api/comments')).json()).items.length, 0);
    assert.equal(await env.DB.prepare('SELECT id FROM comments WHERE id = ?').bind(id).first(), null);
    // An old review email cannot recreate a deleted comment.
    assert.equal((await worker.fetch(reviewRequest(reviewLink, 'approve'), env)).status, 403);
    assert.equal((await adminRequest(env, '/admin/logout', {}, cookie)).status, 303);
    assert.equal((await adminRequest(env, '/admin/delete', { id, confirm: 'delete' }, cookie)).status, 403);
});

test('owner sessions can delete old comments; expired sessions and login tokens are rejected', async t => {
    const { env } = fixture();
    const emails = captureMail(t);
    await env.DB.prepare("INSERT INTO comments (reference, name, message, created_at, status) VALUES (?, 'Old guest', 'Old comment', '2020-01-01T00:00:00Z', 'approved')")
        .bind(crypto.randomUUID()).run();
    const { cookie } = await loginOwner(env, emails);
    assert.equal((await adminRequest(env, '/admin/delete', { id: '1', confirm: 'delete' }, cookie)).status, 303);
    const now = Date.now;
    t.mock.method(Date, 'now', () => now() + 8 * 24 * 3600000);
    assert.equal((await adminRequest(env, '/admin/delete', { id: '1', confirm: 'delete' }, cookie)).status, 403);
    t.mock.restoreAll();
    const freshEmails = captureMail(t);
    await adminRequest(env, '/admin/login', {});
    const entry = await env.DB.prepare("SELECT token_hash FROM owner_tokens WHERE kind = 'login'").first();
    await env.DB.prepare("UPDATE owner_tokens SET expires_at = 0 WHERE token_hash = ?").bind(entry.token_hash).run();
    const lastMail = freshEmails.at(-1);
    const oldLink = new URL(lastMail.body.text.match(/https:\/\/community\.example\.test\/admin\/confirm\?[^\s]+/)[0]);
    assert.equal((await adminRequest(env, oldLink.pathname + oldLink.search)).status, 403);
});
