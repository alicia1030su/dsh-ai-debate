/**
 * 人工导入的离线讨论（v0.2.30 §一）。
 *
 * ## 为什么这个模块只做「解析 + 投影」，不碰分析
 *
 * 任务书要求「复用 ConversationGraph 与分析器，不得另建辩论引擎」。这句话在本项目里
 * 有一个非常具体的含义：**导入的讨论必须变成 `CollectedThread`**，因为
 * `analyzeDispute` / `compressContext` / `buildBrief` / `generateReply` / `guardOutput`
 * 全部以它为输入。只要导入产出的是同一个结构，这条链上的每一道校验（证据引用必须存在、
 * 主人身份必须可解析、第三方的发言不能算进任一方）都自动生效，一行都不用重写。
 *
 * 所以在离线场景里唯一新写的东西是：**把用户粘贴的那段文本变成 `CollectedThread`**。
 * 分析、生成、安全评估、候选版本、人工确认全部是既有代码。
 *
 * ## 三件必须诚实标出来的事
 *
 * 1. **没有平台核验**。导入的内容来自用户的剪贴板，不是平台的接口。所以
 *    `authorSource` 一律留空（空 = 没有记录来源 = 下游判为 `unverified`），
 *    `completeness.sourceComplete` 一律 `false`。伪造一个来源标签，会让工作台把
 *    「我不知道是谁说的」显示成「已核验」，而那正是本项目一直在修的那类错误。
 *
 * 2. **没有真实 ID 时用 `local:` 命名空间**。用户没给 id 的帖子编号为
 *    `local:1`、`local:2`…；给了的按原样保留。两种都不会被当成平台 id 使用——
 *    离线会话的平台是 `manual`，`adapterFor(runtime, 'manual')` 会抛错，
 *    所以任何代码都不可能在真实平台上定位到这些 id。
 *
 * 3. **无法证明讨论是完整的**。粘贴的一定是片段。`declaredReplyCount` 不填，
 *    `missingCount` 不填，只在 `issues` 里说清楚「这份内容有多少条是导入的」。
 */
import { toConversationGraph } from '../conversation-bridge.js';
/**
 * 离线来源的平台标识。
 *
 * 刻意不是 `weibo`：会话的 `platform` 决定哪个适配器去读它（`adapterFor`），
 * 用 `weibo` 意味着生成阶段会去调真实 CLI——一次离线导入就变成一次真实读取。
 * 用 `manual` 让这件事在类型和运行时都做不到：注册中心里没有这个平台，
 * 取适配器会抛错，而不是悄悄联网。
 */
export const MANUAL_PLATFORM = 'manual';
/**
 * 「你手工指定它在回复原帖」的依据文案。
 *
 * 定义成常量而不是两处各写一份：修正层写它，投影层读它。两处字面量不一致时
 * 不会报错，只会让「标为原帖」这个动作静默失效——一个只有用户能发现的失败。
 */
export const MANUAL_ROOT_BASIS = '你手工指定它在回复原帖';
/** 界面上给 `manual` 用的名字。平台注册表里没有它，所以这里自带一份。 */
export const MANUAL_DISPLAY_NAME = '人工导入';
// ---------------------------------------------------------------------------
// 纯文本
// ---------------------------------------------------------------------------
/**
 * 粘贴文本的语法（v0.2.31 扩写）。
 *
 * 刻意做得宽松，因为真实用户的粘贴不会遵循任何规范——论坛复制、截图 OCR、
 * 手打转录，三种来源的格式完全不一样。规则如下：
 *
 * 1. `作者：内容`（全角或半角冒号，作者最多 40 字）开启一条发言。
 * 2. `作者 回复 某人：内容` 里的「作者」是前半段——不这样做，整串
 *    「路人乙 回复 路人甲」会变成一个作者名，而它在分析器眼里是一个从未出现过的陌生人。
 * 3. 不以「作者：」开头的非空行，接到上一条发言的正文后面（保留换行）。
 * 4. 单独一行的分隔符把**原帖**和**评论**分开。支持 `---`、`===`、`***`、
 *    `___`、`···`（以及它们带中文标注的形式，如 `--- 评论区 ---`）。
 *    分隔线之前的最后一段是原帖，之后的全是评论。没有分隔线时，第一条是原帖。
 * 5. 以 `#` 开头的行是 Markdown 标题，当标题用，不算发言。
 * 6. **楼层号**（`#3`、`3 楼`、`3L`、`[3]`）单独成行时，作为下一条发言的楼层号；
 *    写在作者行里时（`3 楼 甲：…`）从作者名里剥出来。
 * 7. **时间戳**（`2024-01-01 12:00`、`3 小时前`、`昨天 12:30`）单独成行时，
 *    作为下一条发言的时间；写在作者行里时从作者名里剥出来。
 * 8. **回复前缀**在正文开头时（`回复 @甲：…`、`@甲 你说得不对`、`>> 甲`）识别为
 *    回复关系，一律按昵称，证据强度是 `inferred`。
 *
 * ## 一条硬规则：识别不等于改写
 *
 * 上面每一条都只**提取**信息，不改动 `raw`。原始输入的每一行都留在
 * `ImportedComment.raw` 里，用户能在预览里逐条核对「解析器有没有乱动我的话」。
 * 这一条比任何规则都重要：一份被悄悄清洗过的转录，比一份诚实的原始文本更危险。
 */
const AUTHOR_LINE = /^([^：:]{1,40})[：:]\s*([\s\S]*)$/;
const REPLY_IN_AUTHOR = /^(.{1,32}?)\s+回复\s*@?\s*(.{1,32})$/;
/**
 * 分隔符。
 *
 * 五种符号 × 可选的中文标注。`--- 评论区 ---` 这种写法在手工整理过的转录里很常见，
 * 只认纯 `---` 会把它当成一条「作者叫 `--- 评论区 ---`」的发言。
 */
