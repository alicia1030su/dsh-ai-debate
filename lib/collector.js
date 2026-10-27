/**
 * Context collection: turn a thread reference into a complete, structured
 * conversation graph.
 *
 * Design rule this module exists to enforce: **the model never reads raw HTML
 * and never sees a page it was not given**. Collection happens first, in code,
 * and everything afterwards works on typed records. That is what lets a small
 * model succeed — it receives a compact, already-correct structure instead of
 * being asked to reconstruct who replied to whom from a wall of text.
 *
 * Pagination lives here, on the *generic* adapter interface, not inside the
 * Tieba adapter. A second platform then gets correct paging, deduplication and
 * partial-result reporting for free, and cannot quietly implement "read page 1
 * and call it done".
 */
import { PlatformError, } from './types.js';
/**
 * Walk every floor page of a thread through the generic adapter interface.
 *
 * Stops on any of: an error, an empty page, a page of only already-seen floors,
 * the declared last page, or the page cap. Deduplication is by post id, so a
 * platform that repeats the last floor on every page cannot inflate the count.
 */
export async function walkFloors(adapter, ref, options = {}) {
    const maxPages = options.maxPages ?? 60;
    const seen = new Map();
    let declaredTotal;
    let totalPages;
    let pagesRead = 0;
    let page = 1;
    let failed;
    // Tracked separately from `page` because the loop can end for several reasons
    // at the same page number, and only some of them mean "nothing left to read".
    let stopped = 'exhausted';
    let truncated = false;
    while (page <= maxPages) {
        let result;
        try {
            result = await adapter.getReplies(ref, page, options.signal);
        }
        catch (error) {
            failed = error.message;
            stopped = 'error';
            break;
        }
        pagesRead += 1;
        // The platform declares the thread's full floor count and page count; keep
        // the first values reported, since later pages repeat them.
        declaredTotal ??= result.declaredTotal;
        totalPages ??= result.declaredTotalPages;
        let added = 0;
        for (const floor of result.floors) {
            if (!seen.has(floor.postId)) {
                seen.set(floor.postId, floor);
                added += 1;
            }
        }
        options.onPage?.(page, seen.size);
        if (result.floors.length === 0 || added === 0) {
            stopped = 'exhausted';
            break;
        }
        if (totalPages !== undefined && page >= totalPages) {
            stopped = 'last_page';
            break;
        }
        if (!result.hasMore) {
            stopped = 'last_page';
            break;
        }
        // The page cap is a self-imposed limit. Hitting it while the platform still
        // reports more pages means the read is short, and saying "complete" would be
        // a lie about coverage.
        if (page >= maxPages) {
            stopped = 'page_cap';
            truncated = true;
            break;
        }
        page += 1;
    }
    const floors = [...seen.values()].sort((a, b) => a.floorNumber - b.floorNumber);
    const missingCount = declaredTotal !== undefined && declaredTotal > floors.length ? declaredTotal - floors.length : undefined;
    return {
        floors,
        declaredTotal,
        totalPages,
        pagesRead,
        // Completion means every declared floor is present. Deleted floors leave
        // permanent gaps, and a page cap leaves unread pages, so both are reported as
        // incomplete rather than hidden.
        complete: failed === undefined && missingCount === undefined && !truncated && stopped !== 'page_cap',
        missingCount,
        error: failed,
        stopReason: stopped,
        truncated,
    };
}
/** Walk every page of nested replies under one floor. */
export async function walkNested(adapter, ref, floor, options = {}) {
    const maxPages = options.maxPages ?? 10;
    const seen = new Map();
    let page = 1;
    let error;
    let degraded = false;
    while (page <= maxPages) {
        let result;
        try {
            result = await adapter.getNestedReplies(ref, floor, page, options.signal);
        }
        catch (failure) {
            error = failure.message;
            break;
        }
        if (result.incomplete)
            degraded = true;
        let added = 0;
        for (const reply of result.replies) {
            if (!seen.has(reply.postId)) {
                seen.set(reply.postId, reply);
                added += 1;
            }
        }
        if (!result.hasMore || added === 0)
            break;
        page += 1;
    }
    const replies = [...seen.values()];
    const declared = floor.nestedCount;
    return {
        replies,
        // A page that declares itself incomplete (a degraded source) is never a
        // complete read, even if the counts happen to line up.
        complete: error === undefined && !degraded && (declared === undefined || replies.length >= declared),
        error,
        degraded,
    };
}
/**
 * Collect a thread: metadata, every floor page, then nested replies for the
 * floors that matter.
 *
 * Partial success is a first-class outcome. A thread whose page 5 times out
 * returns everything from pages 1–4 plus an `issue` saying so, because a model
 * asked to help with an argument is better served by "here is most of it, and
 * here is exactly what is missing" than by a hard failure.
 */
