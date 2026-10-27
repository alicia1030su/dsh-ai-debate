/**
 * Argument reconstruction.
 *
 * This module answers three questions with **rules, not vibes**:
 *
 * 1. Who is the owner in this thread? (stable id, falling back to the username
 *    only when the platform gives no id)
 * 2. Who is the owner actually arguing with? (reply edges and interaction
 *    counts — never "whoever spoke last")
 * 3. What is the dispute? (owner's claims, opponent's claims, open questions)
 *
 * Everything it produces is evidence-linked: every claim carries the post id it
 * came from, so the generator can quote rather than invent, and the validator
 * can check that the reply target exists.
 */
import { buildTimeline, floorOf } from './collector.js';
/**
 * Rebuild the dispute around one trigger post.
 *
 * @param collected the collected thread
 * @param owner the bound owner identity
 * @param trigger the post that summoned the AI
 * @returns the dispute, with `needsConfirmation` set when the target is unclear
 */
export function analyzeDispute(collected, owner, trigger) {
    const timeline = buildTimeline(collected);
    const target = timeline.find((entry) => entry.postId === trigger.postId);
    if (!target) {
        throw new Error(`触发回复 ${trigger.postId} 不在已采集的对话中，无法分析`);
    }
    const container = floorOf(collected, trigger.postId);
    if (!container) {
        throw new Error(`触发回复 ${trigger.postId} 不属于任何已采集楼层`);
    }
    const notes = [];
    // Identity is resolved once, up front: the platform mixes name-shaped and
    // numeric handles across surfaces, so every later comparison must use the
    // same recovery table or two functions can disagree about who is speaking.
    const nameByHandle = buildHandleDirectory(timeline);
    const keyOf = (entry) => resolveKey(entry, nameByHandle);
    const participants = indexParticipants(timeline, nameByHandle);
    const ownerKey = resolveOwnerKey(participants, owner, notes);
    const ownerParticipant = participants.get(ownerKey);
    if (!ownerParticipant) {
        throw new Error(`在帖子里没有找到主人（配置：${owner.userId ?? owner.userName ?? '未配置'}）的发言，` +
            '请确认主人 ID 或昵称是否正确，或该主人在本贴尚未发言');
    }
    const ownerStatements = timeline
        .filter((entry) => keyOf(entry) === ownerKey)
        .map((entry) => toStatement(entry, nameByHandle, keyOf));
    const floorTimeline = timeline.filter((entry) => entry.floorNumber === container.floor.floorNumber);
    const opponentPick = pickOpponent(floorTimeline, ownerKey, target, participants, notes, keyOf);
    const exchange = opponentPick.opponentKey
        ? floorTimeline
            .filter((entry) => {
            const key = keyOf(entry);
            return key === ownerKey || key === opponentPick.opponentKey;
        })
            .map((entry) => toStatement(entry, nameByHandle, keyOf))
        : [];
    const openQuestions = findOpenQuestions(floorTimeline, ownerKey, opponentPick.opponentKey, keyOf);
    return {
        floorNumber: container.floor.floorNumber,
        floorPostId: container.floor.postId,
        owner: ownerParticipant,
        opponent: opponentPick.opponentKey ? participants.get(opponentPick.opponentKey) : undefined,
        opponentEvidence: opponentPick.evidence,
        exchange,
        ownerStatements,
        openQuestions,
        needsConfirmation: opponentPick.ambiguous,
        notes,
    };
}
/**
 * True when a post's handle is a real account identity rather than an echo of
 * the display name.
 *
 * Tieba fills its `un` field with the account name *or* the numeric user id,
 * depending on which surface rendered the post — and sometimes with a name that
 * is identical to the shown name. Measured on a live thread: one person appeared
 * as `羽绫观月 / 羽绫观月` on a floor and as `羽绫观月 / 6631433126` in the
 * reply, while `贴吧包打听` appeared both ways too.
 *
 * So a handle counts as identity when it is numeric **or** when it differs from
 * the display name. A handle that merely repeats the name carries no extra
 * information, and counting it would report one person as several accounts.
 *
 * @param handle the `un` value, when present
 * @param displayName the name rendered for the post
 */
function isAccountHandle(handle, displayName) {
    if (handle === undefined || handle === '')
        return false;
    if (/^\d{4,}$/.test(handle))
        return true;
    return displayName !== undefined && handle !== displayName;
}
/**
 * Build the participant index.
 *
 * Three rules, each forced by observed platform behaviour:
 *
 * 1. **Merge by display name.** A floor gives `un` while the same person's
 *    nested reply may give a shown name, so keying on whichever handle a post
 *    carries split one human into two and made the owner look ambiguous.
 * 2. **Only numeric handles are account ids.** A name-shaped `un` is not an
 *    identity; counting it would report one person as several accounts.
 * 3. **Backfill missing names from the numeric handle.** Nine of a live thread's
 *    nested replies arrived with a user id but no name at all; the name is
 *    recoverable from another post by the same id, and doing so keeps the
 *    argument readable instead of inventing an "unknown user".
 *
 * The merge is conservative in the direction that matters: two people who share
 * a display name become one participant, which
 * {@link resolveOwnerKey} refuses for the owner rather than guessing.
 */
