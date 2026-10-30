/**
 * Project Weibo's own shapes onto the conversation graph.
 *
 * ## Why this module exists separately from any API client
 *
 * Weibo's structure is *not* a forum thread. A post has comments, a comment has
 * replies, and a **repost is not a reply** — it is a new timeline entry that points
 * at the original. Folding a repost into the reply tree is how an argument gets
 * reconstructed backwards: the reposter's words become an answer to the original
 * author, when in fact they are a broadcast to a different audience.
 *
 * This file maps that structure to `ConversationGraph` with no network access, so it
 * is testable against fixtures today and usable by an adapter later. The API client
 * itself is deliberately absent: Weibo requires a registered application, developer
 * qualification and a scope grant, none of which this build can assume, and writing
 * plausible endpoint calls would be exactly the "pretend it works" failure the
 * capability matrix exists to prevent.
 *
 * ## What is stated, what is inferred, what is refused
 *
 * - `contains`: stated. Weibo tells you a comment belongs to a post.
 * - `replies_to`: stated when the reply carries a `replyToId`, otherwise **inferred
 *   from the display name** and marked as such — a name can be changed, and the
 *   graph must not later treat a guess as a fact.
 * - `reposts`: stated. The repost carries the original's id.
 * - `quotes`: stated when the payload carries a quoted id.
 * - `displayIndex`: never populated. Weibo has no floor numbers, and inventing them
 *   is what made a Weibo post described as "第 undefined 楼".
 */
const PLATFORM = 'weibo';
/** Project a Weibo user, refusing to upgrade a display name into an identity. */
function authorOf(user) {
    const uid = user.uid?.trim() ?? '';
    return {
        platform: PLATFORM,
        ...(uid === '' ? {} : { accountId: uid }),
        displayName: user.screenName,
        // Weibo's uid is platform-assigned and immutable, so a present uid is `stable`.
        // A missing one is a *name only*, and matching on it is what makes two different
        // people with the same nickname look like one person.
        idStrength: uid === '' ? 'name_only' : 'stable',
    };
}
function imagesOf(list) {
    return list ?? [];
}
/**
 * Build the graph for one Weibo post.
 *
 * Node ids are namespaced by `threadId` inside the node (the graph's identity is
 * `(threadId, id)`), so a comment id that happens to collide with the post's mid in
 * a different thread cannot alias.
 */