export async function collectThread(adapter, ref, options = {}) {
    const issues = [];
    options.onProgress?.({ stage: 'thread', message: '正在读取主题帖…' });
    const thread = await adapter.getThread(ref, options.signal);
    options.onProgress?.({ stage: 'floors', message: '正在读取楼层…' });
    const all = await walkFloors(adapter, ref, {
        maxPages: options.maxPages,
        signal: options.signal,
        onPage: (page, collected) => {
            options.onProgress?.({
                stage: 'floors',
                message: `已读取第 ${page} 页，累计 ${collected} 楼`,
                current: page,
            });
        },
    });
    if (all.totalPages !== undefined) {
        options.onProgress?.({
            stage: 'floors',
            message: `共 ${all.totalPages} 页，已读到 ${all.floors.length} 楼`,
            current: all.pagesRead,
            total: all.totalPages,
        });
    }
    if (all.error) {
        issues.push(`楼层读取中断：${all.error}（已收集 ${all.floors.length} 楼）`);
    }
    if (all.stopReason === 'page_cap') {
        // Say it plainly: this is the plugin's own limit, not a deleted floor.
        issues.push(`已到达分页上限（${all.pagesRead} 页），但平台还有更多页没有读：` +
            `本次只读到 ${all.floors.length} 楼，不是完整结果。` +
            '可以提高 maxFloorPages，或用更长的运行时间重试。');
    }
    if (all.missingCount !== undefined && all.missingCount > 0) {
        issues.push(`平台声明共 ${all.declaredTotal} 楼，实际可读 ${all.floors.length} 楼，` +
            `缺少 ${all.missingCount} 楼（通常是已删除或不可访问的楼层）`);
    }
    let floors = [...all.floors];
    if (options.maxFloors !== undefined && floors.length > options.maxFloors) {
        issues.push(`楼层层数超过上限 ${options.maxFloors}，只保留了前面的 ${options.maxFloors} 楼`);
        floors = floors.slice(0, options.maxFloors);
    }
    // Nested replies are the expensive part: one request per floor per page. Only
    // floors that plausibly matter are fetched, and the caller decides which.
    const wantNested = options.wantNested ?? ((floor) => (floor.nestedCount ?? 0) > 0);
    const nestedTargets = floors.filter(wantNested);
    const nestedLimit = options.nestedFloorLimit ?? nestedTargets.length;
    const withNested = [];
    let nestedDone = 0;
    let nestedIncomplete = false;
    for (const floor of floors) {
        const targetIndex = nestedTargets.indexOf(floor);
        const shouldFetch = nestedLimit > 0 && targetIndex >= 0 && targetIndex < nestedLimit;
        if (!shouldFetch) {
            // A floor whose replies were deliberately not fetched is *not* complete
            // when the platform says it has some: the caller must not read "no nested
            // data" as "no nested replies exist". This holds even when the limit is
            // zero, because the argument may well live in those unread replies.
            const declared = floor.nestedCount ?? 0;
            if (declared > 0)
                nestedIncomplete = true;
            withNested.push({ floor, nested: [], nestedComplete: declared === 0 });
            continue;
        }
        options.onProgress?.({
            stage: 'nested',
            message: `正在读取第 ${floor.floorNumber} 楼的楼中楼…`,
            current: nestedDone,
            total: Math.min(nestedTargets.length, nestedLimit),
        });
        const nested = await walkNested(adapter, ref, floor, { signal: options.signal });
        if (nested.error) {
            nestedIncomplete = true;
            issues.push(`第 ${floor.floorNumber} 楼楼中楼读取失败：${nested.error}`);
        }
        else if (!nested.complete) {
            nestedIncomplete = true;
            // Say which way it is incomplete: a degraded source read fewer replies from
            // a working page, which is a different fact from a page that failed.
            const reason = nested.degraded
                ? '楼中楼分页接口被限流，使用了帖子页内联的不完整副本'
                : '读取到的条数少于平台声明';
            issues.push(`第 ${floor.floorNumber} 楼楼中楼不完整（${reason}）：平台声明 ${floor.nestedCount ?? '?'} 条，` +
                `读取到 ${nested.replies.length} 条`);
        }
        withNested.push({ floor, nested: nested.replies, nestedComplete: nested.complete });
        nestedDone += 1;
    }
    options.onProgress?.({ stage: 'done', message: '读取完成' });
    return {
        thread,
        floors: withNested,
        complete: all.complete,
        missingCount: all.missingCount,
        stopReason: all.stopReason,
        truncated: all.truncated,
        nestedIncomplete,
        issues,
    };
}
/**
 * Locate the exact post the owner pointed at, and return its neighbourhood.
 *
 * This is the entry point the trigger path uses: a URL with `?pid=` or an
 * explicit reply id resolves here, and an id that cannot be found is an
 * explicit error rather than a fallback to "the last floor".
 */
export async function locateReply(adapter, ref, postId, signal) {
    return adapter.getReplyContext(ref, postId, signal);
}
/** Build the ordered timeline the analyzer reads. */
export function buildTimeline(collected) {
    const out = [];
    for (const entry of collected.floors) {
        out.push({
            kind: 'floor',
            postId: entry.floor.postId,
            floorNumber: entry.floor.floorNumber,
            authorId: entry.floor.authorId,
            authorName: entry.floor.authorName,
            order: 0,
            content: entry.floor.content,
            createdAt: entry.floor.createdAt,
        });
        entry.nested.forEach((reply, index) => {
            out.push({
                kind: 'nested',
                postId: reply.postId,
                floorNumber: entry.floor.floorNumber,
                authorId: reply.authorId,
                authorName: reply.authorName,
                order: index + 1,
                content: reply.content,
                createdAt: reply.createdAt,
                replyToName: reply.replyToName,
                relationUncertain: reply.relationUncertain,
            });
        });
    }
    return out;
}
/** Find an entry in a timeline by post id. */
export function findInTimeline(timeline, postId) {
    return timeline.find((entry) => entry.postId === postId);
}
/** The floor that contains a timeline entry. */
export function floorOf(collected, postId) {
    return collected.floors.find((entry) => entry.floor.postId === postId || entry.nested.some((reply) => reply.postId === postId));
}
/** Throw a normalized error when a thread could not be read at all. */
export function assertCollected(collected) {
    if (collected.floors.length === 0) {
        throw new PlatformError('没有读取到任何楼层，该帖子可能已删除或需要登录', 'not_found');
    }
}
//# sourceMappingURL=collector.js.map