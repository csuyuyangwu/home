import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function client(api = '', responses = []) {
    const mounted = [], requests = [];
    const window = { COMMUNITY_API_URL: api };
    const context = {
        window, crypto, AbortSignal, localStorage: { getItem: () => null, setItem() {} },
        fetch: async (url, options) => {
            requests.push({ url, options });
            const result = responses.shift();
            if (result instanceof Error) throw result;
            return Response.json(result?.body || {}, { status: result?.status || 200 });
        }
    };
    vm.runInNewContext(readFileSync(new URL('../static/js/community.js', import.meta.url), 'utf8'), context);
    const refs = { ref: value => ({ value }), reactive: value => value, computed: fn => ({ get value() { return fn(); } }), onMounted: fn => mounted.push(fn) };
    const lang = { value: 'zh' };
    return { model: window.useCommunity(refs, lang), mounted, requests, lang };
}
test('unconfigured frontend neither simulates likes nor accepts comments', async () => {
    const { model, mounted, requests } = client();
    mounted.forEach(fn => fn());
    await model.addLike(); await model.submitComment();
    assert.equal(requests.length, 0);
    assert.equal(model.likeCount.value, null);
    assert.equal(model.communityConfigured, false);
});
test('frontend only displays server-confirmed likes and does not optimistically publish comments', async () => {
    const { model, requests, lang } = client('https://api.example.test', [
        { body: { count: 12, liked: true } }, { status: 202, body: { status: 'pending' } }
    ]);
    await model.addLike();
    assert.equal(model.likeCount.value, 12); assert.equal(model.hasLiked.value, true);
    await model.addLike(); assert.equal(requests.length, 1);
    model.commentForm.name = 'Alice'; model.commentForm.message = 'Hello';
    await model.submitComment();
    assert.equal(model.publicComments.value.length, 0);
    assert.equal(model.communityNotice.value, 'submitted');
    assert.equal(model.commentForm.message, '');
    assert(model.communityMessage.value.includes('审核'));
    lang.value = 'en'; assert(model.communityMessage.value.includes('approval'));
});
test('failed submission preserves draft; failed like does not increase count', async () => {
    const { model } = client('https://api.example.test', [new Error('Offline'), { status: 429 }]);
    await model.addLike(); assert.equal(model.likeCount.value, null); assert.equal(model.likeError.value, true);
    model.commentForm.name = 'A'; model.commentForm.message = 'Keep my draft';
    await model.submitComment();
    assert.equal(model.commentForm.message, 'Keep my draft');
    assert.equal(model.communityNotice.value, 'limited'); assert.equal(model.submittingComment.value, false);
});