function indexParticipants(timeline, nameByHandle) {
    // Merge into participants, resolving nameless posts through the directory.
    const byKey = new Map();
    /** Distinct numeric account ids seen under each display name. */
    const handlesByKey = new Map();
    timeline.forEach((entry, index) => {
        if (!entry.authorName && !entry.authorId)
            return;
        const handle = isAccountHandle(entry.authorId, entry.authorName) ? entry.authorId : undefined;
        const name = resolveKey(entry, nameByHandle);
        if (handle) {
            const set = handlesByKey.get(name) ?? new Set();
            set.add(handle);
            handlesByKey.set(name, set);
        }
        const distinctHandles = handlesByKey.get(name)?.size ?? 0;
        const existing = byKey.get(name);
        if (existing) {
            byKey.set(name, {
                ...existing,
                userId: existing.userId ?? handle,
                matchKind: existing.userId ?? handle ? 'id' : 'name',
                postCount: existing.postCount + 1,
                lastPostId: entry.postId,
                lastSpokeIndex: index,
                distinctHandles,
            });
            return;
        }
        byKey.set(name, {
            key: name,
            userId: handle,
            displayName: name,
            matchKind: handle ? 'id' : 'name',
            postCount: 1,
            lastPostId: entry.postId,
            lastSpokeIndex: index,
            distinctHandles,
        });
    });
    return byKey;
}
/**
 * Build the account-handle → display-name directory for one timeline.
 *
 * The platform sometimes renders a post with a numeric user id and no name (nine
 * of a live thread's nested replies did). Another post by the same id usually
 * carries the name, so recovering it keeps the conversation readable instead of
 * showing "unknown user" for a real participant.
 */
export function buildHandleDirectory(timeline) {
    const directory = new Map();
    for (const entry of timeline) {
        if (entry.authorName && entry.authorId !== undefined) {
            directory.set(entry.authorId, entry.authorName);
        }
    }
    return directory;
}
/**
 * Resolve one entry to its participant key (the display name it belongs to).
 *
 * Exported so callers outside the analyzer can group posts consistently; passing
 * the directory from {@link buildHandleDirectory} is what keeps a nameless post
 * attributed to the right person.
 */
export function resolveKey(entry, nameByHandle) {
    if (entry.authorName)
        return entry.authorName;
    if (entry.authorId !== undefined) {
        const resolved = nameByHandle.get(entry.authorId);
        if (resolved)
            return resolved;
    }
    return entry.authorId ?? '未知';
}
/**
 * Resolve which participant the configured owner actually is.
 *
 * Matching order, and why:
 *
 * 1. A configured **user id** is matched against each participant's known
 *    handle. This is the only unspoofable handle the platform gives.
 * 2. Otherwise the configured **name** must match exactly one participant.
 *    Because the index merges by display name, one match means one human.
 * 3. A name that is missing, or that appears with several distinct account
 *    handles, is an error rather than a guess — attributing someone else's
 *    words to the owner is the most damaging failure this plugin can have.
 */
/**
 * Decide which participant is the owner.
 *
 * The critical rule: **a configured stable id is authoritative, and never degrades
 * to a nickname match.**
 *
 * Consider the failure this prevents: the owner is configured as id 99999 with
 * nickname "Alice", but the post is by uid 12345 who also calls themselves
 * "Alice". The old code tried the id, failed, then matched by name and happily
 * used the impostor's words as the owner's — the single worst outcome this plugin
 * can produce, because it argues on a stranger's behalf under the owner's name.
 *
 * So:
 * - id configured and matched → that participant, done;
 * - id configured and the platform shows ids → refuse (a different id is present);
 * - id configured but no ids at all on this platform → ambiguous, needs a human;
 * - no id configured → a nickname match is allowed, flagged in `notes`.
 */