export function projectWeiboThread(payload) {
    const threadId = payload.post.mid;
    const nodes = [];
    const edges = [];
    const issues = [...(payload.issues ?? [])];
    const push = (node) => {
        nodes.push(node);
    };
    // --- the root -------------------------------------------------------------
    push({
        platform: PLATFORM,
        id: `post:${threadId}`,
        threadId,
        kind: 'root',
        author: authorOf(payload.post.user),
        content: payload.post.text,
        ...(payload.post.createdAt === undefined ? {} : { createdAt: payload.post.createdAt }),
        images: imagesOf(payload.post.images),
        ...(payload.post.commentsCount === undefined
            ? {}
            : { declaredReplyCount: payload.post.commentsCount }),
    });
    // --- a repost is its own node with its own edge ---------------------------
    //
    // Deliberately *not* a child of the root: a repost is broadcast to a different
    // audience. The only structural claim we make is that it reposts the original.
    const original = payload.post.retweeted;
    if (original !== undefined) {
        push({
            platform: PLATFORM,
            id: `post:${original.mid}`,
            threadId,
            kind: 'repost',
            author: authorOf(original.user),
            content: original.text,
            ...(original.createdAt === undefined ? {} : { createdAt: original.createdAt }),
            images: imagesOf(original.images),
        });
        edges.push({
            platform: PLATFORM,
            kind: 'reposts',
            from: `post:${threadId}`,
            to: `post:${original.mid}`,
            certainty: 'stated',
        });
    }
    // --- quotes ---------------------------------------------------------------
    //
    // ## A quote points at a *post*, never at a comment (v0.2.11)
    //
    // v0.2.10 wrote `to: comment:<quotedMid>` whenever the quoted id differed from the
    // thread's own mid. That is the wrong namespace: `quotedMid` is a weibo **post** id.
    // Two consequences, both bad: the edge named a comment node that does not exist, and
    // any downstream code that walked `quotes` looking for a post found nothing — while
    // the *certainty* said `stated`, so the wrong target carried full confidence.
    //
    // The quoted post usually is not in this read (we fetched one post and its comments),
    // so the edge legitimately points at a node that is absent. That is a dangling
    // reference, and it is recorded as one: the graph must not invent a node for content
    // nobody read, and it must not quietly drop the relationship either.
    const quoted = payload.post.quotedMid?.trim();
    if (quoted !== undefined && quoted !== '') {
        const targetId = `post:${quoted}`;
        edges.push({
            platform: PLATFORM,
            kind: 'quotes',
            from: `post:${threadId}`,
            to: targetId,
            certainty: 'stated',
        });
        // A self-quote (a post quoting itself) is a real payload shape and resolves inside
        // the graph; anything else is external unless a later read added it.
        const present = quoted === threadId;
        if (!present) {
            issues.push(`这条微博引用了另一条微博（mid ${quoted}），但本次只读取了这一条；` +
                '引用目标是图中不存在的外部帖子，正文未读取。不要假设它的内容。');
        }
    }
    // --- comments -------------------------------------------------------------
    const knownCommentIds = new Set(payload.comments.map((comment) => comment.id));
    for (const comment of payload.comments) {
        const nodeId = `comment:${comment.id}`;
        const author = authorOf(comment.user);
        push({
            platform: PLATFORM,
            id: nodeId,
            threadId,
            kind: 'comment',
            author,
            content: comment.text,
            ...(comment.createdAt === undefined ? {} : { createdAt: comment.createdAt }),
            images: imagesOf(comment.images),
            ...(comment.repliesCount === undefined ? {} : { declaredReplyCount: comment.repliesCount }),
        });
        // Containment is a fact: Weibo says this comment is under this post.
        edges.push({
            platform: PLATFORM,
            kind: 'contains',
            from: `post:${threadId}`,
            to: nodeId,
            certainty: 'stated',
        });
        // "Answered whom" is the interesting case.
        const replyToId = comment.replyToCommentId?.trim();
        if (replyToId !== undefined && replyToId !== '') {
            if (knownCommentIds.has(replyToId)) {
                edges.push({
                    platform: PLATFORM,
                    kind: 'replies_to',
                    from: nodeId,
                    to: `comment:${replyToId}`,
                    certainty: 'stated',
                });
            }
            else {
                // The id points at a comment outside the page we read. Record the claim but
                // say it is dangling rather than dropping it: a missing edge would make the
                // reply look like a top-level comment and change who is arguing with whom.
                issues.push(`评论 ${comment.id} 声称回复 ${replyToId}，但那条评论不在读取范围内；` +
                    '这条回复在图上暂时按顶层评论处理，争论链可能因此不完整。');
            }
        }
        else {
            const replyToName = comment.replyToScreenName?.trim();
            if (replyToName !== undefined && replyToName !== '') {
                const target = payload.comments.find((candidate) => candidate.id !== comment.id &&
                    candidate.user.screenName === replyToName &&
                    // Only when exactly one candidate matches. Two people with the same name
                    // make the guess worse than no guess, because it looks equally confident.
                    payload.comments.filter((other) => other.user.screenName === replyToName).length === 1);
                if (target !== undefined) {
                    edges.push({
                        platform: PLATFORM,
                        kind: 'replies_to',
                        from: nodeId,
                        to: `comment:${target.id}`,
                        certainty: 'inferred',
                        basis: `微博只给了被回复人的显示名「${replyToName}」，没有给评论 id；按同名唯一匹配推断`,
                    });
                }
                else {
                    issues.push(`评论 ${comment.id} 只说明了被回复人的昵称「${replyToName}」，没有 id；` +
                        '无法确定是哪一条（可能重名或不在读取范围内），因此不生成回复边。');
                }
            }
        }
    }
    const coverage = {
        sourceComplete: payload.sourceComplete,
        ...(payload.missingComments === undefined ? {} : { missingCount: payload.missingComments }),
        stopReason: payload.stopReason,
        issues,
    };
    return {
        platform: PLATFORM,
        threadId,
        nodes,
        edges,
        coverage,
    };
}
/**
 * Author ids the graph says participated, strongest first.
 *
 * Exposed because the analyzer needs "who is here" and the graph is the only place
 * that knows after projection. Name-only authors are returned separately so a caller
 * can decide to refuse rather than match on a nickname.
 */
export function weiboParticipants(graph) {
    const stable = new Set();
    const nameOnly = new Set();
    for (const node of graph.nodes) {
        const accountId = node.author.accountId?.trim();
        if (accountId !== undefined && accountId !== '')
            stable.add(accountId);
        else if (node.author.displayName !== undefined)
            nameOnly.add(node.author.displayName);
    }
    return { stable: [...stable], nameOnly: [...nameOnly] };
}
//# sourceMappingURL=conversation.js.map