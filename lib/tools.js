/**
 * The nine agent tools.
 *
 * Each tool is a thin, honest wrapper: it validates its arguments, calls the
 * pipeline, and returns a JSON object that also renders as a readable card. No
 * tool decides policy on its own — that lives in `safety.ts` and `publisher.ts`
 * so a prompt-injection attempt cannot talk a tool into loosening a rule.
 */
import { loggerOf } from './host.js';
import { ellipsis, jsonSafe, renderError, renderSummary } from './render.js';
import { describeFailure, getSession, healthCheck, personaFromConfig, runAnalysis, runGeneration, runPublish, stopSession, } from './runtime.js';
import { resolvePersona, PERSONAS, PERSONA_STYLES } from './persona.js';
/** Build every tool definition. */
export function buildTools(runtime, ctx) {
    const log = loggerOf(ctx, 'dsh-ai-debate');
    const tools = [
        bindOwnerTool(runtime),
        setPersonalityTool(runtime),
        analyzeThreadTool(runtime, log),
        analyzeReplyTool(runtime, log),
        generateReplyTool(runtime, log),
        publishReplyTool(runtime, log),
        getSessionTool(runtime, log),
        stopSessionTool(runtime, log),
        healthCheckTool(runtime, ctx),
    ];
    // Every result is made losslessly JSON-serializable at the boundary, once,
    // instead of relying on each tool to remember: an optional field left
    // `undefined` is invisible in TypeScript and fatal at the Host boundary.
    return tools.map((tool) => ({
        ...tool,
        async execute(args, context) {
            return jsonSafe(await tool.execute(args, context));
        },
    }));
}
/** A uniform output envelope. */
const OUTPUT_SCHEMA = { type: 'object', additionalProperties: true };
/** The envelope every tool returns on failure. */
function failure(message, hint) {
    return { ok: false, error: message, hint };
}
/** Read a card payload from a tool result. */
function card(value) {
    return (value ?? {});
}
/** Bind the owner identity and the AI account. */
function bindOwnerTool(runtime) {
    return {
        name: 'debate_bind_owner',
        description: '检查（不写入）主人与 AI 账号的绑定情况，并给出需要写进插件设置的确切值。' +
            '本工具不会修改插件配置：DSH 的插件设置由用户在界面上编辑，' +
            '所以它做三件事——校验你打算用的值、指出重名等风险、告诉你该填哪一项。',
        parameters: {
            type: 'object',
            properties: {
                ownerUserId: { type: 'string', description: '主人的贴吧数字用户 ID（优先使用）' },
                ownerUserName: { type: 'string', description: '主人的贴吧用户名（仅在无 ID 时使用）' },
                aiAccountName: { type: 'string', description: 'AI 小号的显示名称' },
                aiAccountUserId: { type: 'string', description: 'AI 小号的用户 ID' },
            },
            additionalProperties: false,
        },
        output: {
            schema: OUTPUT_SCHEMA,
            render: (_args, value) => {
                const data = card(value);
                if (data.ok === false)
                    return renderError(data.error ?? '绑定失败', data.hint);
                return renderSummary('账号绑定（预览）', data.lines ?? []);
            },
        },
        async execute(args) {
            const input = (args ?? {});
            const config = runtime.config();
            // A provided value wins for the *preview* only; nothing is persisted.
            const ownerUserId = String(input.ownerUserId ?? config.ownerUserId ?? '').trim();
            const ownerUserName = String(input.ownerUserName ?? config.ownerUserName ?? '').trim();
            const aiAccountName = String(input.aiAccountName ?? config.aiAccountName ?? '').trim();
            const aiAccountUserId = String(input.aiAccountUserId ?? config.aiAccountUserId ?? '').trim();
            const provided = ['ownerUserId', 'ownerUserName', 'aiAccountName', 'aiAccountUserId'].filter((field) => input[field] !== undefined);
            // A cookie is a credential, not a configuration value. Accepting one here
            // would put a live login session into the transcript, the tool-call log and
            // the model's context — so the parameter is gone and a caller that still
            // tries it is told where the value belongs instead of being silently
            // ignored.
            if (input.tiebaCookie !== undefined) {
                return failure('debate_bind_owner 不再接受 tiebaCookie 参数', '登录 Cookie 是凭据，不能作为工具参数提交（它会进入对话与模型上下文）。' +
                    '请打开「插件 → dsh-ai-debate → 配置」→「百度贴吧账号」→「登录凭据」，在那里保存。');
            }
            if (!ownerUserId && !ownerUserName) {
                return failure('没有提供主人的用户 ID 或用户名', '请传入 ownerUserId（推荐）或 ownerUserName；也可以直接在插件设置里填写');
            }
            const key = '设置 → 插件 → dsh-ai-debate → 配置';
            const lines = [];
            const warnings = [];
            if (!ownerUserId) {
                warnings.push('只配置了昵称：昵称可能重名，会把别人的话当成主人的。强烈建议改用数字用户 ID。');
                lines.push(`主人：${ownerUserName}（按昵称匹配，存在重名风险）`);
            }
            else {
                lines.push(`主人：${ownerUserName || '未设昵称'}（ID ${ownerUserId}）`);
            }
            lines.push(aiAccountUserId ? `AI 账号：${aiAccountName || '未设显示名'}（ID ${aiAccountUserId}）` : aiAccountName ? `AI 账号：${aiAccountName}（未设置 ID，发表前无法核对登录账号）` : 'AI 账号：未设置');
            lines.push('');
            // Being explicit about the limitation is the whole point: a tool that looks
            // like it saved something but did not is worse than no tool at all.
            if (provided.length > 0) {
                lines.push(`⚠️ 你传入的 ${provided.join('、')} 只用于本次校验，**没有写入配置**。`);
            }
            lines.push(`要让它真正生效，请在「${key}」里填写：`);
            if (ownerUserId)
                lines.push(`  ownerUserId = ${ownerUserId}`);
            else if (ownerUserName)
                lines.push(`  ownerUserName = ${ownerUserName}`);
            if (aiAccountUserId)
                lines.push(`  aiAccountUserId = ${aiAccountUserId}`);
            if (aiAccountName)
                lines.push(`  aiAccountName = ${aiAccountName}`);
            lines.push('');
            lines.push('登录 Cookie 不在这个工具里配置：请到「百度贴吧账号」区域的「登录凭据」保存。');
            if (config.ownerUserId === ownerUserId && config.ownerUserName === ownerUserName && ownerUserId) {
                lines.push('');
                lines.push('当前设置里已经就是这个主人身份，分析会直接使用它。');
            }
            lines.push('');
            lines.push('提示：贴吧网页端不暴露数字 ID，可以从楼中楼接口的 user_id 字段或手机 App 资料页获取。');
            lines.push('账号一旦改动，之前基于旧身份生成的候选回复不应再发表；请对旧会话重新分析。');
            return {
                ok: true,
                ...(warnings.length > 0 ? { warning: warnings.join(' ') } : {}),
                lines,
                persisted: false,
                settingsPath: key,
            };
        },
    };
}
/** Preview the persona; persistence happens in the plugin settings. */
function setPersonalityTool(runtime) {
    return {
        name: 'debate_set_personality',
        description: '预览人格与表达参数，并给出要写进插件设置的确切值。本工具不修改配置：' +
            '下一次生成仍用设置里的旧值，除非你把值写进设置，或在下一次 generate 调用里传 style。' +
            '人格只改语气，不改事实、不改引用的对象、不改论点。',
        parameters: {
            type: 'object',
            properties: {
                style: {
                    type: 'string',
                    enum: [...PERSONA_STYLES],
                    description: '人格：tieba_veteran（贴吧老哥）/ soft_defensive（小受）/ tsundere（傲娇）/ aloof（高冷）',
                },
                intensity: { type: 'number', minimum: 1, maximum: 5, description: '表达强度 1-5' },
                maxLength: { type: 'number', minimum: 20, maximum: 600, description: '最大回复字数' },
                emojiLevel: { type: 'number', minimum: 0, maximum: 3, description: '表情使用程度 0-3' },
                sarcasmLevel: { type: 'number', minimum: 0, maximum: 3, description: '调侃强度 0-3' },
                directness: { type: 'number', minimum: 1, maximum: 5, description: '直接程度 1-5' },
            },
            additionalProperties: false,
        },
        output: {
            schema: OUTPUT_SCHEMA,
            render: (_args, value) => {
                const data = card(value);
                if (data.ok === false)
                    return renderError(data.error ?? '设置失败', data.hint);
                return renderSummary('人格设置', data.lines ?? []);
            },
        },
        async execute(args) {
            const input = (args ?? {});
            const current = runtime.config();
            if (Object.keys(input).length === 0) {
                const persona = personaFromConfig(current);
                const definition = PERSONAS[persona.style];
                return {
                    ok: true,
                    persona: definition.id,
                    current: persona,
                    lines: [
                        `当前人格：${definition.name} —— ${definition.summary}`,
                        `强度 ${persona.intensity} / 长度上限 ${persona.maxLength} 字 / 表情 ${persona.emojiLevel} / 调侃 ${persona.sarcasmLevel} / 直接 ${persona.directness}`,
                        '可选人格：' + PERSONA_STYLES.map((id) => `${id}（${PERSONAS[id].name}）`).join('、'),
                    ],
                };
            }
            const style = input.style === undefined ? current.personaStyle : String(input.style);
            if (!PERSONA_STYLES.includes(style)) {
                return failure(`未知人格：${style}`, `可选值：${PERSONA_STYLES.join(' / ')}`);
            }
            const persona = resolvePersona({
                style: style,
                intensity: input.intensity === undefined ? current.intensity : Number(input.intensity),
                maxLength: input.maxLength === undefined ? current.maxLength : Number(input.maxLength),
                emojiLevel: input.emojiLevel === undefined ? current.emojiLevel : Number(input.emojiLevel),
                sarcasmLevel: input.sarcasmLevel === undefined ? current.sarcasmLevel : Number(input.sarcasmLevel),
                directness: input.directness === undefined ? current.directness : Number(input.directness),
            });
            const definition = PERSONAS[persona.style];
            return {
                ok: true,
                persona: definition.id,
                resolved: persona,
                persisted: false,
                settingsPath: '设置 → 插件 → dsh-ai-debate → 配置',
                lines: [
                    `预览：${definition.name} —— ${definition.summary}`,
                    `论证方式：${definition.approach}`,
                    `强度 ${persona.intensity} / 长度上限 ${persona.maxLength} 字 / 表情 ${persona.emojiLevel} / 调侃 ${persona.sarcasmLevel} / 直接 ${persona.directness}`,
                    '',
                    '⚠️ 这是预览，**没有写入配置**：下一次生成仍会使用插件设置里的旧值。',
                    '要让它在之后每次生成里生效，请把下列值写进「设置 → 插件 → dsh-ai-debate → 配置」：',
                    `  personaStyle = ${persona.style}`,
                    `  intensity = ${persona.intensity}`,
                    `  maxLength = ${persona.maxLength}`,
                    `  emojiLevel = ${persona.emojiLevel}`,
                    `  sarcasmLevel = ${persona.sarcasmLevel}`,
                    `  directness = ${persona.directness}`,
                    '',
                    '如果只是想这一次换个语气，请在调用 debate_generate_reply 时传 style 参数。',
                ],
            };
        },
    };
}
/** Read and analyze a whole thread. */
function analyzeThreadTool(runtime, log) {
    return {
        name: 'debate_analyze_thread',
        description: 'Read a Tieba thread (all pages, plus nested replies where they matter) and reconstruct who is arguing with whom. ' +
            'Returns the identified owner, the opponent, the exchange and open questions. ' +
            'This does not call the model; it is pure reading plus rules, so a wrong opponent is visible before any text exists.',
        parameters: {
            type: 'object',
            properties: {
                url: { type: 'string', description: '帖子链接，例如 https://tieba.baidu.com/p/1234567890' },
                postId: {
                    type: 'string',
                    description: '主人召唤所在的那条回复的 post id（可选；不填则用链接里的 pid 或主人最新发言）',
                },
                ownerInstruction: { type: 'string', description: '主人在召唤时额外说明的要求（可选）' },
            },
            required: ['url'],
            additionalProperties: false,
        },
        output: {
            schema: OUTPUT_SCHEMA,
            render: (_args, value) => {
                const data = card(value);
                if (data.ok === false)
                    return renderError(data.error ?? '分析失败', data.hint);
                return renderSummary('帖子分析', data.lines ?? []);
            },
        },
        timeoutMs: 300_000,
        async execute(args, context) {
            const input = (args ?? {});
            const url = String(input.url ?? '').trim();
            if (!url)
                return failure('缺少帖子链接', '请传入 url，例如 https://tieba.baidu.com/p/1234567890');
            try {
                const analysis = await runAnalysis(runtime, {
                    url,
                    postId: input.postId === undefined ? undefined : String(input.postId),
                    ownerInstruction: input.ownerInstruction === undefined ? undefined : String(input.ownerInstruction),
                    signal: context.signal,
                });
                const { dispute } = analysis;
                const lines = [];
                lines.push(`帖子：${analysis.thread.title || '（无标题）'} · ${analysis.thread.forumName}吧`);
                lines.push(`楼层：可读 ${analysis.thread.readFloors} 楼` +
                    (analysis.thread.declaredReplyCount !== undefined
                        ? ` / 平台声明 ${analysis.thread.declaredReplyCount} 楼`
                        : ''));
                lines.push(`主人：${dispute.owner.displayName}（发言 ${dispute.owner.postCount} 条）`);
                lines.push(dispute.opponent
                    ? `争论对象：${dispute.opponent.displayName}（发言 ${dispute.opponent.postCount} 条，往来 ${dispute.opponentEvidence?.exchanges ?? 0} 次）`
                    : '争论对象：未确定');
                lines.push(`争论位置：第 ${dispute.floorNumber} 楼`);
                if (dispute.notes.length > 0)
                    lines.push(`备注：${dispute.notes.join('；')}`);
                if (dispute.openQuestions.length > 0) {
                    lines.push(`对方尚未被回应的问题：${dispute.openQuestions.length} 条`);
                }
                if (analysis.ownerClaims.length > 0) {
                    lines.push(`主人核心主张：${analysis.ownerClaims.slice(0, 3).map((claim) => ellipsis(claim, 40)).join(' / ')}`);
                }
                if (analysis.issues.length > 0)
                    lines.push(`读取提示：${analysis.issues.join('；')}`);
                if (analysis.securityNotes.length > 0) {
                    lines.push(`安全提示：检测到 ${analysis.securityNotes.length} 处指令性文本，已按普通发言处理`);
                }
                lines.push(`会话 ID：${analysis.sessionId}`);
                return {
                    ok: true,
                    sessionId: analysis.sessionId,
                    thread: analysis.thread,
                    dispute: {
                        floorNumber: dispute.floorNumber,
                        needsConfirmation: dispute.needsConfirmation,
                        owner: {
                            name: dispute.owner.displayName,
                            key: dispute.owner.key,
                            posts: dispute.owner.postCount,
                        },
                        opponent: dispute.opponent
                            ? {
                                name: dispute.opponent.displayName,
                                key: dispute.opponent.key,
                                posts: dispute.opponent.postCount,
                                lastPostId: dispute.opponent.lastPostId,
                            }
                            : null,
                        evidence: dispute.opponentEvidence ?? null,
                        exchange: dispute.exchange.map((statement) => ({
                            postId: statement.postId,
                            author: statement.authorName,
                            floor: statement.floorNumber,
                            text: ellipsis(statement.content, 120),
                        })),
                        openQuestions: dispute.openQuestions.map((statement) => ({
                            postId: statement.postId,
                            author: statement.authorName,
                            text: ellipsis(statement.content, 120),
                        })),
                    },
                    ownerClaims: analysis.ownerClaims,
                    participants: analysis.participants,
                    issues: analysis.issues,
                    securityNotes: analysis.securityNotes,
                    lines,
                };
            }
            catch (error) {
                const described = describeFailure(error);
                log.error(`debate_analyze_thread 失败：${described.message}`);
                return failure(described.message, described.pause ? '需要人工处理后才能继续' : undefined);
            }
        },
    };
}
/** Analyze one specific reply. */
function analyzeReplyTool(runtime, log) {
    return {
        name: 'debate_analyze_reply',
        description: 'Analyze the argument around one specific reply id. ' +
            'Same reconstruction as debate_analyze_thread, but pinned to the reply you name, ' +
            'which is how you avoid analysing a different argument that happens to be in the same thread.',
        parameters: {
            type: 'object',
            properties: {
                url: { type: 'string', description: '帖子链接' },
                postId: { type: 'string', description: '要分析的那条回复的 post id（必填）' },
                ownerInstruction: { type: 'string', description: '主人的附加要求（可选）' },
            },
            required: ['url', 'postId'],
            additionalProperties: false,
        },
        output: {
            schema: OUTPUT_SCHEMA,
            render: (_args, value) => {
                const data = card(value);
                if (data.ok === false)
                    return renderError(data.error ?? '分析失败', data.hint);
                return renderSummary('回复分析', data.lines ?? []);
            },
        },
        timeoutMs: 300_000,
        async execute(args, context) {
            const input = (args ?? {});
            const url = String(input.url ?? '').trim();
            const postId = String(input.postId ?? '').trim();
            if (!url)
                return failure('缺少帖子链接', '请传入 url');
            if (!postId)
                return failure('缺少回复 ID', '请传入 postId（要分析的那条回复的 id）');
            try {
                const analysis = await runAnalysis(runtime, {
                    url,
                    postId,
                    ownerInstruction: input.ownerInstruction === undefined ? undefined : String(input.ownerInstruction),
                    signal: context.signal,
                });
                const { dispute } = analysis;
                const lines = [];
                lines.push(`已锁定回复 ${postId}（第 ${dispute.floorNumber} 楼）`);
                lines.push(`主人：${dispute.owner.displayName}`);
                lines.push(`争论对象：${dispute.opponent?.displayName ?? '未确定'}`);
                if (dispute.needsConfirmation)
                    lines.push(`⚠️ 需要确认：${dispute.notes.join('；')}`);
                lines.push(`往来发言：${dispute.exchange.length} 条`);
                lines.push(`会话 ID：${analysis.sessionId}`);
                return {
                    ok: true,
                    sessionId: analysis.sessionId,
                    needsConfirmation: dispute.needsConfirmation,
                    dispute: {
                        floorNumber: dispute.floorNumber,
                        owner: dispute.owner.displayName,
                        opponent: dispute.opponent?.displayName ?? null,
                        opponentLastPostId: dispute.opponent?.lastPostId ?? null,
                        exchange: dispute.exchange.length,
                        notes: dispute.notes,
                    },
                    ownerClaims: analysis.ownerClaims,
                    issues: analysis.issues,
                    lines,
                };
            }
            catch (error) {
                const described = describeFailure(error);
                log.error(`debate_analyze_reply 失败：${described.message}`);
                return failure(described.message);
            }
        },
    };
}
/** Generate a candidate reply. */
function generateReplyTool(runtime, log) {
    return {
        name: 'debate_generate_reply',
        description: 'Generate a candidate reply for an analysed session. ' +
            'Returns the text, the strategy, the model self-confidence, and every rule the candidate broke. ' +
            'A candidate with violations is never publishable.',
        parameters: {
            type: 'object',
            properties: {
                sessionId: {
                    type: 'string',
                    description: 'debate_analyze_thread / debate_analyze_reply 返回的会话 ID',
                },
                style: { type: 'string', enum: [...PERSONA_STYLES], description: '临时覆盖人格（可选）' },
                ownerInstruction: { type: 'string', description: '本次生成的额外要求（可选）' },
            },
            required: ['sessionId'],
            additionalProperties: false,
        },
        output: {
            schema: OUTPUT_SCHEMA,
            render: (_args, value) => {
                const data = card(value);
                if (data.ok === false)
                    return renderError(data.error ?? '生成失败', data.hint);
                return renderSummary('候选回复', data.lines ?? []);
            },
        },
        timeoutMs: 300_000,
        async execute(args, context) {
            const input = (args ?? {});
            const sessionId = String(input.sessionId ?? '').trim();
            if (!sessionId)
                return failure('缺少会话 ID', '请先调用 debate_analyze_thread');
            try {
                const style = input.style === undefined ? undefined : String(input.style);
                const generated = await runGeneration(runtime, {
                    sessionId,
                    persona: style
                        ? resolvePersona({ ...personaFromConfig(runtime.config()), style: style })
                        : undefined,
                    ownerInstruction: input.ownerInstruction === undefined ? undefined : String(input.ownerInstruction),
                    signal: context.signal,
                });
                const lines = [];
                if (generated.needsInput) {
                    lines.push(`模型要求补充信息：${generated.needsInputReason ?? '未说明'}`);
                }
                if (generated.text) {
                    lines.push(`候选回复（${generated.text.length} 字，策略 ${generated.strategy}，置信度 ${generated.confidence.toFixed(2)}）：`);
                    lines.push(generated.text);
                }
                if (generated.violations.length > 0) {
                    lines.push(`❌ 未通过检查：${generated.violations.join('；')}`);
                }
                else if (generated.text) {
                    lines.push('✅ 已通过程序检查，可以提交人工审核');
                }
                if (generated.notes.length > 0)
                    lines.push(`备注：${generated.notes.join('；')}`);
                // Report both halves, so "758/760" cannot be mistaken for "nearly out of
                // budget" when the thread share is deliberately small. The fixed costs are
                // the system prompt, persona, scaffold and the reply reservation.
                lines.push(`预算：帖子上下文 ${generated.contextTokens}/${generated.budget} tokens，` +
                    `固定开销 ${generated.fixedCostTokens}，合计上限 ${generated.totalBudget}` +
                    (generated.omissions.length > 0 ? `，省略了 ${generated.omissions.length} 项` : ''));
                lines.push(`tokens：入 ${generated.usage.inputTokens} / 出 ${generated.usage.outputTokens}`);
                lines.push(`候选 ID：${generated.candidateId}`);
                return {
                    ok: generated.violations.length === 0 && !generated.needsInput,
                    sessionId: generated.sessionId,
                    candidateId: generated.candidateId,
                    text: generated.text,
                    strategy: generated.strategy,
                    confidence: generated.confidence,
                    violations: generated.violations,
                    notes: generated.notes,
                    needsInput: generated.needsInput,
                    needsInputReason: generated.needsInputReason,
                    context: {
                        tokens: generated.contextTokens,
                        budget: generated.budget,
                        omissions: generated.omissions,
                    },
                    usage: generated.usage,
                    lines,
                };
            }
            catch (error) {
                const described = describeFailure(error);
                log.error(`debate_generate_reply 失败：${described.message}`);
                return failure(described.message, described.pause ? '模型或平台需要人工处理' : undefined);
            }
        },
    };
}
/** Publish an approved candidate. */
function publishReplyTool(runtime, log) {
    return {
        name: 'debate_publish_reply',
        description: 'Publish one approved candidate reply. ' +
            'Requires confirm=true and the exact text the user reviewed. ' +
            'Refuses when: the text differs from the stored candidate, the candidate broke a rule, ' +
            'a previous attempt has an unknown outcome, or the session already published for this trigger.',
        parameters: {
            type: 'object',
            properties: {
                sessionId: { type: 'string', description: '会话 ID' },
                candidateId: { type: 'string', description: '候选回复 ID' },
                text: { type: 'string', description: '主人确认过的完整回复正文（必须与候选一致）' },
                confirm: { type: 'boolean', description: '必须为 true 才发送；这是主人的明确授权' },
            },
            required: ['sessionId', 'candidateId', 'text', 'confirm'],
            additionalProperties: false,
        },
        output: {
            schema: OUTPUT_SCHEMA,
            render: (_args, value) => {
                const data = card(value);
                if (data.ok === false)
                    return renderError(data.error ?? '发表失败', data.hint);
                return renderSummary('发表结果', data.lines ?? []);
            },
        },
        timeoutMs: 180_000,
        async execute(args, context) {
            const input = (args ?? {});
            const sessionId = String(input.sessionId ?? '').trim();
            const candidateId = String(input.candidateId ?? '').trim();
            const text = String(input.text ?? '');
            const confirm = input.confirm === true;
            if (!sessionId)
                return failure('缺少会话 ID');
            if (!candidateId)
                return failure('缺少候选 ID');
            if (!confirm) {
                return failure('没有收到明确授权（confirm 不为 true）', '发表需要主人确认：请把 confirm 设为 true，并传入主人看过的完整正文');
            }
            try {
                const report = await runPublish(runtime, {
                    sessionId,
                    candidateId,
                    approvedText: text,
                    humanApproved: true,
                    signal: context.signal,
                });
                const lines = [report.message];
                if (report.postId)
                    lines.push(`post id：${report.postId}`);
                if (report.verified)
                    lines.push('已在帖子中回读到这条回复');
                if (report.paused)
                    lines.push('⚠️ 会话已暂停，需要人工处理后才能继续');
                return {
                    ok: report.ok,
                    status: report.status,
                    postId: report.postId,
                    verified: report.verified,
                    paused: report.paused ?? false,
                    error: report.ok ? undefined : report.message,
                    errorCode: report.errorCode,
                    lines,
                };
            }
            catch (error) {
                const described = describeFailure(error);
                log.error(`debate_publish_reply 失败：${described.message}`);
                return failure(described.message);
            }
        },
    };
}
/** Read a session. */
function getSessionTool(runtime, log) {
    return {
        name: 'debate_get_session',
        description: 'Read one discussion session: its state, the identified opponent, every candidate reply, ' +
            'and what has already been published. Use it to resume work or to check why a task stopped.',
        parameters: {
            type: 'object',
            properties: { sessionId: { type: 'string', description: '会话 ID' } },
            required: ['sessionId'],
            additionalProperties: false,
        },
        output: {
            schema: OUTPUT_SCHEMA,
            render: (_args, value) => {
                const data = card(value);
                if (data.ok === false)
                    return renderError(data.error ?? '读取失败', data.hint);
                return renderSummary('会话状态', data.lines ?? []);
            },
        },
        async execute(args) {
            const input = (args ?? {});
            const sessionId = String(input.sessionId ?? '').trim();
            if (!sessionId)
                return failure('缺少会话 ID');
            try {
                const view = await getSession(runtime, sessionId);
                const { session } = view;
                const lines = [];
                lines.push(`会话 ${session.id}`);
                lines.push(`状态：${session.state} —— ${session.statusText}`);
                lines.push(`帖子：${session.threadTitle || '（无标题）'} · ${session.forumName}吧`);
                lines.push(`主人：${session.ownerName ?? session.ownerKey}`);
                lines.push(`对手：${session.opponentName ?? '未确定'}`);
                lines.push(`争论位置：第 ${session.disputeFloorNumber} 楼 / 召唤回复 ${session.triggerPostId}`);
                lines.push(`人格：${session.persona.style}（强度 ${session.persona.intensity}，上限 ${session.persona.maxLength} 字）`);
                if (session.candidates.length === 0) {
                    lines.push('候选回复：暂无');
                }
                else {
                    lines.push(`候选回复 ${session.candidates.length} 条：`);
                    for (const candidate of session.candidates.slice(-3)) {
                        lines.push(`  · ${candidate.replyId}（${candidate.violations.length === 0 ? '通过检查' : '未通过'}）` +
                            ellipsis(candidate.text, 60));
                    }
                }
                if (session.publishedPostIds.length > 0) {
                    lines.push(`已发表：${session.publishedPostIds.join(', ')}`);
                }
                if (session.error)
                    lines.push(`错误：${session.error}`);
                lines.push(`更新时间：${session.updatedAt}`);
                return { ok: true, session, lines };
            }
            catch (error) {
                log.error(`debate_get_session 失败：${error.message}`);
                return failure(error.message);
            }
        },
    };
}
/** Stop a session. */
function stopSessionTool(runtime, log) {
    return {
        name: 'debate_stop_session',
        description: 'Stop one session. The task is marked CANCELLED and no further automatic work happens for it. ' +
            'Already published replies are not affected.',
        parameters: {
            type: 'object',
            properties: {
                sessionId: { type: 'string', description: '会话 ID' },
                reason: { type: 'string', description: '停止原因（可选）' },
            },
            required: ['sessionId'],
            additionalProperties: false,
        },
        output: {
            schema: OUTPUT_SCHEMA,
            render: (_args, value) => {
                const data = card(value);
                if (data.ok === false)
                    return renderError(data.error ?? '停止失败', data.hint);
                return renderSummary('已停止', data.lines ?? []);
            },
        },
        async execute(args) {
            const input = (args ?? {});
            const sessionId = String(input.sessionId ?? '').trim();
            if (!sessionId)
                return failure('缺少会话 ID');
            try {
                const session = await stopSession(runtime, sessionId, input.reason === undefined ? undefined : String(input.reason));
                return { ok: true, session, lines: [`会话 ${session.id} 已停止`, session.statusText] };
            }
            catch (error) {
                log.error(`debate_stop_session 失败：${error.message}`);
                return failure(error.message);
            }
        },
    };
}
/** Report health. */
function healthCheckTool(runtime, ctx) {
    return {
        name: 'debate_health_check',
        description: 'Report the plugin state: whether the owner is bound and the model configured, ' +
            "what the platform adapter can actually do, where the store lives, and today's token usage. " +
            'Does not touch the network.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        output: {
            schema: OUTPUT_SCHEMA,
            render: (_args, value) => {
                const data = card(value);
                if (data.ok === false)
                    return renderError(data.error ?? '检查失败');
                return renderSummary('健康检查', data.lines ?? []);
            },
        },
        async execute() {
            try {
                const report = await healthCheck(runtime);
                const lines = [];
                lines.push(`插件：${report.enabled ? '已启用' : '已停用'}`);
                lines.push(`主人绑定：${report.ownerBound ? '已绑定' : '未绑定'}`);
                lines.push(`模型接口：${report.llmConfigured ? '已配置' : '未配置'}`);
                lines.push(`存储：${report.storePath}（${report.sessions} 个会话）`);
                lines.push(`模型用量：${report.usage.calls} 次调用，入 ${report.usage.inputTokens} / 出 ${report.usage.outputTokens} tokens，失败 ${report.usage.failures} 次`);
                const caps = report.capabilities;
                lines.push('平台能力：读取主题帖 ' + mark(caps.thread) +
                    ' · 楼层分页 ' + mark(caps.replies) +
                    ' · 楼中楼 ' + mark(caps.nestedReplies) +
                    ' · 用户资料 ' + mark(caps.userProfile) +
                    ' · 艾特通知 ' + mark(caps.mentions) +
                    ' · 发表回复 ' + mark(caps.publish));
                if (report.cookieNames.length > 0) {
                    lines.push(`已持有 Cookie 名称：${report.cookieNames.join(', ')}（不显示值）`);
                }
                for (const note of report.notes)
                    lines.push(`提示：${note}`);
                return { ok: true, report, lines };
            }
            catch (error) {
                loggerOf(ctx, 'dsh-ai-debate').error(`debate_health_check 失败：${error.message}`);
                return failure(error.message);
            }
        },
    };
}
/** Render a capability flag. */
function mark(value) {
    return value ? '✅' : '❌';
}
//# sourceMappingURL=tools.js.map