const SEPARATOR = /^\s*(?:-{3,}|={3,}|\*{3,}|_{3,}|[·・]{3,})\s*(?:[^\n]{0,20}(?:评论|回复|原帖|以上|以下)[^\n]{0,20})?\s*(?:-{3,}|={3,}|\*{3,}|_{3,}|[·・]{3,})?\s*$/;
const HEADING = /^\s*#{1,6}\s*(.*)$/;
/** `回复 @甲：…`。冒号可有可无。 */
const REPLY_PREFIX = /^回复\s*@?\s*([^：:\s]{1,32})\s*[：:]?\s*([\s\S]*)$/;
/** `@甲 …`（行首 @，后面有空格或直接是正文）。 */
const AT_PREFIX = /^@\s*([^：:\s]{1,32})\s+(?=[\s\S]*\S)([\s\S]*)$/;
/** `>> 甲` 或 `＞＞ 甲`。 */
const QUOTE_PREFIX = /^(?:>>|＞＞)\s*@?\s*([^：:\s]{1,32})\s*[：:]?\s*([\s\S]*)$/;
/**
 * 楼层号，单独成行时。
 *
 * `#3` / `3 楼` / `3L` / `[3]` / `3F`。刻意不接受裸数字：`2024` 一行也是数字，
 * 但它是年份，把它当楼层号会让整段解析错位。
 *
 * ## 为什么用 `(?![A-Za-z0-9])` 而不是 `\b`
 *
 * `\b` 在中文后面**不成立**：`楼` 不是 `\w`，它后面是行尾也不是 `\w`，
 * 两者之间没有「词边界」。第一版写成 `(?:楼|L|F)\b`，于是 `2 楼` 一条都认不出，
 * 每个楼层号都变成一条「匿名：2 楼」的假发言——四个样本里三个当场错。
 */