function resolveOwnerKey(participants, owner, notes) {
    if (owner.userId) {
        for (const participant of participants.values()) {
            if (participant.userId === owner.userId)
                return participant.key;
        }
        // The id did not match. Whether a nickname fallback is even conceivable
        // depends on whether the platform exposed ids at all.
        const anyIdsExposed = [...participants.values()].some((participant) => participant.userId);
        if (anyIdsExposed) {
            const nameMatch = owner.userName ? participants.get(owner.userName) : undefined;
            const conflicting = nameMatch?.userId ? `，而帖子里同名账号的 ID 是 ${nameMatch.userId}` : '';
            throw new Error(`配置的主人用户 ID 是 ${owner.userId}，但帖子里没有这个 ID 的发言${conflicting}。` +
                '为避免把别人的话当成主人的，插件不会退回去按昵称匹配。' +
                '请核对 ownerUserId，或确认该主人是否在本帖发过言。');
        }
        // No ids anywhere: a nickname match cannot be confirmed against the configured
        // id, so this is "needs a human", not "assume it is them".
        if (owner.userName && participants.get(owner.userName)) {
            throw new Error(`配置了主人 ID ${owner.userId}，但本次读取到的发言没有暴露任何数字用户 ID，` +
                `无法确认昵称「${owner.userName}」是否就是该 ID 对应的账号。` +
                '请用 debate_analyze_reply 指定主人自己那条回复的 postId，或在配置里改为仅使用昵称。');
        }
        throw new Error(`配置的主人用户 ID ${owner.userId} 在本次对话中没有出现（发言里没有暴露 ID）。` +
            '请核对 ownerUserId，或确认该主人是否在本帖发过言。');
    }
    if (owner.userName) {
        const match = participants.get(owner.userName);
        if (match) {
            const handles = match.distinctHandles ?? 0;
            if (handles > 1) {
                throw new Error(`昵称「${owner.userName}」在帖子里出现了 ${handles} 个不同的账号，无法确定哪一个是主人。` +
                    '请为主人配置稳定的用户 ID。');
            }
            notes.push(`主人是通过昵称「${owner.userName}」匹配的，建议改为配置稳定的用户 ID`);
            return match.key;
        }
        throw new Error(`在帖子里没有找到主人（昵称 ${owner.userName}）的发言：` +
            '请确认昵称是否正确，或该主人在本贴尚未发言');
    }
    throw new Error('没有配置主人身份：请先设置主人用户 ID（或昵称）');
}
/**
 * Decide who the owner is arguing with inside one floor.
 *
 * The rule is: score candidates by *evidence of an argument*, not by position
 * in the list. A participant earns points for having been answered by the
 * owner, for answering the owner, and for interacting more than once. The
 * most-recently-active stranger therefore cannot win on recency alone — which
 * is exactly the failure mode a naive "reply to the last speaker" heuristic
 * has, and which the acceptance test for a three-person argument targets.
 */
function pickOpponent(floorTimeline, ownerKey, trigger, participants, notes, keyOf) {
    const triggerIndex = floorTimeline.findIndex((entry) => entry.postId === trigger.postId);
    const before = triggerIndex >= 0 ? floorTimeline.slice(0, triggerIndex) : floorTimeline;
    const stats = new Map();
    // Reply edges are named, not keyed: the platform renders the answered user as a
    // display name, so the edge is resolved by matching that name against the
    // participant index. Matching on handles instead would silently miss every edge
    // whose target happened to be rendered without one.
    const ownerNames = new Set(floorTimeline
        .filter((entry) => keyOf(entry) === ownerKey)
        .map((entry) => entry.authorName)
        .filter((name) => Boolean(name)));
    // The owner key itself is a display name, so it doubles as an answerable name.
    ownerNames.add(ownerKey);
    const isOwnerName = (name) => name !== undefined && ownerNames.has(name);
    before.forEach((entry, index) => {
        const key = keyOf(entry);
        if (key === ownerKey) {
            // An owner post naming someone is a direct reply edge.
            if (entry.replyToName && participants.has(entry.replyToName)) {
                const target = entry.replyToName;
                if (target !== ownerKey) {
                    const current = stats.get(target) ?? {
                        ownerRepliesTo: 0,
                        repliesToOwner: 0,
                        lastSpokeIndex: -1,
                        spoken: 0,
                    };
                    current.ownerRepliesTo += 1;
                    stats.set(target, current);
                }
            }
            return;
        }
        const current = stats.get(key) ?? {
            ownerRepliesTo: 0,
            repliesToOwner: 0,
            lastSpokeIndex: -1,
            spoken: 0,
        };
        current.spoken += 1;
        current.lastSpokeIndex = index;
        if (isOwnerName(entry.replyToName))
            current.repliesToOwner += 1;
        stats.set(key, current);
    });
    const candidates = [...stats.entries()]
        .map(([key, value]) => ({
        key,
        ...value,
        // Interaction evidence dominates; recency only breaks ties.
        score: value.ownerRepliesTo * 3 + value.repliesToOwner * 3 + Math.min(value.spoken, 3),
    }))
        .sort((a, b) => (b.score - a.score) || (b.lastSpokeIndex - a.lastSpokeIndex));
    const top = candidates[0];
    if (!top) {
        notes.push('该楼层里在主人发言之前没有其他参与者，无法确定争论对象');
        return { ambiguous: true };
    }
    const runnerUp = candidates[1];
    const ambiguous = runnerUp !== undefined && runnerUp.score === top.score;
    if (ambiguous) {
        notes.push(`有两位参与者的互动证据相同（${top.key} 与 ${runnerUp.key}），无法可靠判断主人在跟谁争论，需要确认`);
    }
    const activeOthers = candidates
        .slice(1)
        .filter((candidate) => candidate.spoken > 0)
        .map((candidate) => candidates.find((entry) => entry.key === candidate.key)?.key ?? candidate.key);
    return {
        opponentKey: top.key,
        ambiguous,
        evidence: {
            exchanges: top.ownerRepliesTo + top.repliesToOwner,
            ownerRepliesTo: top.ownerRepliesTo,
            repliesToOwner: top.repliesToOwner,
            lastSpokeIndex: top.lastSpokeIndex,
            otherActiveParticipants: activeOthers,
        },
    };
}
/**
 * Find opponent posts that ask the owner something and got no reply.
 *
 * "Asks something" is detected from interrogatives plus a question mark; this
 * is a heuristic and is labelled as such downstream. It deliberately errs
 * towards listing too few rather than inventing questions.
 *
 * A later owner post only counts as an answer if it actually says something. A
 * bare summon such as "@小号 上" is the owner handing the floor to someone else,
 * not answering, so treating it as a reply would hide the open question this
 * plugin exists to close.
 */
