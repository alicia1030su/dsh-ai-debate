/**
 * dsh-ai-debate — browser half.
 *
 * Registers the "dsh-ai-debate" configuration page into the Web settings panel:
 * 设置 → 插件 → dsh-ai-debate 行 → 配置 — the `plugins.row.config` keyed slot
 * declared by @deepseek-ai/dsh-client-ui-settings-plugins, keyed
 * `<package name>#<row id>`.
 *
 * Why not the Harness settings RPC: that wire only exposes namespaces on the
 * Harness's own allowlist, which a third-party plugin cannot widen. Instead this
 * page talks to the plugin-owned `/api/dsh-ai-debate/*` route family (see
 * src/settings-routes.ts), which reads and writes the same settings namespace
 * through the Host settings service.
 *
 * The security rule this file exists to honour: a saved Cookie or API key is
 * never rendered. The page receives `configured` / `source` / a four-character
 * tail and nothing else, and the write path is one-way — a secret can be
 * replaced or cleared, never read back. There is no code path here that could
 * display one even if a future Host change started sending it, because the
 * renderers only ever read the redacted fields.
 *
 * Export discipline mirrors the host half: the /client surface carries only the
 * plugin contract (apply / inject).
 */

window.__ModuleLoader__.load({
  id: 'dsh-ai-debate',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const { createSnapshotStore } = require('@deepseek-ai/dsh-client-store')

    const h = React.createElement
    /**
     * Hooks, captured once.
     *
     * Deliberately destructured at module scope rather than reached through
     * `React.useState` at render time: the harness's React handle exposes
     * `createElement` reliably, but hook properties read through it at call time
     * did not survive — the component threw during render and the settings pane
     * stayed blank while its sidebar entry looked healthy. Every other
     * third-party browser half in this build reads them the same way.
     */
    const { useState, useEffect, Fragment } = React

    /** Bundle package name, half of the `plugins.row.config` key. */
    const PKG = 'dsh-ai-debate'

    /** Settings namespace = the Loader row id. */
    const NS = 'dsh-ai-debate'

    /** Route family (mirrors ROUTE_PREFIX in src/settings-routes.ts). */
    const API = '/api/dsh-ai-debate'
    const ROUTE_SETTINGS = `${API}/settings`
    const ROUTE_SECRETS = `${API}/secrets`
    const ROUTE_STATUS = `${API}/status`
    const ROUTE_ACTION = `${API}/action`

    /** Credential reference names (mirrors src/secrets.ts). */
    const REF_COOKIE = 'DSH_AI_DEBATE_TIEBA_COOKIE'
    const REF_LLM_KEY = 'DSH_AI_DEBATE_LLM_API_KEY'

    /**
     * The active locale tag, read lazily at render time.
     *
     * The registry hands dictionaries to the harness, but a `label` thunk and a
     * component both need the *current* language to choose their own words, and
     * this module registers no locale subscription of its own. Reading
     * `navigator.language` once per call is enough: the harness re-renders on a
     * locale switch anyway, so the next read sees the new value.
     */
    function locale() {
      const lang = typeof navigator === 'undefined' ? '' : String(navigator.language || '')
      return lang.toLowerCase().startsWith('zh') ? 'zh' : 'en'
    }

    /** Pick the dictionary for the active locale. */
    function dict() {
      return locale() === 'zh' ? zh : en
    }

    /**
     * A `t(key)` lookup over the active dictionary.
     *
     * The settings section cannot borrow the harness's `t` (only slot-rendered
     * components receive it), so it reads the same dictionary the plugin
     * registered through `ctx.locale`. Missing keys return the key itself, which
     * is loud in the UI instead of rendering `undefined`.
     */
    function translator() {
      const table = dict()
      return (key, values) => {
        const template = table[key]
        if (template === undefined) return key
        return values === undefined ? template : format(template, values)
      }
    }

    // ---------------------------------------------------------------- locale

    const zh = {
      title: 'AI代吵架',
      navLabel: 'AI代吵架',
      description: '贴吧账号、模型、人格、发表策略与运行状态。',
      loading: '正在读取配置…',
      unavailable: '无法读取配置：本部署没有提供插件配置接口。',
      retry: '重试',
      save: '保存',
      saving: '保存中…',
      saved: '已保存，后台已使用新值。',
      saveFailed: '保存失败',
      conflict: '配置已被其他窗口或配置文件改动，已重新载入最新值，请再确认一次。',
      discard: '放弃修改',
      unsaved: '有未保存的修改',
      readOnly: '本部署的设置为只读。',
      overridden: '已覆盖',
      resetDefault: '恢复默认',

      tabAccount: '贴吧账号',
      tabModel: 'AI 模型',
      tabPersona: '人格',
      tabPublish: '发表与安全',
      tabPlatforms: '平台',
      tabStatus: '诊断与状态',

      ownerUserId: '主人贴吧数字 ID',
      ownerUserIdHint: '推荐填这个：昵称可能重名，会把别人的话当成主人的。',
      ownerUserName: '主人账号名称',
      ownerUserNameHint: '没有数字 ID 时才使用；存在重名风险。',
      aiAccountUserId: 'AI 小号数字 ID',
      aiAccountUserIdHint: '发表前用它核对登录账号，不填则无法发表。',
      aiAccountName: 'AI 小号显示名称',
      aiAccountNameHint: '只用于召唤提示与对照显示。',
      allowedOwnerIds: '额外可召唤的主人 ID',
      allowedOwnerIdsHint: '逗号分隔。默认只认上面那一个主人。',

      cookieTitle: '登录凭据（Cookie）',
      cookieHint: '只存在本机凭据库，不进配置、不进日志、不进模型上下文。页面永远不回显已保存的值。',
      cookieConfigured: '已配置',
      cookieUnset: '未配置',
      cookieFromConfig: '当前用的是配置文件里的旧值',
      cookieSuperseded: '凭据库里的值已覆盖配置文件的旧值',
      cookieTail: '末四位',
      // Credential phase: the difference between "not configured" and "not
      // confirmed yet". Saying the first when the second is true is the v0.1.10
      // defect; saying neither is worse, so the page names the actual state.
      credLoading: '正在读取凭据库…',
      credTimeout: '凭据库尚未确认（等待超时）',
      credTimeoutHint: '这不代表 Cookie 丢了。点「刷新状态」再试一次，或稍后重新打开本页。',
      credPartial: '凭据库报告有值但没有返回内容',
      credPartialHint: '可能仍在初始化。稍后重试；已保存的凭据没有被改动。',
      credFailed: '读取凭据库失败',
      credFailedHint: '这不代表 Cookie 丢了，已保存的值不会被删除。',
      credUnavailable: '本部署没有凭据服务',
      credBlocked: '凭据状态未确认，发表会被拒绝',
      credReady: '凭据已确认',
      newCookie: '粘贴新的贴吧 Cookie',
      newCookieHint: '留空表示不改动。保存后只显示末四位；保存失败会保留你粘贴的内容，可以直接重试。',
      newLlmKey: '粘贴新的模型 API Key',
      saveCookie: '保存凭据',
      saveLlmKey: '保存 API Key',
      clearCookie: '清除凭据',
      clearConfirm: '确定清除吗？清除后无法自动恢复，需要重新粘贴。',
      clearFailed: '清除未完成',
      cleared: '已清除。',
      cancel: '取消',
      saving: '保存中…',
      saveFailed: '保存失败',

      checkLogin: '检测登录状态',
      checking: '检测中…',
      loginOk: '已登录',
      loginFail: '未登录或无法确认',
      identityMismatch: '登录账号与配置的 AI 小号不一致：发表会被拒绝。',

      noCredentialService: '本部署没有凭据服务，密钥只能放在配置文件里（不推荐）。',

      llmBaseUrl: '模型 API 地址（Base URL）',
      llmBaseUrlHint: '任意 OpenAI 兼容接口，例如 https://api.example.com/v1 或 http://127.0.0.1:3000/v1。',
      httpWarn:
        '{host} 用的是明文 HTTP。API Key 会随每次请求的 Authorization 头一起发出去，' +
        '同网段的任何人都能看到它和请求内容。请改用 HTTPS 地址，或把服务挪到本机。' +
        '（插件不会替你改成 HTTPS：本地服务改了就连不上，真正该做的是换地址。）',
      httpLocalNote: '本机或内网明文地址：不会经过公网，属于常见开发用法。',
      httpsNote: 'HTTPS 地址由运行时正常校验证书；连不上时请修好证书，不要关闭校验。',
      llmModel: '模型名称',
      llmModelHint: '接口声明的 model id。',
      llmApiKeyTitle: '模型 API Key',
      llmApiKeyHint: '同样只存凭据库，不回显。',
      llmTemperature: '温度',
      llmTemperatureHint: '越低越稳。这个任务是精确性任务，建议 0.2–0.6。',
      llmMaxOutputTokens: '最大输出 tokens',
      llmMaxOutputTokensHint: '0 表示交给人格字数决定。',
      llmTimeoutMs: '请求超时（毫秒）',
      contextPreset: '上下文预算档位',
      contextPresetHint: '小/中/大。决定读多少帖子内容进提示词。',
      contextTokens: '自定义 token 预算',
      contextTokensHint: '大于 0 时覆盖上面的档位。',
      testModel: '测试模型连接',
      testing: '正在请求模型…',

      personaStyle: '默认人格',
      intensity: '情绪强度',
      maxLength: '回复长度上限',
      emojiLevel: '表情程度',
      sarcasmLevel: '调侃程度',
      directness: '表达直接程度',
      previewPersonas: '预览四种风格',
      previewHint: '只用固定测试对话本地渲染，不发帖、不调模型。',
      previewLoading: '渲染中…',

      interactionMode: '互动模式',
      interactionModeHint: 'manual=人工审核（默认），single_shot=单次授权，limited_auto=有限自动互动。',
      maxAutoPerSession: '每个会话自动发表上限',
      cooldownSeconds: '冷却时间（秒）',
      maxPerThread: '单帖回复次数上限',
      enabled: '插件总开关',
      enabledHint: '关闭后不读帖、不调模型、不发表。',
      announceToAgent: '向 Agent 播报工具说明',
      autoOffTitle: '关闭自动发表模式（需要保存）',
      autoOffHint:
        '把互动模式改成人工审核、自动发表额度改成 0。这是配置修改，点底部「保存」后才生效；已经开始的会话不会因此停下。',
      pauseNowTitle: '立即暂停正在进行的任务',
      pauseNowHint:
        '真正停止当前所有未完成的任务：发送中的请求会在发出前中断；已经发到贴吧的回复不能撤回，历史记录会保留。此操作立即生效，不需要保存。',
      pauseNow: '立即暂停所有任务',
      pausing: '正在暂停…',
      pausedNothing: '没有正在进行的任务。',
      pausedSome: '已停止 {stopped} 个任务，中断 {aborted} 个发送中的请求。',
      pausedRefused: '{count} 个任务无法停止（已发表或已结束）。',
      pausedPublished: '注意：{count} 条回复已经发到贴吧，撤回不了，记录保持为已发表。',
      history: '历史发表记录',
      pendingRecords: '未确认发布记录',
      recordsEmpty: '暂无记录。',
      recordsNotLoading: '点击刷新读取',

      statusTitle: '运行状态',
      dshVersion: 'DSH 版本',
      pluginVersion: '插件版本',
      storePath: '状态文件目录',
      sessions: '会话',
      sessionsDetail: '总计 {total}，进行中 {active}，待确认 {awaitingConfirmation}，已发表 {published}',
      ledger: '发表台账',
      ledgerDetail: '总计 {total}，已确认 {confirmed}，待确认 {pending}，失败 {failed}',
      ledgerOver: '台账已超过 2000 条，只报告不删除（删除会重新允许重复发表）。',
      usage: '模型用量',
      usageDetail: '调用 {calls} 次，输入 {inputTokens} tokens，输出 {outputTokens} tokens，失败 {failures} 次',
      recentErrors: '近期错误',
      errorsEmpty: '没有记录到错误。',
      rateLimit: '贴吧限流',
      refresh: '刷新状态',
      refreshing: '刷新中…',

      platformsTitle: '平台',
      platformsIntro:
        '「已接入」是代码真的在跑的平台；「计划中」只有一份清单，没有任何适配器，也没有取得平台授权。',
      platformsImplemented: '已接入',
      platformsPlanned: '计划中',
      platformsActive: '当前使用',
      platformsResearch: '研究阶段',
      platformsAuth: '认证方式',
      platformsUrls: '支持的链接',
      platformsPrereq: '实现前需要',
      platformsConstraints: '已知约束',
      platformsNoManifest: '本版本没有接入任何其他平台。',
      platformsCapsTitle: '能力状态',
      researchSurvey: '初步调研',
      researchDocumented: '已读官方文档',
      researchCredentialed: '已有开发者账号',
      researchRead: '读取已验证',
      researchWrite: '写入已验证',
      capSupported: '已验证可用',
      capUnverified: '未验证',
      capPermission: '需授权',
      capDegraded: '降级可用',
      capUnavailable: '不可用',
      capVerifiedAt: '最后验证',
      capLimits: '限制',
      capNeeds: '需要权限',
      capabilityName_thread_read: '读取帖子',
      capabilityName_comment_list: '评论列表',
      capabilityName_comment_paginate: '评论分页',
      capabilityName_comment_nested: '子评论',
      capabilityName_comment_locate: '定位评论',
      capabilityName_identity_verify: '身份验证',
      capabilityName_event_mentions: '艾特通知',
      capabilityName_comment_publish: '发表评论',
      capabilityName_comment_reply: '回复评论',
      capabilityName_publish_verify: '发表后核验',
      capabilityName_media_read: '图片内容',
      capabilityName_user_profile: '用户资料',

      required: '必填',
      invalidNumber: '请填数字。',
      unsavedLeave: '还有未保存的修改，确定离开这一页吗？',
    }

    const en = {
      title: 'AI Debate',
      navLabel: 'AI Debate',
      description: 'Tieba account, model, persona, publish policy and runtime status.',
      loading: 'Reading configuration…',
      unavailable: 'Configuration API is unavailable in this deployment.',
      retry: 'Retry',
      save: 'Save',
      saving: 'Saving…',
      saved: 'Saved. The next call uses the new values.',
      saveFailed: 'Save failed',
      conflict: 'Configuration changed elsewhere; the latest values were reloaded, please confirm again.',
      discard: 'Discard',
      unsaved: 'Unsaved changes',
      readOnly: 'Settings are read-only in this deployment.',
      overridden: 'Overridden',
      resetDefault: 'Reset to default',

      tabAccount: 'Tieba account',
      tabModel: 'AI model',
      tabPersona: 'Persona',
      tabPublish: 'Publishing',
      tabPlatforms: 'Platforms',
      tabStatus: 'Status',

      ownerUserId: 'Owner Tieba numeric id',
      ownerUserIdHint: 'Preferred: a nickname can collide and attribute someone else to the owner.',
      ownerUserName: 'Owner display name',
      ownerUserNameHint: 'Used only without a numeric id; collision risk.',
      aiAccountUserId: 'AI account numeric id',
      aiAccountUserIdHint: 'Checked before publishing; without it publishing is refused.',
      aiAccountName: 'AI account display name',
      aiAccountNameHint: 'Used for the summon hint and side-by-side display.',
      allowedOwnerIds: 'Additional summoning owner ids',
      allowedOwnerIdsHint: 'Comma separated.',

      cookieTitle: 'Login credential (Cookie)',
      cookieHint:
        'Stored only in the local credential store — never in config, logs or the model context. Saved values are never echoed.',
      cookieConfigured: 'Configured',
      cookieUnset: 'Not configured',
      cookieFromConfig: 'Using the legacy config value',
      cookieSuperseded: 'Credential store value supersedes the config value',
      cookieTail: 'last four',
      credLoading: 'Reading the credential store…',
      credTimeout: 'Credential store not confirmed (timed out)',
      credTimeoutHint: 'This does not mean the cookie is gone. Retry from the status tab, or reopen this page.',
      credPartial: 'The store claims a value it did not return',
      credPartialHint: 'It may still be initializing. Retry shortly; saved credentials are untouched.',
      credFailed: 'Reading the credential store failed',
      credFailedHint: 'This does not mean the cookie is gone; saved values are never deleted.',
      credUnavailable: 'This deployment has no credential service',
      credBlocked: 'Credential state unconfirmed — publishing will be refused',
      credReady: 'Credentials confirmed',
      newCookie: 'Paste a new Tieba cookie',
      newCookieHint:
        'Leave blank to keep it. Only the last four characters are shown afterwards; a failed save keeps what you pasted so you can retry.',
      newLlmKey: 'Paste a new model API key',
      saveCookie: 'Save credential',
      saveLlmKey: 'Save API key',
      clearCookie: 'Clear credential',
      clearConfirm: 'Clear it? It cannot be recovered automatically.',
      clearFailed: 'Clear did not complete',
      cleared: 'Cleared.',
      cancel: 'Cancel',

      checkLogin: 'Check login',
      checking: 'Checking…',
      loginOk: 'Signed in',
      loginFail: 'Not signed in or unverifiable',
      identityMismatch: 'The signed-in account differs from the configured AI account; publishing will be refused.',

      noCredentialService: 'No credential service here; secrets must live in the config file (not recommended).',

      llmBaseUrl: 'Model base URL',
      llmBaseUrlHint: 'Any OpenAI-compatible endpoint, e.g. https://api.example.com/v1 or http://127.0.0.1:3000/v1.',
      httpWarn:
        '{host} is plaintext HTTP. The API key rides in the Authorization header on every request, ' +
        'so anyone on the path can read it and the request itself. Use an HTTPS endpoint, or move the ' +
        'service onto this machine. (The plugin will not rewrite it to HTTPS for you: that would break a ' +
        'local server, and changing the endpoint is the actual fix.)',
      httpLocalNote: 'Loopback or private-range plaintext: does not cross the public internet; a normal dev setup.',
      httpsNote: 'HTTPS is verified by the runtime as usual. If it fails, fix the certificate — never disable verification.',
      llmModel: 'Model name',
      llmModelHint: 'The model id the endpoint declares.',
      llmApiKeyTitle: 'Model API key',
      llmApiKeyHint: 'Also stored only in the credential store, never echoed.',
      llmTemperature: 'Temperature',
      llmTemperatureHint: 'Lower is steadier; 0.2–0.6 suits this precision task.',
      llmMaxOutputTokens: 'Max output tokens',
      llmMaxOutputTokensHint: '0 lets the persona length decide.',
      llmTimeoutMs: 'Request timeout (ms)',
      contextPreset: 'Context budget preset',
      contextPresetHint: 'How much thread text enters the prompt.',
      contextTokens: 'Custom token budget',
      contextTokensHint: 'Above 0 it overrides the preset.',
      testModel: 'Test model connection',
      testing: 'Calling the model…',

      personaStyle: 'Default persona',
      intensity: 'Intensity',
      maxLength: 'Length cap',
      emojiLevel: 'Emoji level',
      sarcasmLevel: 'Sarcasm level',
      directness: 'Directness',
      previewPersonas: 'Preview all four',
      previewHint: 'Rendered locally from a fixed exchange; nothing is posted or generated.',
      previewLoading: 'Rendering…',

      interactionMode: 'Interaction mode',
      interactionModeHint: 'manual (default) / single_shot / limited_auto.',
      maxAutoPerSession: 'Automatic publishes per session',
      cooldownSeconds: 'Cooldown (s)',
      maxPerThread: 'Publishes per thread',
      enabled: 'Plugin enabled',
      enabledHint: 'When off, nothing is read, generated or published.',
      announceToAgent: 'Announce tools to the agent',
      autoOffTitle: 'Turn automatic publishing off (needs Save)',
      autoOffHint:
        'Sets the review mode to manual and the auto quota to 0. This is a config edit: it applies after you press Save, and sessions already running are unaffected.',
      pauseNowTitle: 'Stop running tasks now',
      pauseNowHint:
        'Actually stops every unfinished task: a request still in flight is aborted before it is sent. Replies that already reached Tieba cannot be withdrawn and stay in the history as published. Effective immediately; no save needed.',
      pauseNow: 'Stop all tasks now',
      pausing: 'Stopping…',
      pausedNothing: 'Nothing was running.',
      pausedSome: 'Stopped {stopped} task(s); aborted {aborted} in-flight request(s).',
      pausedRefused: '{count} task(s) could not be stopped (already published or finished).',
      pausedPublished: 'Note: {count} replies already reached Tieba and cannot be withdrawn; they stay recorded as published.',
      history: 'Publish history',
      pendingRecords: 'Unconfirmed publishes',
      recordsEmpty: 'No records.',
      recordsNotLoading: 'Refresh to read',

      statusTitle: 'Runtime',
      dshVersion: 'DSH version',
      pluginVersion: 'Plugin version',
      storePath: 'State directory',
      sessions: 'Sessions',
      sessionsDetail: 'total {total}, active {active}, awaiting {awaitingConfirmation}, published {published}',
      ledger: 'Publish ledger',
      ledgerDetail: 'total {total}, confirmed {confirmed}, pending {pending}, failed {failed}',
      ledgerOver: 'Over 2000 rows; reported only, never pruned (pruning re-permits duplicate posts).',
      usage: 'Model usage',
      usageDetail: '{calls} calls, {inputTokens} in, {outputTokens} out, {failures} failed',
      recentErrors: 'Recent errors',
      errorsEmpty: 'No errors recorded.',
      rateLimit: 'Rate limiting',
      refresh: 'Refresh status',
      refreshing: 'Refreshing…',

      platformsTitle: 'Platforms',
      platformsIntro:
        '“Implemented” means code that actually runs. “Planned” is a manifest only — no adapter, and no platform authorisation.',
      platformsImplemented: 'Implemented',
      platformsPlanned: 'Planned',
      platformsActive: 'In use',
      platformsResearch: 'Research stage',
      platformsAuth: 'Authentication',
      platformsUrls: 'Supported links',
      platformsPrereq: 'Before implementing',
      platformsConstraints: 'Known constraints',
      platformsNoManifest: 'No other platform is integrated in this version.',
      platformsCapsTitle: 'Capabilities',
      researchSurvey: 'Survey only',
      researchDocumented: 'Documented',
      researchCredentialed: 'Developer account',
      researchRead: 'Read verified',
      researchWrite: 'Write verified',
      capSupported: 'Verified',
      capUnverified: 'Unverified',
      capPermission: 'Needs permission',
      capDegraded: 'Degraded',
      capUnavailable: 'Unavailable',
      capVerifiedAt: 'Last verified',
      capLimits: 'Limits',
      capNeeds: 'Requires',
      capabilityName_thread_read: 'Read thread',
      capabilityName_comment_list: 'Comment list',
      capabilityName_comment_paginate: 'Comment paging',
      capabilityName_comment_nested: 'Nested comments',
      capabilityName_comment_locate: 'Locate comment',
      capabilityName_identity_verify: 'Identity check',
      capabilityName_event_mentions: 'Mentions',
      capabilityName_comment_publish: 'Publish comment',
      capabilityName_comment_reply: 'Reply to comment',
      capabilityName_publish_verify: 'Verify publish',
      capabilityName_media_read: 'Media content',
      capabilityName_user_profile: 'User profile',

      required: 'required',
      invalidNumber: 'Enter a number.',
      unsavedLeave: 'You have unsaved changes; leave this page?',
    }

    // ------------------------------------------------------------- utilities

    /** Fill `{name}` placeholders. */
    function format(template, values) {
      return String(template).replace(/\{(\w+)\}/g, (whole, key) =>
        values && key in values ? String(values[key]) : whole,
      )
    }

    /** The six page sections. */
    const TABS = [
      { id: 'account', label: 'tabAccount' },
      { id: 'model', label: 'tabModel' },
      { id: 'persona', label: 'tabPersona' },
      { id: 'publish', label: 'tabPublish' },
      { id: 'platforms', label: 'tabPlatforms' },
      { id: 'status', label: 'tabStatus' },
    ]

    /** JSON fetch with a uniform failure shape. */
    async function callJson(url, init) {
      const response = await fetch(url, {
        ...(init || {}),
        headers: {
          accept: 'application/json',
          ...(init && init.body ? { 'content-type': 'application/json' } : {}),
          ...((init && init.headers) || {}),
        },
      })
      let payload
      try {
        payload = await response.json()
      } catch {
        payload = undefined
      }
      if (!response.ok) {
        const message =
          payload && typeof payload.error === 'string' ? payload.error : `HTTP ${response.status}`
        const error = new Error(message)
        error.status = response.status
        throw error
      }
      return payload
    }

    /** An empty view, used before the first read and after a failed one. */
    function emptyView() {
      return {
        status: 'loading',
        writable: false,
        values: {},
        secrets: [],
        capabilities: { settingsService: false, credentialService: false },
      }
    }

    /**
     * Normalize one settings response.
     *
     * Everything the renderers may read has to be copied here — this function is a
     * whitelist, and a field omitted from it is silently dropped between the Host
     * and the page. `credentials` was exactly that: the Host started sending the
     * credential phase, the page kept reading `view.credentials`, and the drop
     * here made the whole feature invisible with no error anywhere. Anything added
     * to the route's payload must be added here in the same change.
     */
    function normalizeView(raw) {
      if (!raw || typeof raw !== 'object') return emptyView()
      return {
        status: raw.status === 'ready' ? 'ready' : 'unavailable',
        writable: raw.writable === true,
        values: raw.values && typeof raw.values === 'object' ? raw.values : {},
        secrets: Array.isArray(raw.secrets) ? raw.secrets : [],
        credentials:
          raw.credentials && typeof raw.credentials === 'object' ? raw.credentials : undefined,
        // Platform state. Passed through as-is: a Host that does not send it leaves
        // the field undefined so the section can say "this deployment does not
        // report platforms" rather than drawing an empty list.
        platforms: Array.isArray(raw.platforms) ? raw.platforms : undefined,
        capabilities: raw.capabilities || { settingsService: false, credentialService: false },
      }
    }

    /** Read one secret row by reference. */
    function secretOf(view, ref) {
      return view.secrets.find((row) => row.ref === ref) || null
    }

    /**
     * What the Host says about the credential store, or null on an older Host.
     *
     * The page used to render a badge from `disabled` plus `tail` alone, which
     * cannot tell "not configured" from "not read yet" — the v0.1.10 defect that
     * showed "已配置 · 末四位 —" while the store was still parsing. This is the
     * field that makes the distinction possible; absent means an older Host, and
     * the badge then falls back to the plain configured/unset wording rather
     * than inventing a state.
     */
    function credentialPhaseOf(view) {
      const info = view ? view.credentials : null
      return info && typeof info.phase === 'string' ? info : null
    }

    /**
     * One badge describing the credential phase, or null when it says nothing
     * worth adding to the row.
     *
     * `ready` renders nothing: the existing "已配置 · 末四位 …" badge already
     * says it, and a second green badge would be noise.
     */
    function credentialBadge(t, view) {
      const info = credentialPhaseOf(view)
      if (!info) return null
      const table = {
        loading: { key: 'credLoading', tone: 'dsd-badge-warn' },
        timeout: { key: 'credTimeout', tone: 'dsd-badge-warn' },
        partial: { key: 'credPartial', tone: 'dsd-badge-warn' },
        failed: { key: 'credFailed', tone: 'dsd-badge-bad' },
        unavailable: { key: 'credUnavailable', tone: 'dsd-badge-warn' },
      }
      const entry = table[info.phase]
      if (!entry) return null
      const blocked = info.canPublish === false
      return h(
        'span',
        { className: `dsd-badge ${entry.tone}` },
        blocked ? `${t(entry.key)} · ${t('credBlocked')}` : t(entry.key),
      )
    }

    /** The explanatory line under a badge whose phase needs one. */
    function credentialHint(t, view) {
      const info = credentialPhaseOf(view)
      if (!info) return null
      const table = {
        loading: null,
        timeout: 'credTimeoutHint',
        partial: 'credPartialHint',
        failed: 'credFailedHint',
        unavailable: null,
      }
      const key = table[info.phase]
      if (!key) return null
      const detail = info.error ? ` ${info.error}` : ''
      return h('p', { className: 'dsd-sect-sub' }, `${t(key)}${detail}`)
    }

    /** Format a number for display without inventing precision. */
    function num(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return String(value)
      return String(value)
    }

    // ---------------------------------------------------------------- store

    /**
     * The page's model: the served view plus the user's staged edits.
     *
     * Staging is separate from the served values so a failed save leaves the
     * user's typing intact — the alternative, writing the draft into the store and
     * reverting on failure, loses the draft exactly when the user needs it most.
     */
    class CardStore {
      constructor() {
        this.view = emptyView()
        this.draft = new Map()
        this.tab = 'account'
        this.saving = false
        this.failed = null
        this.notice = null
        this.probes = {}
        this.status = null
        this.previews = null
        this.listeners = new Set()
        this.store = createSnapshotStore(this.projection())
      }

      getSnapshot() {
        return this.store.getSnapshot()
      }

      subscribe(listener) {
        return this.store.subscribe(listener)
      }

      /**
       * The snapshot the page renders from.
       *
       * Every value here must be a plain object, array or primitive. The draft is
       * held in a `Map`, and a `Map` cannot cross this boundary: the Host's
       * `createSnapshotStore` runs each snapshot through Immer, which refuses a
       * bare `Map` unless `enableMapSet()` was called — and it was not. Putting
       * the Map here made every `store.set()` throw `[Immer] minified error nr: 2`,
       * so `edit()` never completed: the value reverted, the "unsaved" badge never
       * appeared and Save stayed disabled. The whole settings form was inert and
       * nothing logged a reason.
       *
       * So the draft is flattened to a count plus a plain field map. Callers that
       * need the live Map keep using the store's own `field()` / `dirty()`.
       */
      projection() {
        const draftFields = {}
        for (const [name, value] of this.draft) draftFields[name] = value
        return {
          view: this.view,
          draftSize: this.draft.size,
          draftFields,
          tab: this.tab,
          saving: this.saving,
          failed: this.failed,
          notice: this.notice,
          probes: this.probes,
          status: this.status,
          previews: this.previews,
        }
      }

      publish() {
        this.store.set(this.projection())
      }

      /** The value a field should display: the staged edit, else the served value. */
      field(name) {
        if (this.draft.has(name)) return this.draft.get(name)
        return this.view.values[name]
      }

      /** Whether a field has an unsaved edit. */
      dirty(name) {
        return this.draft.has(name)
      }

      /** Stage one field edit. */
      edit(name, value) {
        const served = this.view.values[name]
        if (String(served) === String(value)) this.draft.delete(name)
        else this.draft.set(name, value)
        this.failed = null
        this.publish()
      }

      /** Drop one staged edit. */
      resetField(name) {
        this.draft.delete(name)
        this.publish()
      }

      /**
       * Ask whether leaving would lose work, and let the shell decide.
       *
       * The settings shell owns navigation, so the only honest thing this
       * component can do is answer. A `window.confirm` inside a click handler
       * would be exactly the kind of blocking modal that a desktop shell
       * suppresses, and a `beforeunload` listener would fire on a page reload
       * the user did not ask about. So: expose the fact, and let the UI that
       * owns the navigation prompt.
       */
      hasUnsavedChanges() {
        return this.draft.size > 0
      }

      /** Drop every staged edit. */
      discard() {
        if (this.draft.size === 0) return
        this.draft.clear()
        this.failed = null
        this.publish()
      }

      setTab(tab) {
        this.tab = tab
        this.publish()
      }

      setNotice(text) {
        this.notice = text
        this.publish()
      }

      /** Replace the served view, keeping staged edits that still differ. */
      install(view) {
        this.view = view
        // Keep a staged edit only when it still differs from the new served value;
        // otherwise the user is looking at an edit the server already applied.
        for (const [name, value] of [...this.draft.entries()]) {
          if (String(view.values[name]) === String(value)) this.draft.delete(name)
        }
        this.publish()
      }

      /** Load the served view. */
      async load() {
        try {
          this.install(normalizeView(await callJson(ROUTE_SETTINGS)))
        } catch (error) {
          this.view = { ...emptyView(), status: 'unavailable' }
          this.failed = error instanceof Error ? error.message : String(error)
          this.publish()
        }
      }

      /** Save every staged edit in one atomic settings write. */
      async save() {
        if (this.draft.size === 0 || this.saving) return
        this.saving = true
        this.failed = null
        this.notice = null
        this.publish()
        const set = {}
        for (const [name, value] of this.draft.entries()) set[name] = value
        try {
          const next = await callJson(ROUTE_SETTINGS, {
            method: 'POST',
            body: JSON.stringify({ set }),
          })
          this.draft.clear()
          this.install(normalizeView(next))
          this.notice = 'saved'
        } catch (error) {
          this.failed =
            error && error.status === 409 ? 'conflict' : error instanceof Error ? error.message : String(error)
          // A conflict means our revision is behind: reload so the next save is
          // against the current document rather than failing the same way again.
          if (error && error.status === 409) await this.load()
        } finally {
          this.saving = false
          this.publish()
        }
      }

      /**
       * Save one secret.
       *
       * Rejects on failure so the caller can keep the user's text. The old
       * version swallowed the error into `this.failed` and resolved, which is
       * what let the component clear the input on a save that never happened.
       */
      async saveSecret(ref, value) {
        this.failed = null
        this.notice = null
        try {
          const result = await callJson(ROUTE_SECRETS, {
            method: 'POST',
            body: JSON.stringify({ ref, value }),
          })
          if (result && result.view) this.install(normalizeView(result.view))
          this.notice = 'saved'
          this.publish()
        } catch (error) {
          this.failed = error instanceof Error ? error.message : String(error)
          this.publish()
          throw error
        }
      }

      /**
       * Clear one secret.
       *
       * The response is the authority on whether anything was cleared: the
       * route answers 409 with `cleared: false` when there was no store to
       * clear from, and that must not look like success. The view is re-read
       * from the response afterwards, so the badge reflects the store rather
       * than an assumption.
       */
      async clearSecret(ref) {
        this.failed = null
        this.notice = null
        try {
          const result = await callJson(ROUTE_SECRETS, {
            method: 'POST',
            body: JSON.stringify({ ref, clear: true }),
          })
          if (result && result.view) this.install(normalizeView(result.view))
          if (result && result.cleared === false) {
            throw new Error(result.error || dict().clearFailed || 'clear failed')
          }
          this.notice = 'cleared'
          this.publish()
        } catch (error) {
          this.failed = error instanceof Error ? error.message : String(error)
          this.publish()
          throw error
        }
      }

      /**
       * Stop every task that is still running.
       *
       * Distinct from editing `interactionMode`: that stages a config change
       * that only applies on Save, and it does not touch work already in
       * progress. This calls the route and reads back what actually happened,
       * so the page can report a real number instead of implying success.
       */
      async pauseNow() {
        this.probes = { ...this.probes, 'pause-now': { state: 'running' } }
        this.publish()
        try {
          const result = await callJson(ROUTE_ACTION, {
            method: 'POST',
            body: JSON.stringify({ action: 'pause-now' }),
          })
          // The response carries a fresh view; taking it means the badges and
          // session counters below reflect the store, not an assumption.
          if (result && result.view) this.install(normalizeView(result.view))
          this.probes = { ...this.probes, 'pause-now': { state: 'done', result } }
          this.publish()
          return result
        } catch (error) {
          this.probes = {
            ...this.probes,
            'pause-now': { state: 'failed', error: error instanceof Error ? error.message : String(error) },
          }
          this.publish()
          throw error
        }
      }

      /** Run one named probe and keep its result. */
      async probe(action) {        this.probes = { ...this.probes, [action]: { state: 'running' } }
        this.publish()
        try {
          const result = await callJson(ROUTE_ACTION, {
            method: 'POST',
            body: JSON.stringify({ action }),
          })
          this.probes = { ...this.probes, [action]: { state: 'done', result } }
          if (action === 'preview-personas' && result && Array.isArray(result.personas)) {
            this.previews = result.personas
          }
        } catch (error) {
          this.probes = {
            ...this.probes,
            [action]: { state: 'failed', error: error instanceof Error ? error.message : String(error) },
          }
        } finally {
          this.publish()
        }
      }

      /** Refresh the diagnostics block. */
      async refreshStatus() {
        this.probes = { ...this.probes, status: { state: 'running' } }
        this.publish()
        try {
          this.status = await callJson(ROUTE_STATUS)
          this.probes = { ...this.probes, status: { state: 'done' } }
        } catch (error) {
          this.probes = {
            ...this.probes,
            status: { state: 'failed', error: error instanceof Error ? error.message : String(error) },
          }
        } finally {
          this.publish()
        }
      }
    }

    // ----------------------------------------------------------------- styles

    const CARD_CSS =
      '.dsd-card{display:flex;flex-direction:column;gap:0;border:1px solid var(--dsw-alias-border-l2);' +
      'background:var(--dsw-alias-bg-layer-3,var(--dsw-alias-bg-layer-2));border-radius:12px;overflow:hidden}' +
      '.dsd-head{display:flex;align-items:flex-start;gap:10px;padding:14px 16px;border-bottom:1px solid var(--dsw-alias-border-l2)}' +
      '.dsd-head-main{flex:1;min-width:0}' +
      '.dsd-title{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:600;line-height:1.5;margin:0}' +
      '.dsd-desc{color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));font-size:12px;line-height:1.5;margin:2px 0 0}' +
      '.dsd-tabs{display:flex;gap:2px;padding:0 16px;border-bottom:1px solid var(--dsw-alias-border-l2);flex-wrap:wrap}' +
      '.dsd-tab{appearance:none;font:inherit;cursor:pointer;background:transparent;border:0;border-bottom:2px solid transparent;' +
      'color:var(--dsw-alias-label-secondary);padding:9px 10px;font-size:13px;line-height:1.5}' +
      '.dsd-tab:hover{color:var(--dsw-alias-label-primary)}' +
      '.dsd-tab-on{color:var(--dsw-alias-label-primary);border-bottom-color:var(--dsw-alias-brand-primary);font-weight:600}' +
      '.dsd-body{padding:12px 16px 4px;min-height:80px}' +
      '.dsd-field{margin:0 0 14px}' +
      '.dsd-field-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px}' +
      '.dsd-field-label{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:600;line-height:1.5}' +
      '.dsd-field-badges{display:flex;align-items:center;gap:6px;flex:none}' +
      '.dsd-badge{color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));' +
      'background:var(--dsw-alias-bg-module-platform,var(--dsw-alias-bg-layer-1));border-radius:999px;padding:1px 8px;font-size:11px;line-height:17px}' +
      '.dsd-badge-on{color:var(--dsw-alias-brand-primary)}' +
      '.dsd-badge-ok{color:var(--dsw-alias-state-success-primary,var(--dsw-alias-brand-primary))}' +
      '.dsd-badge-warn{color:var(--dsw-alias-state-warning-primary,var(--dsw-alias-label-secondary))}' +
      '.dsd-badge-bad{color:var(--dsw-alias-state-error-primary,var(--dsw-alias-label-secondary))}' +
      '.dsd-block{margin:0 0 16px;padding:12px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px}' +
      '.dsd-reset{appearance:none;font:inherit;cursor:pointer;background:transparent;border:0;padding:0;' +
      'color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));font-size:11px;text-decoration:underline}' +
      '.dsd-input,.dsd-select{width:100%;box-sizing:border-box;font:inherit;font-size:13px;line-height:1.5;padding:6px 10px;' +
      'border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-2);' +
      'color:var(--dsw-alias-label-primary)}' +
      '.dsd-input:focus,.dsd-select:focus{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-1px}' +
      '.dsd-input:disabled,.dsd-select:disabled{opacity:.6;cursor:default}' +
      '.dsd-range-row{display:flex;align-items:center;gap:10px}' +
      '.dsd-range{flex:1;min-width:80px;accent-color:var(--dsw-alias-brand-primary)}' +
      '.dsd-range-number{flex:none;width:72px;box-sizing:border-box;font:inherit;font-size:13px;' +
      'padding:4px 6px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;' +
      'background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}' +
      '.dsd-range-value{flex:none;min-width:46px;text-align:right;font-size:12px;' +
      'color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));' +
      'font-variant-numeric:tabular-nums}' +
      '.dsd-hint{color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));margin:4px 0 0;font-size:12px;line-height:1.5}' +
      '.dsd-hint-error{color:var(--dsw-alias-state-error-primary)}' +
      '.dsd-inline{display:flex;align-items:center;gap:8px;margin-top:6px;flex-wrap:wrap}' +
      '.dsd-sect{margin:0 0 16px;padding:12px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;' +
      'background:var(--dsw-alias-bg-layer-2)}' +
      '.dsd-sect-title{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:600;margin:0 0 2px}' +
      '.dsd-sect-sub{color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));font-size:12px;line-height:1.5;margin:0 0 10px}' +
      '.dsd-foot{display:flex;align-items:center;gap:8px;justify-content:flex-end;padding:12px 16px;' +
      'border-top:1px solid var(--dsw-alias-border-l2);flex-wrap:wrap;row-gap:8px;box-sizing:border-box;' +
      'max-width:100%}' +
      '.dsd-foot-note{flex:1;min-width:0;margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary))}' +
      '.dsd-foot-note-ok{color:var(--dsw-alias-state-success-primary,var(--dsw-alias-brand-primary))}' +
      '.dsd-foot-note-error{color:var(--dsw-alias-state-error-primary)}' +
      '.dsd-btn{appearance:none;font:inherit;cursor:pointer;border:1px solid transparent;border-radius:8px;' +
      'padding:5px 14px;font-size:13px;line-height:1.5;flex:none}' +
      '.dsd-btn:disabled{cursor:default;opacity:.55}' +
      '.dsd-btn-primary{color:#fff;background:var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary))}' +
      '.dsd-btn-ghost{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:transparent}' +
      '.dsd-btn-danger{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-state-error-primary);background:transparent}' +
      '.dsd-preview{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:8px;margin-top:8px}' +
      // The section is dropped into the settings panel at whatever width the
      // window happens to be, including a narrow one on a scaled Windows
      // display. Nothing here may force a horizontal scrollbar.
      '.dsd-section-page{display:flex;flex-direction:column;gap:0;box-sizing:border-box;' +
      'max-width:100%;min-width:0;overflow-x:hidden}' +
      '.dsd-section-page *{box-sizing:border-box;min-width:0}' +
      '.dsd-section-page input,.dsd-section-page select,.dsd-section-page button{max-width:100%}' +
      // Windows display scaling changes the CSS pixel ratio but not the layout;
      // what breaks there is long unbroken text (a base URL, a cookie tail)
      // pushing a flex row wider than the panel.
      '.dsd-field-label,.dsd-hint,.dsd-sect-sub,.dsd-foot-note{overflow-wrap:anywhere}' +
      '.dsd-section-head{margin:0 0 14px}' +
      '.dsd-section-title{margin:0;font-size:18px;font-weight:600;line-height:26px;color:var(--dsw-alias-label-primary)}' +
      '.dsd-section-desc{margin:4px 0 0;font-size:13px;line-height:19px;color:var(--dsw-alias-label-secondary)}' +
      '.dsd-section-body{display:flex;flex-direction:column}' +
      '.dsd-page-sect{margin:0 0 18px;padding:0 0 16px;border-bottom:1px solid var(--dsw-alias-border-l2)}' +
      '.dsd-page-sect:last-child{border-bottom:0}' +
      // A sticky bar floats over the content it is stuck to, so without this the
      // last field (the status block) ended up underneath it — you could scroll
      // to the bottom and still not read it. The padding is on the scroll
      // container, not the bar, because padding on a sticky element is not part
      // of its offset.
      '.dsd-section-body{padding-bottom:72px}' +
      '.dsd-foot-sticky{position:sticky;bottom:0;background:var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-layer-2));' +
      'z-index:2;border-top:1px solid var(--dsw-alias-border-l2);' +
      // Respect the Windows display-scaling setting: the shell is a desktop app
      // and users routinely run at 125%/150%, where a bar sized in raw pixels
      // clips its own buttons.
      'padding:12px 16px calc(12px + env(safe-area-inset-bottom,0px))}' +
      '.dsd-preview-card{border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:9px 10px;' +
      'background:var(--dsw-alias-bg-layer-1)}' +
      '.dsd-preview-name{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary);margin:0}' +
      '.dsd-preview-sum{font-size:11px;line-height:1.5;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));margin:2px 0 6px}' +
      '.dsd-preview-sample{font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary);margin:0}' +
      '.dsd-kv{display:grid;grid-template-columns:auto 1fr;gap:4px 12px;font-size:12px;line-height:1.6;margin:0}' +
      '.dsd-kv dt{color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary))}' +
      '.dsd-kv dd{color:var(--dsw-alias-label-primary);margin:0;word-break:break-all}' +
      '.dsd-errors{list-style:none;margin:6px 0 0;padding:0;font-size:12px;line-height:1.6}' +
      '.dsd-errors li{color:var(--dsw-alias-state-error-primary);padding:3px 0;border-top:1px solid var(--dsw-alias-border-l2)}' +
      '.dsd-errors time{color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));margin-right:6px}' +
      // Notes are informational, not failures. Reusing `dsd-errors` for them painted
      // every prerequisite red, which reads as "something is broken" when it is
      // actually "here is what has to happen first".
      '.dsd-notes{list-style:none;margin:6px 0 0;padding:0;font-size:12px;line-height:1.6}' +
      '.dsd-notes li{color:var(--dsw-alias-label-secondary);padding:3px 0;border-top:1px solid var(--dsw-alias-border-l2)}'

    /** Insert this card's stylesheet once, tagged so a reload can find it. */
    function ensureStyles() {
      if (typeof document === 'undefined') return
      if (document.querySelector('style[data-plugin-css="dsh-ai-debate/card.css"]') !== null) return
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-ai-debate'
      tag.dataset.pluginCss = 'dsh-ai-debate/card.css'
      tag.textContent = CARD_CSS
      document.head.appendChild(tag)
    }

    // ------------------------------------------------------------ components

    /**
     * Is this base URL plaintext HTTP to somewhere other than this machine?
     *
     * The distinction matters because the two cases are not equally dangerous.
     * The API key travels in an `Authorization` header on every request, so an
     * `http://` endpoint anywhere off this machine puts that key in cleartext
     * on the wire. Loopback and private ranges are ordinary development
     * setups — a local llama.cpp server, a company gateway on the LAN — and
     * warning about those would train the owner to dismiss the warning.
     *
     * Returns null for HTTPS (nothing to say) and for anything unparseable
     * (the model probe reports the real error; this must not pre-empt it).
     */
    function httpRiskOf(raw) {
      if (typeof raw !== 'string' || raw.trim() === '') return null
      let url
      try {
        url = new URL(raw.trim())
      } catch {
        return null
      }
      if (url.protocol !== 'http:') return null
      const host = url.hostname.toLowerCase()
      const loopback =
        host === 'localhost' ||
        host === '127.0.0.1' ||
        host === '::1' ||
        host === '[::1]' ||
        host.endsWith('.localhost')
      const isIpv4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(host)
      let privateRange = false
      if (isIpv4) {
        const parts = host.split('.').map(Number)
        privateRange =
          parts[0] === 10 ||
          (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
          (parts[0] === 192 && parts[1] === 168) ||
          (parts[0] === 169 && parts[1] === 254)
      }
      return { host: url.host, local: loopback || privateRange }
    }

    /** One labelled text input with optional badges and a reset action. */
    function Field(props) {
      const { t, state } = props
      const dirty = state.dirty
      return h(
        'div',
        { className: 'dsd-field' },
        h(
          'div',
          { className: 'dsd-field-head' },
          h('label', { className: 'dsd-field-label', htmlFor: props.id }, t(props.label)),
          h(
            'div',
            { className: 'dsd-field-badges' },
            dirty
              ? h('span', { className: 'dsd-badge dsd-badge-warn' }, t('unsaved'))
              : null,
            dirty
              ? h(
                  'button',
                  { type: 'button', className: 'dsd-reset', onClick: props.onReset, disabled: !props.enabled },
                  t('resetDefault'),
                )
              : null,
          ),
        ),
        h('input', {
          id: props.id,
          className: 'dsd-input',
          type: props.numeric ? 'number' : 'text',
          value: state.value === undefined || state.value === null ? '' : String(state.value),
          placeholder: props.placeholder || '',
          disabled: !props.enabled,
          ...(props.numeric && props.min !== undefined ? { min: props.min } : {}),
          ...(props.numeric && props.max !== undefined ? { max: props.max } : {}),
          onChange: (event) => props.onEdit(event.target.value),
        }),
        props.hint ? h('p', { className: 'dsd-hint' }, t(props.hint)) : null,
        props.extra || null,
      )
    }

    /**
     * A slider with its value spelled out, plus a typed box for exact values.
     *
     * `step` defaults to 1 so every existing slider is unchanged. It became
     * configurable because `llmTemperature` is a 0–2 float: with a fixed step
     * of 1 the only reachable values were 0, 1 and 2, so 0.4 — the field's own
     * default — could not be reproduced by hand, and a saved 0.4 rendered as a
     * slider parked on 0.
     *
     * The displayed number is derived from the value that gets saved, at the
     * precision the step implies, so what is shown is what is stored. The
     * rounding is not cosmetic: `0.1 * 3` is `0.30000000000000004` in binary
     * floating point, and saving that either fails a schema check or stores a
     * number nobody typed.
     */
    function RangeField(props) {
      const { t, state } = props
      const step = props.step === undefined ? 1 : Number(props.step)
      const decimals = decimalsFor(step)
      const value = Number(state.value)
      const safe = Number.isFinite(value) ? value : props.min
      const shown = roundTo(safe, decimals)
      return h(
        'div',
        { className: 'dsd-field' },
        h(
          'div',
          { className: 'dsd-field-head' },
          h('label', { className: 'dsd-field-label', htmlFor: props.id }, t(props.label)),
          h(
            'div',
            { className: 'dsd-field-badges' },
            state.dirty ? h('span', { className: 'dsd-badge dsd-badge-warn' }, t('unsaved')) : null,
          ),
        ),
        h(
          'div',
          { className: 'dsd-range-row' },
          h('input', {
            id: props.id,
            className: 'dsd-range',
            type: 'range',
            min: props.min,
            max: props.max,
            step: step,
            value: safe,
            disabled: !props.enabled,
            onChange: (event) => props.onEdit(roundTo(Number(event.target.value), decimals)),
          }),
          // A typed box beside the slider: a range input cannot be nudged to an
          // exact decimal in every browser, and 0.4 has to be reachable. Both
          // controls drive the same staged field.
          h('input', {
            className: 'dsd-range-number',
            type: 'number',
            min: props.min,
            max: props.max,
            step: step,
            value: shown,
            disabled: !props.enabled,
            'aria-label': t(props.label),
            onChange: (event) => {
              const typed = Number(event.target.value)
              if (!Number.isFinite(typed)) return
              const clamped = Math.min(props.max, Math.max(props.min, typed))
              props.onEdit(roundTo(clamped, decimals))
            },
          }),
          h('span', { className: 'dsd-range-value' }, `${shown}/${props.max}`),
        ),
        props.hint ? h('p', { className: 'dsd-hint' }, t(props.hint)) : null,
      )
    }

    /** How many decimal places a slider step implies (1 -> 0, 0.1 -> 1). */
    function decimalsFor(step) {
      if (!Number.isFinite(step) || step <= 0) return 0
      if (Number.isInteger(step)) return 0
      const text = String(step)
      const dot = text.indexOf('.')
      if (dot < 0) return 0
      const tail = text.slice(dot + 1)
      return /e/i.test(tail) ? 10 : tail.length
    }

    /** Round to a fixed number of decimals, dropping binary-fraction noise. */
    function roundTo(value, decimals) {
      if (decimals <= 0) return Math.round(value)
      const factor = 10 ** decimals
      return Math.round(value * factor) / factor
    }

    /** A select over a fixed option list. */
    function SelectField(props) {
      const { t, state } = props
      return h(
        'div',
        { className: 'dsd-field' },
        h(
          'div',
          { className: 'dsd-field-head' },
          h('label', { className: 'dsd-field-label', htmlFor: props.id }, t(props.label)),
          h(
            'div',
            { className: 'dsd-field-badges' },
            state.dirty ? h('span', { className: 'dsd-badge dsd-badge-warn' }, t('unsaved')) : null,
          ),
        ),
        h(
          'select',
          {
            id: props.id,
            className: 'dsd-select',
            value: state.value === undefined || state.value === null ? '' : String(state.value),
            disabled: !props.enabled,
            onChange: (event) => props.onEdit(event.target.value),
          },
          props.options.map((option) =>
            h('option', { key: option.value, value: option.value }, t(option.label)),
          ),
        ),
        props.hint ? h('p', { className: 'dsd-hint' }, t(props.hint)) : null,
      )
    }

    /** A boolean switch rendered as a labelled checkbox row. */
    function BoolField(props) {
      const { t, state } = props
      return h(
        'div',
        { className: 'dsd-field' },
        h(
          'div',
          { className: 'dsd-inline' },
          h('input', {
            id: props.id,
            type: 'checkbox',
            checked: state.value === true || state.value === 'true',
            disabled: !props.enabled,
            onChange: (event) => props.onToggle(event.target.checked),
          }),
          h('label', { className: 'dsd-field-label', htmlFor: props.id }, t(props.label)),
          state.dirty ? h('span', { className: 'dsd-badge dsd-badge-warn' }, t('unsaved')) : null,
        ),
        props.hint ? h('p', { className: 'dsd-hint' }, t(props.hint)) : null,
      )
    }

    /**
     * The credential row: status plus a one-way write path.
     *
     * There is deliberately no "show saved value" affordance — the Host never
     * returns one, and a component that offered to reveal it would be a lie.
     *
     * The input is cleared only after the save *succeeded*. Before v0.1.9 it
     * was cleared unconditionally the moment the button was pressed, so a
     * rejected write (no credential service, a disk error, a 401) silently ate
     * the cookie the user had just pasted — leaving them to find the value
     * again in their browser. A failed save now keeps the text and says why.
     */
    function SecretField(props) {
      // NB: the prop is `secretRef`, not `ref`. `ref` is reserved by React —
      // handing a function component a string `ref` throws outright, which is
      // what blanked this page. Nothing here needs a DOM ref.
      const { t, secret, secretRef: refName, label, hint, placeholder, saveLabel, onSave, onClear, enabled, view } = props
      const [text, setText] = useState('')
      const [confirming, setConfirming] = useState(false)
      const [busy, setBusy] = useState(false)
      const [failure, setFailure] = useState(null)
      const configured = secret && secret.configured === true
      const writable = secret ? secret.writable !== false : false
      const ready = enabled && writable && !busy

      const submit = () => {
        if (busy || text.trim() === '') return
        setBusy(true)
        setFailure(null)
        Promise.resolve(onSave(refName, text)).then(
          () => {
            // Only a fulfilled save clears the field.
            setText('')
            setBusy(false)
          },
          (error) => {
            setFailure(error instanceof Error ? error.message : String(error))
            setBusy(false)
          },
        )
      }

      return h(
        'div',
        { className: 'dsd-sect' },
        h('p', { className: 'dsd-sect-title' }, label),
        credentialHint(t, view),
        h('p', { className: 'dsd-sect-sub' }, hint),
        h(
          'div',
          { className: 'dsd-inline', style: { marginTop: 0, marginBottom: 8 } },
          h(
            'span',
            { className: `dsd-badge${configured ? ' dsd-badge-on' : ''}` },
            configured ? `${t('cookieConfigured')} · ${t('cookieTail')} ${secret.tail || '—'}` : t('cookieUnset'),
          ),
          secret && secret.fromConfigFallback
            ? h('span', { className: 'dsd-badge dsd-badge-warn' }, t('cookieFromConfig'))
            : null,
          secret && secret.configSuperseded
            ? h('span', { className: 'dsd-badge dsd-badge-warn' }, t('cookieSuperseded'))
            : null,
          credentialBadge(t, view),
        ),
        h('input', {
          className: 'dsd-input',
          type: 'password',
          autoComplete: 'off',
          spellCheck: false,
          placeholder: placeholder || t('newCookie'),
          value: text,
          disabled: !ready,
          onChange: (event) => setText(event.target.value),
        }),
        h('p', { className: 'dsd-hint' }, t('newCookieHint')),
        failure === null
          ? null
          : h('p', { className: 'dsd-hint dsd-hint-error', role: 'alert' }, `${t('saveFailed')}：${failure}`),
        h(
          'div',
          { className: 'dsd-inline' },
          h(
            'button',
            {
              type: 'button',
              className: 'dsd-btn dsd-btn-primary',
              disabled: !ready || text.trim() === '',
              onClick: submit,
            },
            busy ? t('saving') : saveLabel || t('saveCookie'),
          ),
          confirming
            ? h(
                Fragment,
                null,
                // The confirmation is a distinct second step, not a toggle on
                // the same button: clearing a credential cannot be undone and
                // the value is not recoverable from this page.
                h('span', { className: 'dsd-hint dsd-hint-error' }, t('clearConfirm')),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsd-btn dsd-btn-danger',
                    disabled: !ready,
                    onClick: () => {
                      setConfirming(false)
                      void Promise.resolve(onClear(refName)).catch((error) => {
                        setFailure(error instanceof Error ? error.message : String(error))
                      })
                    },
                  },
                  t('clearCookie'),
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsd-btn dsd-btn-ghost',
                    onClick: () => setConfirming(false),
                  },
                  t('cancel'),
                ),
              )
            : h(
                'button',
                {
                  type: 'button',
                  className: 'dsd-btn dsd-btn-ghost',
                  disabled: !ready || !configured,
                  onClick: () => {
                    setFailure(null)
                    setConfirming(true)
                  },
                },
                t('clearCookie'),
              ),
        ),
      )
    }

    // --------------------------------------------------------------- sections

    function AccountSection(props) {
      const { t, store, state } = props
      const enabled = state.view.writable && !state.saving
      const cookie = secretOf(state.view, REF_COOKIE)
      const loginProbe = state.probes['check-login']
      const aiId = store.field('aiAccountUserId')
      const loginUser = loginProbe && loginProbe.result ? loginProbe.result.userId : undefined
      const mismatch = Boolean(aiId) && Boolean(loginUser) && String(aiId) !== String(loginUser)

      return h(
        Fragment,
        null,
        h(Field, {
          id: 'dsd-owner-id',
          t,
          label: 'ownerUserId',
          hint: 'ownerUserIdHint',
          numeric: true,
          enabled,
          state: { value: store.field('ownerUserId'), dirty: store.dirty('ownerUserId') },
          onEdit: (value) => store.edit('ownerUserId', value),
          onReset: () => store.resetField('ownerUserId'),
        }),
        h(Field, {
          id: 'dsd-owner-name',
          t,
          label: 'ownerUserName',
          hint: 'ownerUserNameHint',
          enabled,
          state: { value: store.field('ownerUserName'), dirty: store.dirty('ownerUserName') },
          onEdit: (value) => store.edit('ownerUserName', value),
          onReset: () => store.resetField('ownerUserName'),
        }),
        h(Field, {
          id: 'dsd-ai-id',
          t,
          label: 'aiAccountUserId',
          hint: 'aiAccountUserIdHint',
          numeric: true,
          enabled,
          state: { value: store.field('aiAccountUserId'), dirty: store.dirty('aiAccountUserId') },
          onEdit: (value) => store.edit('aiAccountUserId', value),
          onReset: () => store.resetField('aiAccountUserId'),
        }),
        h(Field, {
          id: 'dsd-ai-name',
          t,
          label: 'aiAccountName',
          hint: 'aiAccountNameHint',
          enabled,
          state: { value: store.field('aiAccountName'), dirty: store.dirty('aiAccountName') },
          onEdit: (value) => store.edit('aiAccountName', value),
          onReset: () => store.resetField('aiAccountName'),
        }),
        h(Field, {
          id: 'dsd-allowed',
          t,
          label: 'allowedOwnerIds',
          hint: 'allowedOwnerIdsHint',
          enabled,
          state: { value: store.field('allowedOwnerIds'), dirty: store.dirty('allowedOwnerIds') },
          onEdit: (value) => store.edit('allowedOwnerIds', value),
          onReset: () => store.resetField('allowedOwnerIds'),
        }),
        h(SecretField, {
          t,
          secretRef: REF_COOKIE,
          label: t('cookieTitle'),
          hint: t('cookieHint'),
          secret: cookie,
          view: state.view,
          enabled,
          onSave: (refName, value) => store.saveSecret(refName, value),
          onClear: (refName) => store.clearSecret(refName),
        }),
        h(
          'div',
          { className: 'dsd-inline', style: { marginBottom: 12 } },
          h(
            'button',
            {
              type: 'button',
              className: 'dsd-btn dsd-btn-ghost',
              disabled: loginProbe && loginProbe.state === 'running',
              onClick: () => store.probe('check-login'),
            },
            loginProbe && loginProbe.state === 'running' ? t('checking') : t('checkLogin'),
          ),
        ),
        loginProbe && loginProbe.state === 'failed'
          ? h('p', { className: 'dsd-hint dsd-hint-error' }, loginProbe.error)
          : null,
        loginProbe && loginProbe.state === 'done' && loginProbe.result
          ? h(
              'p',
              {
                className: `dsd-hint${loginProbe.result.ok ? '' : ' dsd-hint-error'}`,
                role: 'status',
              },
              `${loginProbe.result.authenticated ? t('loginOk') : t('loginFail')} — ${loginProbe.result.message}`,
            )
          : null,
        mismatch ? h('p', { className: 'dsd-hint dsd-hint-error' }, t('identityMismatch')) : null,
      )
    }

    function ModelSection(props) {
      const { t, store, state } = props
      const enabled = state.view.writable && !state.saving
      const key = secretOf(state.view, REF_LLM_KEY)
      const probe = state.probes['test-llm']
      const baseRisk = httpRiskOf(store.field('llmBaseUrl'))

      return h(
        Fragment,
        null,
        h(Field, {
          id: 'dsd-llm-base',
          t,
          label: 'llmBaseUrl',
          hint: 'llmBaseUrlHint',
          enabled,
          state: { value: store.field('llmBaseUrl'), dirty: store.dirty('llmBaseUrl') },
          onEdit: (value) => store.edit('llmBaseUrl', value),
          onReset: () => store.resetField('llmBaseUrl'),
        }),
        // Warn, never rewrite: silently upgrading the scheme would break a
        // local server and would also hide the fact that the configured URL
        // was not what got used.
        baseRisk !== null && !baseRisk.local
          ? h('p', { className: 'dsd-hint dsd-hint-error', role: 'alert' }, format(t('httpWarn'), { host: baseRisk.host }))
          : null,
        baseRisk !== null && baseRisk.local
          ? h('p', { className: 'dsd-hint' }, t('httpLocalNote'))
          : null,
        h(Field, {
          id: 'dsd-llm-model',
          t,
          label: 'llmModel',
          hint: 'llmModelHint',
          enabled,
          state: { value: store.field('llmModel'), dirty: store.dirty('llmModel') },
          onEdit: (value) => store.edit('llmModel', value),
          onReset: () => store.resetField('llmModel'),
        }),
        h(SecretField, {
          t,
          secretRef: REF_LLM_KEY,
          label: t('llmApiKeyTitle'),
          hint: t('llmApiKeyHint'),
          // Its own placeholder and button label: both credential rows used to
          // say "paste a new cookie" / "save credential", so the API-key row
          // looked like it wanted a Tieba cookie.
          placeholder: t('newLlmKey'),
          saveLabel: t('saveLlmKey'),
          secret: key,
          view: state.view,
          enabled,
          onSave: (refName, value) => store.saveSecret(refName, value),
          onClear: (refName) => store.clearSecret(refName),
        }),
        h(RangeField, {
          id: 'dsd-temp',
          t,
          label: 'llmTemperature',
          hint: 'llmTemperatureHint',
          min: 0,
          max: 2,
          // Temperature is a float. With the old fixed step of 1 the slider
          // could only produce 0, 1 or 2, so 0.4 (the default) was unreachable
          // and a saved 0.4 displayed as 0.
          step: 0.1,
          enabled,
          state: { value: store.field('llmTemperature'), dirty: store.dirty('llmTemperature') },
          onEdit: (value) => store.edit('llmTemperature', value),
        }),
        h(Field, {
          id: 'dsd-max-tokens',
          t,
          label: 'llmMaxOutputTokens',
          hint: 'llmMaxOutputTokensHint',
          numeric: true,
          min: 0,
          enabled,
          state: { value: store.field('llmMaxOutputTokens'), dirty: store.dirty('llmMaxOutputTokens') },
          onEdit: (value) => store.edit('llmMaxOutputTokens', value),
          onReset: () => store.resetField('llmMaxOutputTokens'),
        }),
        h(Field, {
          id: 'dsd-timeout',
          t,
          label: 'llmTimeoutMs',
          numeric: true,
          min: 1000,
          enabled,
          state: { value: store.field('llmTimeoutMs'), dirty: store.dirty('llmTimeoutMs') },
          onEdit: (value) => store.edit('llmTimeoutMs', value),
          onReset: () => store.resetField('llmTimeoutMs'),
        }),
        h(SelectField, {
          id: 'dsd-preset',
          t,
          label: 'contextPreset',
          hint: 'contextPresetHint',
          enabled,
          options: [
            { value: 'small', label: 'small' },
            { value: 'medium', label: 'medium' },
            { value: 'large', label: 'large' },
          ],
          state: { value: store.field('contextPreset'), dirty: store.dirty('contextPreset') },
          onEdit: (value) => store.edit('contextPreset', value),
        }),
        h(Field, {
          id: 'dsd-context-tokens',
          t,
          label: 'contextTokens',
          hint: 'contextTokensHint',
          numeric: true,
          min: 0,
          enabled,
          state: { value: store.field('contextTokens'), dirty: store.dirty('contextTokens') },
          onEdit: (value) => store.edit('contextTokens', value),
          onReset: () => store.resetField('contextTokens'),
        }),
        h(
          'div',
          { className: 'dsd-inline', style: { marginBottom: 12 } },
          h(
            'button',
            {
              type: 'button',
              className: 'dsd-btn dsd-btn-ghost',
              disabled: probe && probe.state === 'running',
              onClick: () => store.probe('test-llm'),
            },
            probe && probe.state === 'running' ? t('testing') : t('testModel'),
          ),
        ),
        probe && probe.state === 'failed'
          ? h('p', { className: 'dsd-hint dsd-hint-error' }, probe.error)
          : null,
        probe && probe.state === 'done' && probe.result
          ? h(
              'p',
              { className: `dsd-hint${probe.result.ok ? '' : ' dsd-hint-error'}`, role: 'status' },
              probe.result.message +
                (probe.result.sample ? `（返回：${probe.result.sample}）` : ''),
            )
          : null,
      )
    }

    function PersonaSection(props) {
      const { t, store, state } = props
      const enabled = state.view.writable && !state.saving
      const probe = state.probes['preview-personas']

      return h(
        Fragment,
        null,
        h(SelectField, {
          id: 'dsd-persona',
          t,
          label: 'personaStyle',
          enabled,
          options: [
            { value: 'tieba_veteran', label: '贴吧老哥' },
            { value: 'soft_defensive', label: '小受' },
            { value: 'tsundere', label: '傲娇' },
            { value: 'aloof', label: '高冷' },
          ],
          state: { value: store.field('personaStyle'), dirty: store.dirty('personaStyle') },
          onEdit: (value) => store.edit('personaStyle', value),
        }),
        h(RangeField, {
          id: 'dsd-intensity',
          t,
          label: 'intensity',
          min: 1,
          max: 5,
          enabled,
          state: { value: store.field('intensity'), dirty: store.dirty('intensity') },
          onEdit: (value) => store.edit('intensity', value),
        }),
        h(RangeField, {
          id: 'dsd-length',
          t,
          label: 'maxLength',
          min: 20,
          max: 600,
          enabled,
          state: { value: store.field('maxLength'), dirty: store.dirty('maxLength') },
          onEdit: (value) => store.edit('maxLength', value),
        }),
        h(RangeField, {
          id: 'dsd-emoji',
          t,
          label: 'emojiLevel',
          min: 0,
          max: 3,
          enabled,
          state: { value: store.field('emojiLevel'), dirty: store.dirty('emojiLevel') },
          onEdit: (value) => store.edit('emojiLevel', value),
        }),
        h(RangeField, {
          id: 'dsd-sarcasm',
          t,
          label: 'sarcasmLevel',
          min: 0,
          max: 3,
          enabled,
          state: { value: store.field('sarcasmLevel'), dirty: store.dirty('sarcasmLevel') },
          onEdit: (value) => store.edit('sarcasmLevel', value),
        }),
        h(RangeField, {
          id: 'dsd-direct',
          t,
          label: 'directness',
          min: 1,
          max: 5,
          enabled,
          state: { value: store.field('directness'), dirty: store.dirty('directness') },
          onEdit: (value) => store.edit('directness', value),
        }),
        h(
          'div',
          { className: 'dsd-inline', style: { marginBottom: 8 } },
          h(
            'button',
            {
              type: 'button',
              className: 'dsd-btn dsd-btn-ghost',
              disabled: probe && probe.state === 'running',
              onClick: () => store.probe('preview-personas'),
            },
            probe && probe.state === 'running' ? t('previewLoading') : t('previewPersonas'),
          ),
        ),
        h('p', { className: 'dsd-hint' }, t('previewHint')),
        state.previews && state.previews.length > 0
          ? h(
              'div',
              { className: 'dsd-preview' },
              state.previews.map((persona) =>
                h(
                  'div',
                  { key: persona.style, className: 'dsd-preview-card' },
                  h('p', { className: 'dsd-preview-name' }, persona.name),
                  h('p', { className: 'dsd-preview-sum' }, persona.summary),
                  h('p', { className: 'dsd-preview-sample' }, persona.sample),
                ),
              ),
            )
          : null,
      )
    }

    /**
     * What "stop everything now" actually managed to do.
     *
     * Reported as three separate facts on purpose. "Paused" alone would be a
     * half-truth: some sessions are unstoppable (the reply is already out), and
     * a page that showed a green badge over that would teach the owner to trust
     * a stop that did not happen.
     */
    function PauseReport(props) {
      const { t, result } = props
      const stopped = Array.isArray(result.stopped) ? result.stopped.length : 0
      const refused = Array.isArray(result.refused) ? result.refused : []
      const published = Number(result.alreadyPublished) || 0
      const aborted = Number(result.abortedInFlight) || 0
      return h(
        'div',
        { role: 'status' },
        h(
          'p',
          { className: 'dsd-hint' },
          stopped === 0
            ? t('pausedNothing')
            : format(t('pausedSome'), { stopped: String(stopped), aborted: String(aborted) }),
        ),
        refused.length > 0
          ? h(
              'p',
              { className: 'dsd-hint dsd-hint-error' },
              format(t('pausedRefused'), { count: String(refused.length) }),
            )
          : null,
        published > 0
          ? h('p', { className: 'dsd-hint dsd-hint-error' }, format(t('pausedPublished'), { count: String(published) }))
          : null,
      )
    }

    function PublishSection(props) {
      const { t, store, state } = props
      const enabled = state.view.writable && !state.saving
      const status = state.status
      // Local, not in the store: this is a one-shot outcome of a single click,
      // and putting it in the shared snapshot would make it survive a reload
      // that no longer reflects what happened.
      const [pausing, setPausing] = useState(false)
      const [pauseResult, setPauseResult] = useState(null)

      return h(
        Fragment,
        null,
        h(BoolField, {
          id: 'dsd-enabled',
          t,
          label: 'enabled',
          hint: 'enabledHint',
          enabled,
          state: { value: store.field('enabled'), dirty: store.dirty('enabled') },
          onToggle: (value) => store.edit('enabled', value),
        }),
        h(SelectField, {
          id: 'dsd-mode',
          t,
          label: 'interactionMode',
          hint: 'interactionModeHint',
          enabled,
          options: [
            { value: 'manual', label: 'manual（人工审核）' },
            { value: 'single_shot', label: 'single_shot（单次授权）' },
            { value: 'limited_auto', label: 'limited_auto（有限自动）' },
          ],
          state: { value: store.field('interactionMode'), dirty: store.dirty('interactionMode') },
          onEdit: (value) => store.edit('interactionMode', value),
        }),
        h(RangeField, {
          id: 'dsd-auto',
          t,
          label: 'maxAutoPerSession',
          min: 0,
          max: 50,
          enabled,
          state: { value: store.field('maxAutoPerSession'), dirty: store.dirty('maxAutoPerSession') },
          onEdit: (value) => store.edit('maxAutoPerSession', value),
        }),
        h(RangeField, {
          id: 'dsd-cooldown',
          t,
          label: 'cooldownSeconds',
          min: 0,
          max: 3600,
          enabled,
          state: { value: store.field('cooldownSeconds'), dirty: store.dirty('cooldownSeconds') },
          onEdit: (value) => store.edit('cooldownSeconds', value),
        }),
        h(RangeField, {
          id: 'dsd-per-thread',
          t,
          label: 'maxPerThread',
          min: 1,
          max: 100,
          enabled,
          state: { value: store.field('maxPerThread'), dirty: store.dirty('maxPerThread') },
          onEdit: (value) => store.edit('maxPerThread', value),
        }),
        h(BoolField, {
          id: 'dsd-announce',
          t,
          label: 'announceToAgent',
          enabled,
          state: { value: store.field('announceToAgent'), dirty: store.dirty('announceToAgent') },
          onToggle: (value) => store.edit('announceToAgent', value),
        }),
        h(
          'div',
          { className: 'dsd-sect' },
          h('p', { className: 'dsd-sect-title' }, t('autoOffTitle')),
          h('p', { className: 'dsd-sect-sub' }, t('autoOffHint')),
          h(
            'div',
            { className: 'dsd-inline', style: { marginTop: 0 } },
            h(
              'button',
              {
                type: 'button',
                className: 'dsd-btn dsd-btn-ghost',
                // Not a danger action: it edits two fields and nothing happens
                // until Save. The dangerous-looking button belongs to the real
                // stop below, and the two used to be indistinguishable.
                disabled: !enabled,
                onClick: () => {
                  store.edit('interactionMode', 'manual')
                  store.edit('maxAutoPerSession', 0)
                },
              },
              t('autoOffTitle'),
            ),
          ),
        ),
        h(
          'div',
          { className: 'dsd-sect' },
          h('p', { className: 'dsd-sect-title' }, t('pauseNowTitle')),
          h('p', { className: 'dsd-sect-sub' }, t('pauseNowHint')),
          h(
            'div',
            { className: 'dsd-inline', style: { marginTop: 0 } },
            h(
              'button',
              {
                type: 'button',
                className: 'dsd-btn dsd-btn-danger',
                disabled: !enabled || pausing,
                onClick: () => {
                  setPausing(true)
                  setPauseResult(null)
                  Promise.resolve(store.pauseNow()).then(
                    (result) => {
                      setPauseResult(result || {})
                      setPausing(false)
                    },
                    () => setPausing(false),
                  )
                },
              },
              pausing ? t('pausing') : t('pauseNow'),
            ),
          ),
          pauseResult === null ? null : h(PauseReport, { t, result: pauseResult }),
          state.probes['pause-now'] && state.probes['pause-now'].state === 'failed'
            ? h('p', { className: 'dsd-hint dsd-hint-error', role: 'alert' }, state.probes['pause-now'].error)
            : null,
        ),
        h(
          'div',
          { className: 'dsd-sect' },
          h('p', { className: 'dsd-sect-title' }, t('history')),
          h(
            'div',
            { className: 'dsd-inline', style: { marginTop: 0, marginBottom: 8 } },
            h(
              'button',
              {
                type: 'button',
                className: 'dsd-btn dsd-btn-ghost',
                disabled: state.probes.status && state.probes.status.state === 'running',
                onClick: () => store.refreshStatus(),
              },
              state.probes.status && state.probes.status.state === 'running' ? t('refreshing') : t('refresh'),
            ),
          ),
          status
            ? h('p', { className: 'dsd-hint' }, format(t('ledgerDetail'), status.publishLedger))
            : h('p', { className: 'dsd-hint' }, t('recordsNotLoading')),
          status && status.publishLedger.overCapacity
            ? h('p', { className: 'dsd-hint dsd-hint-error' }, t('ledgerOver'))
            : null,
          status
            ? h('p', { className: 'dsd-hint' }, `${t('pendingRecords')} — ${status.publishLedger.pending}`)
            : null,
        ),
      )
    }

    /**
     * Strip the light Markdown the manifests use, since this page renders text.
     *
     * The manifests are written as prose with `**emphasis**` because they are also
     * read as source. Rendering them raw put literal asterisks on screen, which
     * looks like a bug rather than emphasis — so the markers are removed and the
     * sentence is shown plainly. Only `**`/`__` are handled: no attempt is made to
     * parse links, lists or code, because none of the manifests use them.
     */
    function plainText(value) {
      return String(value)
        .replace(/\*\*(.+?)\*\*/g, '$1')
        .replace(/__(.+?)__/g, '$1')
    }

    /**
     * The platforms section.
     *
     * Renders whatever `view.platforms` carries. The page makes no judgement of
     * its own: whether a platform is implemented is a field the Host sends, and a
     * plan is drawn under a heading that says "planned". A section that decided
     * for itself which platforms are real would be the exact failure this version
     * is meant to prevent.
     */
    function PlatformsSection(props) {
      const { t, state } = props
      const rows = state.view.platforms

      if (!Array.isArray(rows)) {
        // An older Host that does not send the field. Say so instead of drawing an
        // empty list, which would read as "there are no platforms".
        return h('p', { className: 'dsd-hint' }, t('platformsNoManifest'))
      }
      if (rows.length === 0) {
        return h('p', { className: 'dsd-hint' }, t('platformsNoManifest'))
      }

      const stateLabel = (value) => {
        const table = {
          supported: 'capSupported',
          unverified: 'capUnverified',
          permission_required: 'capPermission',
          degraded: 'capDegraded',
          unavailable: 'capUnavailable',
        }
        return t(table[value] || 'capUnavailable')
      }
      const researchLabel = (value) => {
        const table = {
          survey: 'researchSurvey',
          documented: 'researchDocumented',
          credentialed: 'researchCredentialed',
          'read-verified': 'researchRead',
          'write-verified': 'researchWrite',
        }
        return table[value] ? t(table[value]) : value
      }
      const capLabel = (name) => {
        const key = `capabilityName_${String(name).replace(/\./g, '_')}`
        const translated = t(key)
        // The translator returns the key itself when it has no entry, so a new
        // capability shows its raw name rather than an empty cell.
        return translated === key ? name : translated
      }
      const toneOf = (value) => {
        if (value === 'supported') return 'dsd-badge-ok'
        if (value === 'unavailable') return 'dsd-badge-bad'
        return 'dsd-badge-warn'
      }

      return h(
        Fragment,
        null,
        h('p', { className: 'dsd-hint', style: { marginBottom: 12 } }, t('platformsIntro')),
        rows.map((row) =>
          h(
            'div',
            { key: row.id, className: 'dsd-block' },
            h(
              'div',
              { className: 'dsd-inline', style: { alignItems: 'baseline', gap: 8, flexWrap: 'wrap' } },
              h('span', { className: 'dsd-sect-title', style: { margin: 0 } }, row.displayName),
              h(
                'span',
                {
                  className:
                    'dsd-badge ' + (row.implemented ? 'dsd-badge-ok' : 'dsd-badge-warn'),
                },
                t(row.implemented ? 'platformsImplemented' : 'platformsPlanned'),
              ),
              row.active
                ? h('span', { className: 'dsd-badge dsd-badge-ok' }, t('platformsActive'))
                : null,
              row.research
                ? h('span', { className: 'dsd-badge' }, `${t('platformsResearch')}：${researchLabel(row.research)}`)
                : null,
            ),
            row.authModel
              ? h('p', { className: 'dsd-hint' }, `${t('platformsAuth')}：${row.authModel}`)
              : null,
            row.urlShapes && row.urlShapes.length > 0
              ? h(
                  'p',
                  { className: 'dsd-hint' },
                  `${t('platformsUrls')}：` + row.urlShapes.join(' · '),
                )
              : null,
            h('p', { className: 'dsd-sect-title', style: { marginTop: 10 } }, t('platformsCapsTitle')),
            h(
              'dl',
              { className: 'dsd-kv' },
              row.capabilities.map((cap) => [
                h('dt', { key: `${cap.name}-t` }, `${cap.mark} ${capLabel(cap.name)}`),
                h(
                  'dd',
                  { key: `${cap.name}-d` },
                  h('span', { className: `dsd-badge ${toneOf(cap.state)}` }, stateLabel(cap.state)),
                  ' ',
                  plainText(cap.reason),
                  cap.limits && cap.limits.length > 0
                    ? h('span', { className: 'dsd-hint' }, ` ${t('capLimits')}：${cap.limits.map(plainText).join('；')}`)
                    : null,
                  cap.requiredPermissions && cap.requiredPermissions.length > 0
                    ? h(
                        'span',
                        { className: 'dsd-hint' },
                        ` ${t('capNeeds')}：${cap.requiredPermissions.join(', ')}`,
                      )
                    : null,
                  cap.lastVerifiedAt
                    ? h('span', { className: 'dsd-hint' }, ` ${t('capVerifiedAt')}：${cap.lastVerifiedAt}`)
                    : null,
                ),
              ]),
            ),
            row.prerequisites && row.prerequisites.length > 0
              ? h(
                  'div',
                  null,
                  h('p', { className: 'dsd-sect-title', style: { marginTop: 10 } }, t('platformsPrereq')),
                  h('ul', { className: 'dsd-notes' }, row.prerequisites.map((line, index) => h('li', { key: index }, plainText(line)))),
                )
              : null,
            row.constraints && row.constraints.length > 0
              ? h(
                  'div',
                  null,
                  h('p', { className: 'dsd-sect-title', style: { marginTop: 10 } }, t('platformsConstraints')),
                  h('ul', { className: 'dsd-notes' }, row.constraints.map((line, index) => h('li', { key: index }, plainText(line)))),
                )
              : null,
          ),
        ),
      )
    }

    function StatusSection(props) {
      const { t, state } = props
      const status = state.status
      const probe = state.probes.status

      if (status === null) {
        return h(
          'div',
          null,
          h(
            'div',
            { className: 'dsd-inline', style: { marginBottom: 8 } },
            h(
              'button',
              {
                type: 'button',
                className: 'dsd-btn dsd-btn-ghost',
                disabled: probe && probe.state === 'running',
                onClick: () => props.store.refreshStatus(),
              },
              probe && probe.state === 'running' ? t('refreshing') : t('refresh'),
            ),
          ),
          probe && probe.state === 'failed' ? h('p', { className: 'dsd-hint dsd-hint-error' }, probe.error) : null,
        )
      }

      return h(
        Fragment,
        null,
        h(
          'div',
          { className: 'dsd-inline', style: { marginBottom: 10 } },
          h(
            'button',
            {
              type: 'button',
              className: 'dsd-btn dsd-btn-ghost',
              disabled: probe && probe.state === 'running',
              onClick: () => props.store.refreshStatus(),
            },
            probe && probe.state === 'running' ? t('refreshing') : t('refresh'),
          ),
        ),
        h(
          'dl',
          { className: 'dsd-kv' },
          h('dt', null, t('statusTitle')),
          h('dd', null, status.enabled ? 'enabled' : 'disabled'),
          h('dt', null, t('dshVersion')),
          h('dd', null, status.dshVersion || '—'),
          h('dt', null, t('pluginVersion')),
          h('dd', null, status.pluginVersion),
          h('dt', null, t('storePath')),
          h('dd', null, status.storePath),
          h('dt', null, t('sessions')),
          h('dd', null, format(t('sessionsDetail'), status.sessions)),
          h('dt', null, t('ledger')),
          h('dd', null, format(t('ledgerDetail'), status.publishLedger)),
          h('dt', null, t('usage')),
          h('dd', null, format(t('usageDetail'), status.usage)),
          h('dt', null, t('rateLimit')),
          h('dd', null, status.rateLimit.note),
        ),
        h('p', { className: 'dsd-sect-title', style: { marginTop: 14 } }, t('recentErrors')),
        status.recentErrors && status.recentErrors.length > 0
          ? h(
              'ul',
              { className: 'dsd-errors' },
              status.recentErrors.map((row, index) =>
                h('li', { key: `${row.at}-${index}` }, h('time', null, row.at), row.message),
              ),
            )
          : h('p', { className: 'dsd-hint' }, t('errorsEmpty')),
      )
    }

    // -------------------------------------------------------------------- card

    /** The full configuration page. */
    function DebateCard(props) {
      // The row's page also renders this component without the registration's
      // inject face, so it reads the shared store the same way the settings
      // section does. `props.inject` faces cannot be relied on here either —
      // depending on them produced a page with a title and an empty body.
      const t = typeof props.t === 'function' ? props.t : translator()
      // The Plugins page asks for `summary` when the row's own page has no
      // package description to show; the config page itself gets `page`.
      if (props.view === 'summary') return h('span', null, t('description'))
      const store = storeForSection()
      const state = useSectionState(store)

      const body = (() => {
        if (state.view.status === 'loading') return h('p', { className: 'dsd-hint' }, t('loading'))
        if (state.view.status === 'unavailable') {
          return h(
            'div',
            null,
            h('p', { className: 'dsd-hint dsd-hint-error' }, state.failed || t('unavailable')),
            h(
              'button',
              { type: 'button', className: 'dsd-btn dsd-btn-ghost', onClick: () => store.load() },
              t('retry'),
            ),
          )
        }
        const shared = { t, store, state }
        if (state.tab === 'model') return h(ModelSection, shared)
        if (state.tab === 'persona') return h(PersonaSection, shared)
        if (state.tab === 'publish') return h(PublishSection, shared)
        if (state.tab === 'platforms') return h(PlatformsSection, shared)
        if (state.tab === 'status') return h(StatusSection, shared)
        return h(AccountSection, shared)
      })()

      const note = (() => {
        if (state.saving) return { text: t('saving'), cls: '' }
        if (state.failed === 'conflict') return { text: t('conflict'), cls: ' dsd-foot-note-error' }
        if (state.failed) return { text: `${t('saveFailed')}：${state.failed}`, cls: ' dsd-foot-note-error' }
        if (state.notice === 'saved') return { text: t('saved'), cls: ' dsd-foot-note-ok' }
        if (state.notice === 'cleared') return { text: t('cleared'), cls: ' dsd-foot-note-ok' }
        if (state.draftSize > 0) return { text: t('unsaved'), cls: '' }
        if (!state.view.writable) return { text: t('readOnly'), cls: '' }
        if (!state.view.capabilities.credentialService) return { text: t('noCredentialService'), cls: '' }
        return { text: '', cls: '' }
      })()

      let inner
      try {
        inner = renderCardBody(t, store, state, body)
      } catch (error) {
        return h('pre', { style: { padding: '12px', whiteSpace: 'pre-wrap', fontSize: '12px' } }, 'CARD-RENDER-ERROR:\n' + (error && error.stack ? error.stack : String(error)))
      }
      return inner
    }

    /** The card body, kept separate so the wrapper can trap its failures. */
    function renderCardBody(t, store, state, body) {
      const note = (() => {
        if (state.saving) return { text: t('saving'), cls: '' }
        if (state.failed === 'conflict') return { text: t('conflict'), cls: ' dsd-foot-note-error' }
        if (state.failed) return { text: `${t('saveFailed')}：${state.failed}`, cls: ' dsd-foot-note-error' }
        if (state.notice === 'saved') return { text: t('saved'), cls: ' dsd-foot-note-ok' }
        if (state.notice === 'cleared') return { text: t('cleared'), cls: ' dsd-foot-note-ok' }
        if (state.draftSize > 0) return { text: t('unsaved'), cls: '' }
        if (!state.view.writable) return { text: t('readOnly'), cls: '' }
        if (!state.view.capabilities.credentialService) return { text: t('noCredentialService'), cls: '' }
        return { text: '', cls: '' }
      })()

      return h(
        'div',
        { className: 'dsd-card' },
        h(
          'div',
          { className: 'dsd-head' },
          h(
            'div',
            { className: 'dsd-head-main' },
            h('p', { className: 'dsd-title' }, t('title')),
            h('p', { className: 'dsd-desc' }, t('description')),
          ),
        ),
        h(
          'div',
          { className: 'dsd-tabs', role: 'tablist' },
          TABS.map((tab) =>
            h(
              'button',
              {
                key: tab.id,
                type: 'button',
                role: 'tab',
                'aria-selected': state.tab === tab.id,
                className: `dsd-tab${state.tab === tab.id ? ' dsd-tab-on' : ''}`,
                onClick: () => store.setTab(tab.id),
              },
              t(tab.label),
            ),
          ),
        ),
        h('div', { className: 'dsd-body', role: 'tabpanel' }, body),
        h(
          'div',
          { className: 'dsd-foot' },
          h('p', { className: 'dsd-foot-note' + note.cls, role: 'status' }, note.text),
          h(
            'button',
            {
              type: 'button',
              className: 'dsd-btn dsd-btn-ghost',
              disabled: state.draftSize === 0 || state.saving,
              onClick: () => store.discard(),
            },
            t('discard'),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dsd-btn dsd-btn-primary',
              disabled: state.draftSize === 0 || state.saving || !state.view.writable,
              onClick: () => store.save(),
            },
            t(state.saving ? 'saving' : 'save'),
          ),
        ),
      )
    }

    /**
     * The Settings-sidebar page.
     *
     * Deliberately takes NO registration-injected props, unlike the plugin-row
     * card. `settings.section` components are rendered straight by the settings
     * shell: it passes the owner props it declares (`close`) and the standard
     * hooks, but it does not deliver a registration's `inject` face. A component
     * written against `props.useDebateCard` therefore renders nothing at all —
     * and it fails *silently*, because the throw lands inside the shell's render
     * and leaves the pane blank while the sidebar entry looks healthy.
     *
     * So this component owns its state: a module-level store, created once, read
     * through React state. That is also how the other third-party settings pages
     * in this build are written.
     */
    function DebateSection() {
      const t = translator()
      const store = storeForSection()
      const state = useSectionState(store)
      const dirty = state.draftSize > 0
      // Mark the tab title while edits are staged. This is the non-blocking half
      // of the "you have unsaved changes" contract; the blocking half belongs to
      // whatever owns navigation, which is the settings shell, so this component
      // only answers `hasUnsavedChanges()` and never opens a dialog itself.
      useEffect(() => {
        if (typeof document === 'undefined' || document.title === undefined) return undefined
        const base = document.title.replace(/^\* /, '')
        document.title = dirty ? `* ${base}` : base
        return () => {
          document.title = document.title.replace(/^\* /, '')
        }
      }, [dirty])
      try {
        return renderSection(t, store, state)
      } catch (error) {
        return h(
          'pre',
          { style: { padding: '16px', whiteSpace: 'pre-wrap', fontFamily: 'monospace', fontSize: '12px' } },
          'SECTION-RENDER-ERROR:\n' + (error && error.stack ? error.stack : String(error)),
        )
      }
    }

    /**
     * Subscribe one component to the shared store's snapshot.
     *
     * `setState` is deliberately NOT the listener. The harness's snapshot store
     * notifies with **no arguments**:
     *
     *     function notifySubscribers(set, label, ...args) { for (const s of [...set]) s(...args) }
     *     subscribe: (listener) => state.subscribe(() => notifySubscribers([listener], '[client-store]'))
     *
     * so passing `setState` straight in calls `setState()` — which React reads as
     * "set the state to undefined". The next render then dereferences
     * `state.view` and throws, blanking the pane. That is why the page showed
     * the loading line for a moment and then went empty when the fetch landed:
     * the first `publish()` was what broke it.
     *
     * The listener therefore re-reads the snapshot itself, and the subscription
     * also re-reads once up front so a publish between render and effect is not
     * missed.
     */
    function useSectionState(store) {
      const [state, setState] = useState(store.getSnapshot())
      useEffect(() => {
        setState(store.getSnapshot())
        return store.subscribe(() => setState(store.getSnapshot()))
      }, [store])
      return state
    }

    /** The real section body, kept separate so the wrapper can trap its failures. */
    function renderSection(t, store, state) {

      const body = (() => {
        if (state.view.status === 'loading') return h('p', { className: 'dsd-hint' }, t('loading'))
        if (state.view.status === 'unavailable') {
          return h(
            'div',
            null,
            h('p', { className: 'dsd-hint dsd-hint-error' }, state.failed || t('unavailable')),
            h(
              'button',
              { type: 'button', className: 'dsd-btn dsd-btn-ghost', onClick: () => store.load() },
              t('retry'),
            ),
          )
        }
        // One tab per page in the sidebar would be one entry too many, so the
        // section stacks every area: the sidebar is the "show me everything"
        // door, and the plugin row keeps the tabbed card.
        const shared = { t, store, state }
        return h(
          'div',
          null,
          h('section', { className: 'dsd-page-sect' }, h(AccountSection, shared)),
          h('section', { className: 'dsd-page-sect' }, h(ModelSection, shared)),
          h('section', { className: 'dsd-page-sect' }, h(PersonaSection, shared)),
          h('section', { className: 'dsd-page-sect' }, h(PublishSection, shared)),
          h('section', { className: 'dsd-page-sect' }, h(StatusSection, shared)),
        )
      })()

      const note = (() => {
        if (state.saving) return { text: t('saving'), cls: '' }
        if (state.failed === 'conflict') return { text: t('conflict'), cls: ' dsd-foot-note-error' }
        if (state.failed) return { text: `${t('saveFailed')}：${state.failed}`, cls: ' dsd-foot-note-error' }
        if (state.notice === 'saved') return { text: t('saved'), cls: ' dsd-foot-note-ok' }
        if (state.notice === 'cleared') return { text: t('cleared'), cls: ' dsd-foot-note-ok' }
        if (state.draftSize > 0) return { text: t('unsaved'), cls: '' }
        if (!state.view.writable) return { text: t('readOnly'), cls: '' }
        if (!state.view.capabilities.credentialService) return { text: t('noCredentialService'), cls: '' }
        return { text: '', cls: '' }
      })()

      return h(
        'div',
        { className: 'dsd-section-page' },
        h(
          'header',
          { className: 'dsd-section-head' },
          h('h2', { className: 'dsd-section-title' }, t('title')),
          h('p', { className: 'dsd-section-desc' }, t('description')),
        ),
        h('div', { className: 'dsd-section-body' }, body),
        h(
          'div',
          { className: 'dsd-foot dsd-foot-sticky' },
          h('p', { className: 'dsd-foot-note' + note.cls, role: 'status' }, note.text),
          h(
            'button',
            {
              type: 'button',
              className: 'dsd-btn dsd-btn-ghost',
              disabled: state.draftSize === 0 || state.saving,
              onClick: () => store.discard(),
            },
            t('discard'),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dsd-btn dsd-btn-primary',
              disabled: state.draftSize === 0 || state.saving || !state.view.writable,
              onClick: () => store.save(),
            },
            t(state.saving ? 'saving' : 'save'),
          ),
        ),
      )
    }

    /** The one-line summary the bundle row renders under its title. */
    function DebateSummary(props) {
      const { t } = props
      return h('span', null, t('description'))
    }

    // ------------------------------------------------------------------ apply

    /** Required services: slots + locale for the page. */
    const inject = ['slots', 'locale']

    /**
     * The page's own state.
     *
     * Created at module scope rather than inside `apply`, because the two seats
     * receive it through different channels: the plugin-row card gets it as an
     * injected prop, while the settings section can only reach it through the
     * module itself. One instance serves both, so switching between the two
     * doors does not reload the configuration or lose a staged edit.
     */
    let sectionStore = null

    /** Create the store once, on first use, so module evaluation stays side-effect free. */
    function storeForSection() {
      if (sectionStore === null) {
        sectionStore = new CardStore()
        sectionStore.load()
      }
      return sectionStore
    }

    /**
     * One line of mount progress, at debug level.
     *
     * Deliberately not silent: when the page does not appear, the first question
     * is always "did apply run at all, and did the registration take". A single
     * `console.info` answers that from DevTools without a rebuild, and it says
     * nothing secret — no cookie, no key, no config value.
     */
    function report(message) {
      console.info(`[dsh-ai-debate] ${message}`)
    }

    /**
     * Mount the configuration page.
     *
     * Registers into BOTH seats, because they are different doors and the task
     * asks for an obvious one:
     *
     * - `settings.section` — a page of its own in the Settings sidebar. This is
     *   the visible entrance; a plugin that only takes `plugins.row.config` is
     *   reachable only by finding the plugin's row and clicking its title.
     * - `plugins.row.config` — the configure view on the bundle's row, which is
     *   where DSH itself points a bundle's configuration.
     *
     * A mount problem is logged, never thrown: the Web shell fails the whole boot
     * when a client plugin's apply throws, and losing the entire GUI because one
     * settings page could not render is a far worse outcome than losing the page.
     */
    function apply(ctx) {
      try {
        ensureStyles()
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-ai-debate: page dictionaries')

        const store = storeForSection()
        report('apply() running')

        /**
         * The face each registration injects.
         *
         * The registration's `inject` result becomes the component's props with
         * `hooks.*` lifted into `use*` selector hooks, so the snapshot store is
         * exposed as `hooks.debateCard` and every sibling key arrives verbatim.
         */
        const contribution = () => ({
          hooks: { debateCard: store.store },
          controller: store,
        })

        // 1. Settings sidebar — the visible entrance.
        ctx.effect(
          () =>
            ctx.slots.inject('settings.section', () => {
              report('registering settings.section')
              return ctx.slots.register(
                {
                  name: 'settings.section',
                  // A fresh id gets its own nav row; reusing a shipped id would
                  // replace that section, so this is the plugin namespace.
                  id: NS,
                  order: 25,
                  // A thunk, re-read on every projection: the label follows the
                  // active locale without re-registering.
                  label: () => (locale() === 'zh' ? zh.navLabel : en.navLabel) ?? NS,
                  locale: NS,
                },
                DebateSection,
              )
            }),
          'dsh-ai-debate: settings section',
        )

        // 2. The bundle row's configure view — where DSH points a row's config.
        ctx.effect(
          () =>
            ctx.slots.inject('plugins.row.config', () => {
              report('registering plugins.row.config')
              return ctx.slots.register(
                {
                  name: 'plugins.row.config',
                  // Keyed `<bundle package name>#<row id>`; the Plugins page grows
                  // a 「配置」 control on that row only while this entry exists.
                  key: `${PKG}#${NS}`,
                  order: 100,
                  locale: NS,
                  inject: contribution,
                },
                DebateCard,
              )
            }),
          'dsh-ai-debate: plugin row config',
        )

        report('settings page mounted')
      } catch (error) {
        console.warn('[dsh-ai-debate] settings page failed to mount:', error)
      }
    }

    exports.apply = apply
    exports.inject = inject
    exports.DebateCard = DebateCard
    exports.DebateSection = DebateSection
    exports.DebateSummary = DebateSummary
    /**
     * The page model, exposed for tests only.
     *
     * `test/client-snapshot-boundary.test.ts` reads this to check that every
     * snapshot the page produces is one the Host's Immer-backed store accepts.
     * That boundary cannot be tested through a rendered component without a real
     * Host, and it is exactly where a completely inert form shipped: a `Map` in
     * the snapshot made every `store.set()` throw. The Host never calls this
     * field, and `apply` does not read it.
     */
    exports.__createCardStore = () => new CardStore()
    return module.exports
  },
})
