window.useCommunity = function ({ ref, reactive, computed, onMounted }, lang) {
    const api = (window.COMMUNITY_API_URL || '').replace(/\/$/, '');
    const communityConfigured = Boolean(api);
    const likeCount = ref(null);
    const hasLiked = ref(false);
    const liking = ref(false);
    const communityLoading = ref(false);
    const commentsLoading = ref(false);
    const submittingComment = ref(false);
    const publicComments = ref([]);
    const commentsCursor = ref(null);
    const communityNotice = ref('');
    const likeError = ref(false);
    const commentsError = ref(false);
    const commentForm = reactive({ name: '', message: '', website: '' });
    // This identifier prevents accidental repeat likes in the same browser.
    let visitorId;
    try {
        visitorId = localStorage.getItem('home-community-visitor');
        if (!/^[a-f0-9-]{36}$/i.test(visitorId || '')) {
            visitorId = crypto.randomUUID();
            localStorage.setItem('home-community-visitor', visitorId);
        }
    } catch { visitorId = crypto.randomUUID(); }
    const notices = {
        submitted: ['Your message is awaiting approval. Thank you!', '留言已提交，审核通过后会显示在这里。谢谢！'],
        failed: ['Submission failed. Please try again later.', '提交失败，请稍后重试。'],
        limited: ['Too many requests. Please try again in an hour.', '操作较频繁，请一小时后再试。'],
        invalid: ['Enter a name (up to 40 characters) and a message (up to 1000 characters).', '请填写昵称（最多 40 字）和留言（最多 1000 字）。']
    };
    const communityMessage = computed(() => notices[communityNotice.value]?.[lang.value === 'en' ? 0 : 1] || '');
    async function request(path, options = {}) {
        const response = await fetch(api + path, {
            ...options,
            headers: { 'Content-Type': 'application/json', ...options.headers },
            signal: AbortSignal.timeout(15000)
        });
        if (!response.ok) {
            const error = new Error('Community request failed');
            error.status = response.status;
            throw error;
        }
        return response.json();
    }
    async function loadLikes() {
        communityLoading.value = true;
        likeError.value = false;
        try {
            const result = await request('/api/likes?visitor=' + encodeURIComponent(visitorId));
            likeCount.value = result.count;
            hasLiked.value = result.liked;
        } catch { likeError.value = true; }
        finally { communityLoading.value = false; }
    }
    async function loadComments(append = false) {
        if (commentsLoading.value) return;
        commentsLoading.value = true;
        commentsError.value = false;
        try {
            const result = await request('/api/comments' + (append && commentsCursor.value ? '?before=' + commentsCursor.value : ''));
            publicComments.value = append ? publicComments.value.concat(result.items) : result.items;
            commentsCursor.value = result.nextCursor;
        } catch { commentsError.value = true; }
        finally { commentsLoading.value = false; }
    }
    async function addLike() {
        if (!communityConfigured || liking.value || hasLiked.value) return;
        liking.value = true;
        likeError.value = false;
        try {
            const result = await request('/api/likes', { method: 'POST', body: JSON.stringify({ visitor: visitorId }) });
            likeCount.value = result.count;
            hasLiked.value = result.liked;
        } catch { likeError.value = true; }
        finally { liking.value = false; }
    }
    async function submitComment() {
        if (!communityConfigured || submittingComment.value) return;
        const name = commentForm.name.trim(), message = commentForm.message.trim();
        if (!name || name.length > 40 || !message || message.length > 1000) {
            communityNotice.value = 'invalid';
            return;
        }
        submittingComment.value = true;
        communityNotice.value = '';
        try {
            await request('/api/comments', {
                method: 'POST', body: JSON.stringify({ name, message, website: commentForm.website })
            });
            commentForm.name = '';
            commentForm.message = '';
            communityNotice.value = 'submitted';
        } catch (error) { communityNotice.value = error.status === 429 ? 'limited' : 'failed'; }
        finally { submittingComment.value = false; }
    }
    function formatCommentDate(value) {
        return new Date(value).toLocaleDateString(lang.value === 'en' ? 'en-GB' : 'zh-CN');
    }
    onMounted(() => {
        if (communityConfigured) { loadLikes(); loadComments(); }
    });
    return {
        communityConfigured, likeCount, hasLiked, liking, communityLoading, commentsLoading,
        submittingComment, publicComments, commentsCursor, communityNotice, communityMessage,
        likeError, commentsError, commentForm, loadLikes, loadComments, addLike, submitComment, formatCommentDate
    };
};