const FLOOR_ONLY = /^\s*(?:#\s*(\d{1,5})|(\d{1,5})\s*(?:楼|[LlFf])(?![A-Za-z0-9])|\[\s*(\d{1,5})\s*\])\s*$/;
/** 作者行里的楼层号前缀：`3 楼 甲：…`。 */
const FLOOR_PREFIX = /^\s*(?:#\s*(\d{1,5})|(\d{1,5})\s*(?:楼|[LlFf])(?![A-Za-z0-9]))\s*[·.、:：-]?\s+/;
/** 作者行里尾随的楼层号：`甲 3 楼：…` —— 这条不剥，容易误伤正文里的数字。 */
/**
 * 时间戳。
 *
 * 只认两种能确定是时间的：绝对日期（`2024-01-01`、`2024/1/1 12:00`、`1月1日`）
 * 与相对时间（`3 小时前`、`昨天 12:30`、`刚刚`）。裸数字不是时间。
 */
const TIMESTAMP_ONLY = /^\s*(\d{4}[-/年]\d{1,2}[-/月]\d{1,2}\s*日?(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?|\d{1,2}月\d{1,2}日(?:\s+\d{1,2}:\d{2})?|刚刚|\d{1,3}\s*(?:秒|分钟|小时|天|周|个月|年)前|(?:今天|昨天|前天|刚才)(?:\s+\d{1,2}:\d{2})?)\s*$/;
/** 作者行里包在括号里的时间：`甲（2024-01-01 12:00）：…`。 */
const TIMESTAMP_IN_AUTHOR = /\s*[（(]\s*(\d{4}[-/年]\d{1,2}[-/月]\d{1,2}\s*日?(?:\s+\d{1,2}:\d{2})?|刚刚|\d{1,3}\s*(?:秒|分钟|小时|天|周|个月前?))\s*[）)]\s*$/;
/**
 * 作者行里带括号时间的那一种：`甲（2024-01-01 12:00）：正文`。
 *
 * ## 为什么这条必须先于通用的作者行匹配
 *
 * 时间是**含冒号**的（`12:00`），而通用作者行按冒号切分，于是
 *
 * ```
 * 甲（2024-01-01 12:00）：先修
 * ```
 *
 * 被切成作者 `甲（2024-01-01 12`、正文 `00）：先修`。作者名里带半个时间，
 * 分析器就把同一份讨论里的这个人拆成了两个陌生人，而两半都不像人话。
 *
 * 先在专用规则上匹配一次，命中就按「名字 + 时间 + 正文」处理；没命中再走通用规则。
 */
const AUTHOR_WITH_TIME = /^([^：:（(]{1,40})\s*[（(]\s*([^）)]{1,32})\s*[）)]\s*[：:]\s*([\s\S]*)$/;
/**
 * 不带括号的时间：`甲 2024-01-01 12:00：先修`。
 *
 * 时间里的冒号同样会把通用规则切错。这条要求「时间紧跟在冒号之前」，
 * 所以它不会误伤「甲：我在 2024-01-01 12:00 到的」——那种情形冒号在时间**前面**。
 */
const AUTHOR_TAIL_TIME = /^(.{1,40}?)\s*(\d{4}[-/年]\d{1,2}[-/月]\d{1,2}\s*日?(?:\s+\d{1,2}:\d{2})?|刚刚|\d{1,3}\s*(?:秒|分钟|小时|天|周)前)\s*[：:]\s*([\s\S]*)$/;
/** 作者名尾部的楼层标记：`甲 2 楼` 里的 `2 楼`。只在作者段被时间/括号切开后才需要。 */
const TRAILING_FLOOR = /\s+(?:#?(\d{1,5})\s*(?:楼|[LlFf])(?![A-Za-z0-9]))\s*$/;
/**
 * 引用标记 `>> 甲` / `＞＞ 甲`。
 *
 * ## `>` 在这套语法里有两个意思，必须分开
 *
 * - 单个 `>` 是网页复制带的**引用装饰**（`> 甲：…` 是「甲说了这句话」的引文块），
 *   要剥掉；
 * - 两个 `>` 是**回复标记**（`>> 甲` 是「下面这条在回甲」），要保留成关系。
 *
 * 第一版把两者都当装饰剥掉，于是 `>> 甲` 变成一行裸文本 `甲`，
 * 被记成一条「匿名：甲」的发言——多出一个假发言人，少了一条真回复边。
 */
const QUOTE_MARK = /^\s*(?:>>|＞＞|＞\s>)\s*(.*)$/;
/** 剥掉网页复制常带的行首装饰。 */
function stripDecoration(line) {
    return line
        .replace(/^\s*(?:[>|｜]\s*)+/, '')
        .replace(/^\s*【[^】]{0,12}】\s*/, '')
        // 论坛常见的「3 楼」独立标签，前面常带一个圆点或中括号
        .replace(/^\s*[·・•]\s*/, '');
}
/** 从作者名里剥出楼层号与时间，剩下的才算名字。 */
function splitAuthorMeta(raw) {
    let rest = raw.trim();
    let floor;
    const floorMatch = rest.match(FLOOR_PREFIX);
    if (floorMatch !== null) {
        const digits = floorMatch[1] ?? floorMatch[2];
        const value = digits === undefined ? undefined : Number.parseInt(digits, 10);
        if (value !== undefined && Number.isFinite(value) && value > 0) {
            floor = value;
            rest = rest.slice(floorMatch[0].length).trim();
        }
    }
    let createdAt;
    const timeMatch = rest.match(TIMESTAMP_IN_AUTHOR);
    if (timeMatch !== null && timeMatch[1] !== undefined) {
        createdAt = timeMatch[1].trim();
        rest = rest.slice(0, rest.length - timeMatch[0].length).trim();
    }
    // `甲 2 楼`：楼层写在名字后面。只在前缀规则没命中时补一次，
    // 且只在尾部——正文里的「2 楼」不该被剥。
    if (floor === undefined) {
        const trailing = rest.match(TRAILING_FLOOR);
        if (trailing !== null && trailing[1] !== undefined) {
            const value = Number.parseInt(trailing[1], 10);
            if (Number.isFinite(value) && value > 0) {
                floor = value;
                rest = rest.slice(0, rest.length - trailing[0].length).trim();
            }
        }
    }
    return {
        author: rest === '' ? '匿名' : rest,
        ...(floor === undefined ? {} : { floor }),
        ...(createdAt === undefined ? {} : { createdAt }),
    };
}
function splitBlocks(content) {
    const blocks = [];
    const headings = [];
    let current;
    let separatorAt;
    let pendingFloor;
    let pendingTime;
    let pendingReplyTo;
    let pendingReplyBasis;
    let danglingMeta = 0;
    const lines = content.split(/\r?\n/);
    for (const [index, rawLine] of lines.entries()) {
        const lineNumber = index + 1;
        // `>> 甲` 先认出来，否则下一行的 `stripDecoration` 会把它当引用装饰剥掉。
        const quote = rawLine.match(QUOTE_MARK);
        if (quote !== null) {
            const claim = (quote[1] ?? '').trim();
            // 只有「>> 名字」这种短行才当回复标记；`>> 一长串正文` 更可能是引用整段。
            if (claim !== '' && claim.length <= 32 && !/[：:]/.test(claim)) {
                pendingReplyTo = claim;
                pendingReplyBasis = `上一行写了「>> ${claim}」，按昵称认作回复 ${claim}`;
                current = undefined;
                continue;
            }
        }
        const line = stripDecoration(rawLine);
        if (line.trim() === '') {
            // 空行结束当前发言。续行靠「紧跟其后」判断，空行之后的裸行属于下一条。
            current = undefined;
            continue;
        }
        // 标题先行：`# 标题` 里的冒号（如果有）不该让它变成一条发言。
        const heading = line.match(HEADING);
        if (heading !== null) {
            const text = (heading[1] ?? '').trim();
            if (text !== '')
                headings.push(text);
            current = undefined;
            continue;
        }
        if (SEPARATOR.test(line)) {
            separatorAt = lineNumber;
            current = undefined;
            // 分隔线两侧的楼层/时间标记不属于任何一条发言。
            if (pendingFloor !== undefined || pendingTime !== undefined)
                danglingMeta += 1;
            pendingFloor = undefined;
            pendingTime = undefined;
            continue;
        }
        /**
         * 楼层号与时间戳单独成行时，属于**下一条**发言。
         *
         * ## 为什么需要这个 pending 机制
         *
         * 论坛复制出来的格式常常是三行一组：
         *
         * ```
         * 3 楼
         * 2024-01-01 12:00
         * 甲：你说得不对
         * ```
         *
         * 没有 pending 时，`3 楼` 会被当成一条「匿名」发言，`2024-01-01 12:00`
         * 也会——于是每条真实发言前面多出两条假发言，参与者里多一个「匿名」，
         * 分析器会把这个匿名者当成一个从不正面回应的人。
         */
        const floorOnly = line.match(FLOOR_ONLY);
        if (floorOnly !== null) {
            const digits = floorOnly[1] ?? floorOnly[2] ?? floorOnly[3];
            const value = digits === undefined ? undefined : Number.parseInt(digits, 10);
            if (value !== undefined && Number.isFinite(value) && value > 0) {
                pendingFloor = value;
                current = undefined;
                continue;
            }
        }
        const timeOnly = line.match(TIMESTAMP_ONLY);
        if (timeOnly !== null) {
            pendingTime = timeOnly[1].trim();
            current = undefined;
            continue;
        }
        // `甲（2024-01-01 12:00）：正文` 先于通用作者行匹配：时间里的冒号会把它切错。
        // 不带括号的 `甲 2024-01-01 12:00：正文` 同理，但它的时间必须紧贴冒号，
        // 所以单独一条规则、排在后面——先认带括号的，避免两条规则抢同一行。
        const withTime = line.match(AUTHOR_WITH_TIME) ?? line.match(AUTHOR_TAIL_TIME);
        if (withTime !== null && !/^\s/.test(withTime[1])) {
            const candidateTime = (withTime[2] ?? '').trim();
            if (candidateTime !== '') {
                const meta = splitAuthorMeta(withTime[1].trim());
                current = {
                    author: meta.author,
                    ...(pendingFloor === undefined ? {} : { floor: pendingFloor }),
                    ...(pendingTime === undefined ? {} : { createdAt: pendingTime }),
                    ...(meta.floor === undefined ? {} : { floor: meta.floor }),
                    createdAt: candidateTime,
                    ...(pendingReplyTo === undefined
                        ? {}
                        : {
                            replyToName: pendingReplyTo,
                            ...(pendingReplyBasis === undefined ? {} : { replyBasis: pendingReplyBasis }),
                        }),
                    lines: [withTime[3] ?? ''],
                    startLine: lineNumber,
                    rawLines: [rawLine],
                };
                pendingFloor = undefined;
                pendingTime = undefined;
                pendingReplyTo = undefined;
                pendingReplyBasis = undefined;
                blocks.push(current);
                continue;
            }
        }
        const match = line.match(AUTHOR_LINE);
        // 作者行必须同时满足「有冒号」和「作者部分不含前导空格」——后者防止把
        // 「2024 年 1 月：……」这种正文误判成作者行。
        if (match !== null && !/^\s/.test(match[1]) && match[1].trim() !== '') {
            const rawAuthor = match[1].trim();
            // `A 回复 B` 拆成作者 + 被回复人。只在 B 部分不含空格且长度合理时才拆，
            // 避免把「支持 回复 反对 双方都有理」这类正常昵称切坏。
            const replyInAuthor = rawAuthor.match(REPLY_IN_AUTHOR);
            const authorPart = replyInAuthor === null ? rawAuthor : replyInAuthor[1].trim();
            const target = replyInAuthor === null ? undefined : replyInAuthor[2].trim();
            // `3 楼 甲` / `甲（2024-01-01）` 里的元信息从作者名里剥出来。
            const meta = splitAuthorMeta(authorPart);
            const author = meta.author;
            // 作者行没写回复对象时，才用上一行 `>> 甲` 留下的那个。
            const effectiveReply = target ?? pendingReplyTo;
            const effectiveBasis = target === undefined || target === ''
                ? pendingReplyBasis
                : `作者行写了「回复 ${target}」`;
            current = {
                author: author === '' ? '匿名' : author,
                ...(effectiveReply === undefined || effectiveReply === ''
                    ? {}
                    : {
                        replyToName: effectiveReply,
                        ...(effectiveBasis === undefined ? {} : { replyBasis: effectiveBasis }),
                    }),
                ...(pendingFloor === undefined ? {} : { floor: pendingFloor }),
                ...(pendingTime === undefined ? {} : { createdAt: pendingTime }),
                ...(meta.floor === undefined ? {} : { floor: meta.floor }),
                ...(meta.createdAt === undefined ? {} : { createdAt: meta.createdAt }),
                lines: [match[2] ?? ''],
                startLine: lineNumber,
                rawLines: [rawLine],
            };
            pendingFloor = undefined;
            pendingTime = undefined;
            pendingReplyTo = undefined;
            pendingReplyBasis = undefined;
            blocks.push(current);
            continue;
        }
        if (current !== undefined) {
            current.lines.push(line);
            current.rawLines.push(rawLine);
            continue;
        }
        // 没有作者行开头的裸文本：当作「匿名」的一条，而不是丢掉。
        current = {
            author: '匿名',
            ...(pendingReplyTo === undefined
                ? {}
                : {
                    replyToName: pendingReplyTo,
                    ...(pendingReplyBasis === undefined ? {} : { replyBasis: pendingReplyBasis }),
                }),
            lines: [line],
            startLine: lineNumber,
            rawLines: [rawLine],
        };
        pendingReplyTo = undefined;
        pendingReplyBasis = undefined;
        blocks.push(current);
    }
    if (pendingFloor !== undefined || pendingTime !== undefined)
        danglingMeta += 1;
    return {
        blocks,
        headings,
        ...(separatorAt === undefined ? {} : { separatorAt }),
        danglingMeta,
    };
}
/**
 * 解析粘贴文本。
 *
 * 分隔线之前的块是原帖候选，之后的都是评论。没有分隔线时第一块是原帖。
 * 都不成立（没有任何块）时返回空结果，并说明原因——「读不到」和「没有内容」
 * 必须是两种不同的回答。
 */
export function parseText(content) {
    const issues = [];
    const trimmed = content.trim();
    if (trimmed === '') {
        return {
            issues: [{ severity: 'error', code: 'empty', message: '内容是空的：请粘贴讨论正文。' }],
        };
    }
    const { blocks, headings, separatorAt, danglingMeta } = splitBlocks(content);
    if (blocks.length === 0) {
        return {
            issues: [
                {
                    severity: 'error',
                    code: 'no_blocks',
                    message: '没有从这段内容里识别出任何发言。每一条请写成「作者：内容」。',
                },
            ],
        };
    }
    /**
     * 谁是原帖。
     *
     * 分隔线的语义是「分割原帖与评论」，所以**分隔线之前的最后一段**是原帖，
     * 之后的全是评论。这与用户直觉一致：先写原帖，划一条线，再写下面的评论。
     *
     * 没有分隔线时第一条是原帖——这是另一种直觉（「从上往下读，先看到的就是原帖」），
     * 而且两种规则必须分开写：用「前者的最后一段」去套没有分隔线的情形，
     * 会把最后一条评论当成原帖（第一次实现就是这么错的）。
     */
    const beforeSeparator = separatorAt === undefined ? [] : blocks.filter((block) => block.startLine < separatorAt);
    const root = separatorAt === undefined
        ? blocks[0]
        : (beforeSeparator[beforeSeparator.length - 1] ?? blocks[0]);
    if (root === undefined) {
        return {
            issues: [
                {
                    severity: 'error',
                    code: 'root_missing',
                    message: '这段内容里只有分隔线，没有可识别的发言。',
                },
            ],
        };
    }
    const rootText = root.lines.join('\n').trim();
    if (rootText === '') {
        issues.push({
            severity: 'warning',
            code: 'root_empty',
            message: `原帖「${root.author}」的正文是空的，导入后会影响分析。`,
        });
    }
    /**
     * 评论：除原帖之外的每一条，按原文顺序。
     *
     * 回复关系的三种写法按**证据强度**排序处理，后面的不覆盖前面的：
     *
     * 1. 正文开头的 `> 甲` / `@甲` / `回复 @甲` —— 最明确，用户就是照着论坛界面写的；
     * 2. 作者行里的 `甲 回复 乙：` —— 次之，但有的论坛把「回复」写在名字后面；
     * 3. 正文里的**行内**「回复 @甲」（不在开头）—— 最弱，那句话可能只是引述。
     *
     * 三条路径的结果都是 `replyToKind: 'name'`，即 `inferred`。没有任何一条能
     * 升级成 `stated`：`stated` 需要平台签发的被回复者 id，而粘贴的文本里没有。
     */
    const commentBlocks = blocks.filter((block) => block !== root);
    const comments = commentBlocks.map((block, index) => {
        let text = block.lines.join('\n').trim();
        let replyTo = block.replyToName;
        let replyBasis = block.replyBasis;
        // 正文开头的引用/艾特优先。先试最具体的三个前缀，取第一个命中的。
        const prefixHit = text.match(REPLY_PREFIX) ?? text.match(AT_PREFIX) ?? text.match(QUOTE_PREFIX);
        if (prefixHit !== null) {
            const claim = prefixHit[1].trim();
            // `@甲` 这条要排除掉「@ 后面是一整句」的情况：昵称最多 32 字，且不含空格。
            if (claim !== '' && claim.length <= 32) {
                replyTo = claim;
                replyBasis = `正文开头写成「${text.slice(0, Math.min(12, text.length))}…」，按昵称认作回复 ${claim}`;
                text = (prefixHit[2] ?? '').trim();
            }
        }
        return {
            id: `local:${index + 1}`,
            author: block.author,
            text,
            ...(block.createdAt === undefined ? {} : { createdAt: block.createdAt }),
            ...(block.floor === undefined ? {} : { floor: block.floor }),
            raw: block.rawLines.join('\n'),
            rawLine: block.startLine,
            ...(replyTo === undefined
                ? {}
                : {
                    replyTo,
                    replyToKind: 'name',
                    ...(replyBasis === undefined ? {} : { replyBasis }),
                }),
        };
    });
    // 分隔线之前的非原帖内容：用户可能把说明、时间戳之类写在了前面。
    // 信息级提示，不猜它们是什么。
    const skippedBefore = beforeSeparator.slice(0, -1);
    if (skippedBefore.length > 0) {
        issues.push({
            severity: 'info',
            code: 'before_separator',
            message: `分隔线之前原帖上方还有 ${skippedBefore.length} 段内容，已忽略。` +
                '它们是说明文字还是别的发言，从文本本身判断不了。',
        });
    }
    // 单独成行的楼层号/时间戳后面没跟发言：说了，不静默丢。
    if (danglingMeta > 0) {
        issues.push({
            severity: 'info',
            code: 'dangling_meta',
            message: `有 ${danglingMeta} 处楼层号或时间标记后面没有跟任何发言，已忽略。` +
                '如果那些标记本身有意义，请把它们写进对应发言的同一行。',
        });
    }
    const rootFloor = root.floor;
    const rootCreatedAt = root.createdAt;
    return {
        discussion: {
            platform: MANUAL_PLATFORM,
            source: 'text',
            title: headings[0] ?? deriveTitle(rootText, root.author),
            root: {
                author: root.author,
                text: rootText,
                ...(rootCreatedAt === undefined ? {} : { createdAt: rootCreatedAt }),
            },
            comments,
            // 原帖的楼层号与独占行原文：预览要能显示「第 1 楼」并让人核对。
            ...(rootFloor === undefined ? {} : { rootFloor }),
            rootRaw: root.rawLines.join('\n'),
        },
        issues,
    };
}
// ---------------------------------------------------------------------------
// 结构化 JSON
// ---------------------------------------------------------------------------
/** JSON 只接受对象或数组；其余一律拒绝并说明期望的形状。 */
function asRecord(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        return undefined;
    return value;
}
function textOf(value) {
    if (typeof value === 'string')
        return value;
    if (typeof value === 'number' && Number.isFinite(value))
        return String(value);
    return undefined;
}
/**
 * 解析结构化 JSON。
 *
 * 接受两种形状，都是「作者的 id 与昵称分开」的：
 *
 * ```json
 * {
 *   "title": "……", "url": "……",
 *   "root":  { "id": "…", "author": "…", "authorId": "…", "text": "…" },
 *   "comments": [
 *     { "id": "…", "author": "…", "text": "…", "replyTo": "…", "replyToKind": "id" }
 *   ]
 * }
 * ```
 *
 * 以及顶层是数组的简写（第一条是原帖）：
 *
 * ```json
 * [ { "author": "…", "text": "…" }, { "author": "…", "text": "…" } ]
 * ```
 *
 * ## 为什么未知字段只警告不拒绝
 *
 * 用户可能从别处导出一份带 `likes`、`reposts` 的 JSON。那些字段对分析没用，但
 * 也不影响正确性。拒绝整份文件只会让用户去删字段，而删字段不会让导入更准确。
 * 真正必须拒绝的是**结构性错误**：没有正文、没有作者、comments 不是数组。
 */
export function parseJson(content) {
    const issues = [];
    let raw;
    try {
        raw = JSON.parse(content);
    }
    catch (error) {
        return {
            issues: [
                {
                    severity: 'error',
                    code: 'json_invalid',
                    message: `这份内容不是合法 JSON：${error.message}。如果要导入纯文本，请把格式选成「文本」。`,
                },
            ],
        };
    }
    const asArray = Array.isArray(raw) ? raw : undefined;
    const record = asArray === undefined ? asRecord(raw) : undefined;
    if (asArray === undefined && record === undefined) {
        return {
            issues: [
                {
                    severity: 'error',
                    code: 'json_shape',
                    message: 'JSON 的顶层必须是对象或数组。对象用 { root, comments }，数组第一条当原帖。',
                },
            ],
        };
    }
    const rootRecord = asArray === undefined ? asRecord(record.root) : asRecord(asArray[0]);
    const commentsRaw = asArray === undefined ? record.comments : asArray.slice(1);
    if (rootRecord === undefined) {
        return {
            issues: [
                {
                    severity: 'error',
                    code: 'json_root',
                    message: asArray === undefined
                        ? 'JSON 里缺少 root 对象（{ root: { author, text } }）。'
                        : 'JSON 数组是空的：第一条应该是原帖。',
                },
            ],
        };
    }
    const rootAuthor = textOf(rootRecord.author) ?? textOf(rootRecord.authorName) ?? '';
    const rootText = textOf(rootRecord.text) ?? textOf(rootRecord.content) ?? '';
    if (rootText.trim() === '') {
        issues.push({
            severity: 'warning',
            code: 'json_root_text',
            message: '原帖的 text 是空的，导入后会影响分析。',
        });
    }
    if (commentsRaw !== undefined && !Array.isArray(commentsRaw)) {
        return {
            issues: [
                {
                    severity: 'error',
                    code: 'json_comments',
                    message: 'comments 必须是数组。',
                },
            ],
        };
    }
    const list = Array.isArray(commentsRaw) ? commentsRaw : [];
    const comments = [];
    const declaredIds = new Set();
    for (const [index, entry] of list.entries()) {
        const item = asRecord(entry);
        if (item === undefined) {
            issues.push({
                severity: 'warning',
                code: 'json_comment_shape',
                message: `第 ${index + 1} 条评论不是对象，已跳过。`,
            });
            continue;
        }
        const text = textOf(item.text) ?? textOf(item.content) ?? '';
        if (text.trim() === '') {
            issues.push({
                severity: 'warning',
                code: 'json_comment_text',
                message: `第 ${index + 1} 条评论没有正文（text 为空），已跳过。`,
            });
            continue;
        }
        const given = textOf(item.id);
        const id = given !== undefined && given !== '' ? given : `local:${index + 1}`;
        if (declaredIds.has(id)) {
            // 重复 id 会让图上出现两个同 id 节点，下游按 id 寻址时只会看到先出现的那个。
            issues.push({
                severity: 'warning',
                code: 'json_duplicate_id',
                message: `评论 id「${id}」重复出现，第二条起改用 local: 编号，避免图上出现同名节点。`,
            });
        }
        const finalId = declaredIds.has(id) ? `local:dup${index + 1}` : id;
        declaredIds.add(finalId);
        const replyTo = textOf(item.replyTo) ?? textOf(item.replyToId) ?? textOf(item.replyToName);
        const replyToAuthor = textOf(item.replyToAuthor) ?? textOf(item.replyToName);
        const kind = item.replyToKind === 'name' ? 'name' : item.replyToKind === 'id' ? 'id' : replyTo === undefined ? undefined : 'id';
        comments.push({
            id: finalId,
            author: textOf(item.author) ?? textOf(item.authorName) ?? '匿名',
            ...(textOf(item.authorId) === undefined ? {} : { authorId: textOf(item.authorId) }),
            text,
            ...(textOf(item.createdAt) === undefined ? {} : { createdAt: textOf(item.createdAt) }),
            ...(replyTo === undefined
                ? replyToAuthor === undefined
                    ? {}
                    : { replyTo: replyToAuthor, replyToKind: 'name' }
                : { replyTo, ...(kind === undefined ? {} : { replyToKind: kind }) }),
        });
    }
    if (comments.length === 0 && list.length > 0) {
        issues.push({
            severity: 'warning',
            code: 'json_no_comments',
            message: '所有评论都缺少正文，导入的只有原帖。',
        });
    }
    return {
        discussion: {
            platform: MANUAL_PLATFORM,
            source: 'json',
            title: textOf(record?.title) ?? deriveTitle(rootText, rootAuthor),
            ...(textOf(record?.url) === undefined ? {} : { url: textOf(record.url) }),
            root: {
                ...(textOf(rootRecord.id) === undefined ? {} : { id: textOf(rootRecord.id) }),
                author: rootAuthor === '' ? '匿名' : rootAuthor,
                ...(textOf(rootRecord.authorId) === undefined ? {} : { authorId: textOf(rootRecord.authorId) }),
                text: rootText,
                ...(textOf(rootRecord.createdAt) === undefined ? {} : { createdAt: textOf(rootRecord.createdAt) }),
            },
            comments,
        },
        issues,
    };
}
/** 标题从正文首句推，最多 40 字。推不出来时用作者名。 */
export function deriveTitle(text, author) {
    const firstLine = text.split(/\r?\n/).find((line) => line.trim() !== '')?.trim() ?? '';
    if (firstLine === '')
        return `${author} 的发言`;
    return firstLine.length <= 40 ? firstLine : `${firstLine.slice(0, 40)}…`;
}
/** 按输入形式分派。`file` 由调用方读好内容后，按扩展名决定按哪种解析。 */
export function parseImport(request) {
    /**
     * ## 二进制内容先拦一次，不要让它变成一条「匿名发言」
     *
     * 用户点「选择文件」时选错是常事：一份 PDF、一张截图、一个 .docx。这些内容
     * 读进来是一串带控制字符的乱码，而 `parseText` 会尽职地把它当成正文——于是
     * 预览上出现一条作者为「匿名」、正文是 `%PDF-1.4…` 的发言，下一步的分析
     * 对着这段乱码跑，最后说「没有找到可回复的对象」。
     *
     * 用户看到的是一条关于讨论内容的错误，而他真正做错的是选错了文件。所以在这里
     * 就说明白：这个文件不是文本。判据只取两个**确定**的信号（NUL 字节、PDF 魔数），
     * 不猜别的编码——猜错会把一份正常的 GBK 文本判成二进制。
     */
    const binary = binaryReasonOf(request.content);
    if (binary !== undefined) {
        return {
            issues: [
                {
                    severity: 'error',
                    code: 'binary_content',
                    message: `${binary}这份内容不是纯文本，粘贴进来只会变成乱码。` +
                        '请从原页面复制文字，或先把文件另存为 .txt 再导入。',
                },
            ],
        };
    }
    const looksJson = request.kind === 'json' ||
        (request.kind === 'file' && /\.json$/i.test(request.fileName ?? '')) ||
        (request.kind === 'text' && /^\s*[[{]/.test(request.content));
    const result = looksJson ? parseJson(request.content) : parseText(request.content);
    if (result.discussion === undefined)
        return result;
    // 表单上的标题/链接优先于正文推断：用户明确填了，就不该被首行覆盖。
    const title = request.title?.trim();
    const url = request.url?.trim();
    const discussion = {
        ...result.discussion,
        source: request.kind === 'file' ? 'file' : result.discussion.source,
        ...(title === undefined || title === '' ? {} : { title }),
        ...(url === undefined || url === '' ? {} : { url }),
    };
    return { discussion, issues: result.issues };
}
/**
 * 内容像不像二进制。返回一句能读懂的原因，或 `undefined`（是文本）。
 *
 * 只看两个信号，都不猜编码：
 * - NUL 字节：任何纯文本编码都不会产生 `\u0000`，而几乎所有二进制格式都有。
 * - PDF 魔数：它是最常见的一种「选错文件」，而且开头就是 ASCII，能通过 NUL 检查。
 */
function binaryReasonOf(content) {
    // PDF 魔数放在 NUL 之前：PDF 里通常也有 NUL，先判魔数才能说出「这是一份 PDF」
    // 而不是笼统的「含有二进制数据」。用户拿到后者仍然不知道自己做错了什么。
    if (/^\s*%PDF-\d/.test(content))
        return '这是一份 PDF。';
    if (content.includes('\u0000'))
        return '这个文件里含有二进制数据（NUL 字节）。';
    const sample = content.slice(0, 4096);
    if (sample !== '') {
        // 控制字符（除常见的换行/制表）占比过高：不是给人读的文本。
        let control = 0;
        for (const char of sample) {
            const code = char.codePointAt(0) ?? 0;
            if (code < 0x20 && char !== '\n' && char !== '\r' && char !== '\t')
                control += 1;
        }
        if (control / sample.length > 0.02)
            return '这段内容里有大量控制字符。';
    }
    return undefined;
}
// ---------------------------------------------------------------------------
// 投影：导入的讨论 → CollectedThread → ConversationGraph
// ---------------------------------------------------------------------------
/**
 * 把导入的讨论投影成 `CollectedThread`。
 *
 * ## 两处刻意的「不填」
 *
 * - `authorSource` 不填。填了就等于声称这份数据来自某个平台界面，而它来自剪贴板。
 *   下游 `identityOf` / `resolveOwnerKey` 正是靠这个字段判 `verified` 的，
 *   填上会把「不知道是谁」变成「已核验」。
 * - `declaredReplyCount` / `missingCount` 不填。粘贴一定不完整，但我们不知道
 *   缺多少——编一个数字比不写更糟。
 *
 * 关系上：回复某条评论的，挂到那条评论所在的那一层下面；找不到目标的（回复了
 * 一个不在本次导入里的 id）单独成层，并在 `issues` 里点名。静默丢弃会让争论链
 * 看起来比实际更短。
 */
export function toCollectedThread(discussion) {
    const issues = [];
    const threadId = `local:thread-${stableSlug(discussion.title)}`;
    const thread = {
        platform: MANUAL_PLATFORM,
        // 人工导入没有「吧」。空字符串是诚实的表示：界面上会退回显示平台名。
        forum: { platform: MANUAL_PLATFORM, name: '' },
        id: threadId,
        title: discussion.title,
        content: discussion.root.text,
        // 原帖是这个讨论的根，评论挂在它下面——和微博一样的形状。
        bodyNode: 'standalone',
        ...(discussion.root.authorId === undefined ? {} : { authorId: discussion.root.authorId }),
        authorName: discussion.root.author,
        ...(discussion.root.createdAt === undefined ? {} : { createdAt: discussion.root.createdAt }),
        url: discussion.url ?? '',
        images: [],
    };
    // 每条评论先按 id 建索引，才能把「回复某条」解析成父子关系。
    const byId = new Map();
    for (const comment of discussion.comments)
        byId.set(comment.id, comment);
    const resolutionOf = (comment) => {
        const claim = comment.replyTo?.trim() ?? '';
        if (claim === '')
            return { kind: 'none' };
        if (claim === discussion.root.id)
            return { kind: 'root' };
        /**
         * ## 用户把某一条提升成原帖之后，「回复原帖」要认新作者
         *
         * 修正层会把「在回原帖」写成原帖作者名（见 `corrections.ts` 的
         * `rootAuthorMarker`）。如果这里只认 `root.id`，那个标记会掉进按昵称的
         * 分支——多数情况下也能命中（`rootAuthorMatches`），但当评论区有人同名时
         * 就会判歧义，而用户明明已经用「标为原帖」把这件事定下来了。
         *
         * 所以先看一个明确的信号：这条发言的 `replyBasis` 写着「你手工指定它在回复
         * 原帖」。它不是靠昵称猜的，直接归 `root`。
         */
        if (comment.replyBasis === MANUAL_ROOT_BASIS)
            return { kind: 'root' };
        // 先按 id 找。id 是用户写的引用，不需要唯一性判断。
        const byIdentifier = byId.get(claim);
        if (byIdentifier !== undefined && byIdentifier.id !== comment.id) {
            return { kind: 'comment', comment: byIdentifier };
        }
        if (comment.replyToKind !== 'name') {
            return { kind: 'unresolved', reason: 'not_found', claim };
        }
        // 只有昵称：必须唯一，否则指哪一条是猜的。
        const matches = discussion.comments.filter((candidate) => candidate.id !== comment.id && candidate.author === claim);
        /**
         * 「回复 楼主」——最常见的一种回复，原帖作者不在 `comments` 里。
         *
         * ## 这曾经被报成「那条评论不在这次导入里」
         *
         * `byId` 只索引了评论，原帖不在其中，于是按昵称找时 `matches` 是空的，
         * 落到 `unresolved: not_found`，并在 `issues` 里写「那条评论不在这次导入里
         * （local:1 → 楼主）。争论链在这里断了」。
         *
         * 那句话是错的：原帖就在这份内容的第一段。用户因此会以为自己的粘贴漏了
         * 东西，而实际上插件只是没把原帖作者算进候选人。一个 200 层的深链测试里
         * 第一层就撞上了它——这也说明它足够常见。
         */
        const rootAuthorMatches = discussion.root.author.trim() === claim;
        if (rootAuthorMatches) {
            /**
             * ## 原帖作者与某位评论者同名时，两边都可能
             *
             * 「回复 楼主」到底是回原帖、还是回三楼那位也自称「楼主」的人？
             * 昵称本身分不出来，唯一能定的事是「它指向的是一种叫这个名字的东西」。
             *
             * 这里判歧义而**不是**挑那条评论：挑错的后果是分析器把一段话说成
             * 别人的立场，而这类错误在后面的每一步都不会再被发现。
             * 只有评论里没人叫这个名字（`matches` 为空）时才能安全地归到原帖。
             */
            if (matches.length > 0) {
                return { kind: 'unresolved', reason: 'ambiguous', claim };
            }
            return { kind: 'root' };
        }
        if (matches.length === 1)
            return { kind: 'comment', comment: matches[0] };
        return { kind: 'unresolved', reason: matches.length === 0 ? 'not_found' : 'ambiguous', claim };
    };
    /** 一条评论是不是自己成层（没有可挂的父评论）。 */
    const isFloor = (comment) => {
        const resolution = resolutionOf(comment);
        return resolution.kind !== 'comment';
    };
    const nestedByFloor = new Map();
    const unresolvable = [];
    /**
     * 回复了某条评论的，挂到**目标所在的那一层**下面。
     *
     * 目标是顶层评论时直接挂它；目标是一条嵌套回复时，挂到那条回复所属的层，
     * 并把 `replyToPostId` 指向真正的目标。这保住了「谁在回谁」，也正是 Tieba
     * 两层的同一套处理方式。
     *
     * 先算好分组再建 `floors`，避免回头去改已经构造出来的只读对象：
     * 那种写法在运行时能通过，但会让「这一层的 nested 是什么」取决于循环顺序。
     */
    const floorOwnerOf = (comment) => {
        let cursor = resolutionOf(comment);
        const seen = new Set();
        while (cursor.kind === 'comment') {
            if (seen.has(cursor.comment.id))
                return undefined;
            seen.add(cursor.comment.id);
            if (isFloor(cursor.comment))
                return cursor.comment.id;
            cursor = resolutionOf(cursor.comment);
        }
        return undefined;
    };
    for (const comment of discussion.comments) {
        const resolution = resolutionOf(comment);
        if (resolution.kind === 'none' || resolution.kind === 'root')
            continue;
        if (resolution.kind === 'unresolved') {
            unresolvable.push({
                id: comment.id,
                claim: resolution.claim,
                ambiguous: resolution.reason === 'ambiguous',
            });
            continue;
        }
        const ownerId = floorOwnerOf(comment);
        if (ownerId === undefined) {
            // 目标链本身有环或断在某个无法解析的节点上。与「找不到」同样处理：
            // 自己成层，并记下来。
            unresolvable.push({ id: comment.id, claim: resolution.comment.id, ambiguous: false });
            continue;
        }
        const targetId = resolution.comment.id;
        /**
         * ## 「用户说这条关系确认不了」压过 id
         *
         * 结构化 JSON 里给了 `replyTo: 'c1'` 时关系是 `stated`；但用户可以在预览里
         * 把它标成「不确定」。两者冲突时取**更弱**的那个：`stated` 的意思是
         * 「这条关系不需要怀疑」，而用户刚刚明确怀疑了它。
         *
         * 反过来（把 `inferred` 升级成 `stated`）永远不做，见 `corrections.ts` 的说明。
         */
        const unconfirmed = comment.replyUnconfirmed === true;
        const stated = comment.replyToKind === 'id' && !unconfirmed;
        const nested = {
            platform: MANUAL_PLATFORM,
            postId: comment.id,
            parentPostId: ownerId,
            // 只有「按 id 解析到」且未被标为不确定时才写 `replyToPostId`；昵称解析来的
            // 关系写 `replyToName` 并标 `relationUncertain`——它建立在一个可能重名、
            // 也可能被改掉的昵称上。下游据此决定能不能把「对方说过这句话」当成事实。
            ...(stated ? { replyToPostId: targetId } : {}),
            authorName: comment.author,
            ...(comment.authorId === undefined ? {} : { authorId: comment.authorId }),
            ...(comment.replyTo !== undefined ? { replyToName: comment.replyTo } : {}),
            /**
             * 依据随边一起带上（v0.2.31）。
             *
             * 图的桥接层原来对每条 `replies_to` 边一律写「平台返回了被回复的 post id」。
             * 人工导入没有平台参与，这句话是假的——而这条边会一路走进图、走进转录、
             * 走进模型的上下文，始终带着一个它没有的权威。
             *
             * 这里把解析层知道的依据原样传下去：按 id 指定、按你手工指定、按昵称认。
             */
            ...(comment.replyBasis === undefined ? {} : { replyBasis: comment.replyBasis }),
            content: comment.text,
            ...(comment.createdAt === undefined ? {} : { createdAt: comment.createdAt }),
            ...(stated ? {} : { relationUncertain: true }),
        };
        const bucket = nestedByFloor.get(ownerId) ?? [];
        bucket.push(nested);
        nestedByFloor.set(ownerId, bucket);
    }
    const floors = [];
    for (const comment of discussion.comments) {
        if (!isFloor(comment))
            continue;
        const floor = {
            platform: MANUAL_PLATFORM,
            postId: comment.id,
            authorName: comment.author,
            ...(comment.authorId === undefined ? {} : { authorId: comment.authorId }),
            content: comment.text,
            ...(comment.createdAt === undefined ? {} : { createdAt: comment.createdAt }),
            images: [],
        };
        const nested = nestedByFloor.get(comment.id) ?? [];
        floors.push({ floor, nested, nestedComplete: true });
    }
    // ## 未解析的回复关系必须说出来
    //
    // 这是「静默丢失」最容易发生的地方：一条说「回复张三」的发言，如果解析不到张三，
    // 最省事的做法是当成普通一层。用户看到的是完整的两层结构，实际上争论链断了。
    if (unresolvable.length > 0) {
        const ambiguous = unresolvable.filter((entry) => entry.ambiguous);
        const missing = unresolvable.filter((entry) => !entry.ambiguous);
        if (missing.length > 0) {
            issues.push(`有 ${missing.length} 条发言说自己在回复某条评论，但那条评论不在这次导入里` +
                `（${missing
                    .slice(0, 5)
                    .map((entry) => `${entry.id} → ${entry.claim}`)
                    .join('、')}${missing.length > 5 ? ' 等' : ''}）。` +
                '它们被单独列为一层，争论链在这里断了。');
        }
        if (ambiguous.length > 0) {
            const names = [...new Set(ambiguous.map((entry) => entry.claim))];
            issues.push(`有 ${ambiguous.length} 条发言只写了「回复 ${names.join('、')}」，` +
                '而这个名字在导入内容里对应不止一个人——无法确定在回谁，因此没有生成回复关系。' +
                '如果要用 id 精确指定，请改用结构化 JSON 并给每条填 id。');
        }
    }
    // ## 同名不同人：说清我们分不开
    //
    // 导入内容里没有账号 id，所以两条都署名「甲」的发言会被分析器当成同一个人
    // （这是 `indexParticipants` 的既定规则：没有账号标识时，昵称就是键）。
    // 那不一定错——可能真的是同一个人发言两次——但用户必须知道这个假设。
    //
    // 不说的话，一份「两个不同的人都叫小王」的转录会显示出一个人说了很多话，
    // 而分析出的立场是两个人的混合。
    const nameCounts = new Map();
    for (const comment of discussion.comments) {
        nameCounts.set(comment.author, (nameCounts.get(comment.author) ?? 0) + 1);
    }
    const duplicated = [...nameCounts.entries()].filter(([, count]) => count > 1);
    if (duplicated.length > 0) {
        issues.push(`有 ${duplicated.length} 个名字出现了不止一次（${duplicated
            .slice(0, 5)
            .map(([name, count]) => `「${name}」${count} 次`)
            .join('、')}${duplicated.length > 5 ? ' 等' : ''}）。` +
            '导入内容里没有账号 id，所以同名发言会被当成同一个人。' +
            '如果确实是不同的人，请改用结构化 JSON 并给每条填不同的 id。');
    }
    return {
        thread,
        floors,
        // 导入的内容永远不是「平台证明过的完整」。说 true 会让缺省提示全部消失。
        complete: false,
        completeness: {
            sourceComplete: false,
            // 「读到的都留下了」这一条对导入是成立的：没有分页，没有上限截断。
            retainedComplete: true,
            // 争论链是否完整：只有当所有「我在回复某条」都能解析时才算。
            analysisComplete: unresolvable.length === 0,
            nestedComplete: true,
            reasons: ['人工导入：内容来自剪贴板，无法证明与平台上的讨论一致或完整。'],
        },
        issues,
        stopReason: 'confirmed_end',
    };
}
/** 导入的讨论 → 平台中立的图。复用既有的桥，不另写一套。 */
export function toGraph(collected) {
    return toConversationGraph(collected);
}
/**
 * 从标题推导一个稳定的线程 id 片段。
 *
 * 稳定性是必要的：同一个标题重复导入应该落到同一个 `local:thread-…`，
 * 否则去重记录（按 threadId + triggerPostId 建键）会认为每次都是新讨论。
 */
export function stableSlug(seed) {
    let hash = 0;
    for (const char of seed) {
        hash = (hash * 31 + char.codePointAt(0)) >>> 0;
    }
    return hash.toString(36);
}
export function statsOf(discussion, collected) {
    const names = new Set();
    names.add(discussion.root.author);
    for (const comment of discussion.comments)
        names.add(comment.author);
    const nested = collected === undefined ? 0 : collected.floors.reduce((sum, entry) => sum + entry.nested.length, 0);
    return {
        comments: discussion.comments.length,
        floors: collected === undefined ? 0 : collected.floors.length,
        nested,
        participants: [...names],
        orphans: collected === undefined ? 0 : collected.floors.filter((entry) => entry.nested.length === 0).length,
    };
}
//# sourceMappingURL=manual.js.map