function findOpenQuestions(floorTimeline, ownerKey, opponentKey, keyOf, nameByHandle) {
    if (!opponentKey)
        return [];
    const out = [];
    for (let index = 0; index < floorTimeline.length; index += 1) {
        const entry = floorTimeline[index];
        if (keyOf(entry) !== opponentKey)
            continue;
        if (!looksLikeQuestion(entry.content))
            continue;
        const answeredLater = floorTimeline
            .slice(index + 1)
            .some((later) => keyOf(later) === ownerKey && isSubstantive(later.content));
        if (!answeredLater)
            out.push(toStatement(entry, nameByHandle ?? new Map(), keyOf));
    }
    return out;
}
/** True when the text reads as a question in Chinese or English. */
export function looksLikeQuestion(content) {
    if (/[?？]/.test(content))
        return true;
    return /(为什么|凭什么|怎么|如何|是不是|有没有|能不能|难道|依据|证据|哪里|哪个|谁)/.test(content);
}
/**
 * True when a post actually argues something, rather than only summoning.
 *
 * Stripping @-mentions and whitespace and then requiring a few characters is a
 * cheap, honest test: "@吵架小号 过来帮我说两句" reduces to "过来帮我说两句"
 * which still counts, while "@吵架小号 上。" reduces to "上。" and does not.
 */
export function isSubstantive(content) {
    const stripped = content
        .replace(/@\S+/g, '')
        .replace(/[\s，。,.!！?？~～、]/g, '')
        .trim();
    return stripped.length >= 6;
}
/** Convert a timeline entry to a statement. */
function toStatement(entry, nameByHandle, keyOf) {
    return {
        postId: entry.postId,
        floorNumber: entry.floorNumber,
        authorKey: keyOf(entry),
        // Keep the resolved name even when the post itself carried none: the output
        // should never show "unknown" for someone the thread does identify.
        authorName: entry.authorName ??
            (entry.authorId === undefined ? undefined : nameByHandle.get(entry.authorId)),
        content: entry.content,
        createdAt: entry.createdAt,
        replyToName: entry.replyToName,
    };
}
/**
 * Extract the owner's most load-bearing claims.
 *
 * A claim is a sentence the owner stated as fact or opinion. Interrogatives are
 * excluded, because the owner asking a question is not the owner asserting.
 */
export function extractClaims(statements, limit = 8) {
    const claims = [];
    for (const statement of statements) {
        for (const raw of statement.content.split(/[。！？!?\n]+/)) {
            const sentence = raw.trim();
            if (sentence.length < 4)
                continue;
            if (looksLikeQuestion(sentence))
                continue;
            claims.push(sentence);
            if (claims.length >= limit)
                return claims;
        }
    }
    return claims;
}
/** Summarize a floor's participants, for the UI and the compressor. */
export function describeParticipants(collected, floorNumber) {
    const timeline = buildTimeline(collected).filter((entry) => entry.floorNumber === floorNumber);
    return [...indexParticipants(timeline, buildHandleDirectory(timeline)).values()];
}
/** All nested replies under a floor, in order. */
export function nestedOf(collected, floorNumber) {
    const found = collected.floors.find((entry) => entry.floor.floorNumber === floorNumber)?.floor;
    return found ? collected.floors.find((entry) => entry.floor === found)?.nested ?? [] : [];
}
//# sourceMappingURL=analyzer.js.map