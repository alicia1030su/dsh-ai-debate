/**
 * 桌面壳子的「进门」逻辑：关引导、开设置、进插件配置页。
 *
 * ## 为什么抽出来
 *
 * 这三步在 `desktop-acceptance.ts` 与 `desktop-clipboard.ts` 里各写了一遍，
 * 然后**立刻漂移了**：验收脚本用「文档序第一个 `button`」，剪贴板脚本改成
 * 「可见项里最后一个」，后者当场红——同一台机器、同一个版本、同一次会话，
 * 只因为选择器写法不同。这正是 v0.2.31 那次「三处测试命令各自为政」的重演。
 *
 * 抽成一份之后，改一次两个脚本一起变；跑通一次两个一起算数。
 *
 * ## 这几步为什么都不能用 `el.click()`
 *
 * 桌面端的所有浮层（账号菜单、设置、向导）都走 React 合成事件，而
 * `el.click()` 派发的是不可信事件，被过滤掉：返回成功、菜单没关、视图没切。
 * 所以统一走「量出矩形 → 派发真实鼠标事件」。这也是为什么同一段代码在
 * Edge 里「能用」而在 Desktop 里点不动。
 */

/** 脚本侧的四个原语。各脚本各有一套实现，这里只声明形状。 */
export interface ShellCtx {
  evaluate<T>(expression: string): Promise<T>
  clickAt(x: number, y: number): Promise<void>
  clickByText(label: string): Promise<boolean>
  sleep(ms: number): Promise<void>
  /** 视口尺寸。关模态层要按比例点，不能写死像素。 */
  viewport(): Promise<{ vw: number; vh: number }>
}

const text = async (ctx: ShellCtx): Promise<string> =>
  ctx.evaluate<string>('document.body ? document.body.innerText : ""')

/**
 * 点一个**真的能被点到**的按钮。
 *
 * ## 为什么不能只看「按钮存在」
 *
 * 桌面端的向导是分层的：`跳过` 之后弹一个确认框（`暂时跳过充值？` / `我知道了`），
 * 而**下面那层的「跳过」按钮还在 DOM 里**。按文字找按钮、量坐标、派发鼠标事件，
 * 事件落在确认框的遮罩上 —— 按钮自己是「找到了也点了」，但什么也没发生。
 *
 * 实测就停在这里：`e2e` 的日志是「跳过→跳过→…（12 次）」，向导一动不动。
 * 报告读起来像「跳过按钮没实现」，实际是**点在了遮罩上**。
 *
 * 所以判据必须是 `elementFromPoint(中心)` 命中这个按钮（或它的子元素）。
 * 被遮住就换下一个候选标签，而不是反复点同一个位置。
 */
export async function clickVisible(ctx: ShellCtx, label: string): Promise<boolean> {
  const raw = await ctx.evaluate<string>(`(() => {
    const wanted = ${JSON.stringify(label)}
    const nodes = [...document.querySelectorAll('button,[role=button],[role=tab],a,[tabindex]')]
    for (const n of nodes) {
      const t = (n.innerText || n.textContent || '').trim()
      if (t !== wanted) continue
      const r = n.getBoundingClientRect()
      if (r.width < 2 || r.height < 2) continue
      const x = Math.round(r.x + r.width / 2)
      const y = Math.round(r.y + r.height / 2)
      const hit = document.elementFromPoint(x, y)
      if (hit === null) continue
      if (!(n === hit || n.contains(hit) || hit.contains(n))) continue
      return JSON.stringify({ x, y })
    }
    return 'not-clickable'
  })()`)
  if (raw === 'not-clickable') return false
  const point = JSON.parse(raw) as { x: number; y: number }
  await ctx.clickAt(point.x, point.y)
  return true
}

/**
 * 关掉启动引导，把界面带到可用状态。
 *
 * ## 桌面端和 Web 版的引导**不是同一个东西**
 *
 * Web 版：一个模态层（「开始使用」/「预览版说明」），按坐标点叉即可。
 *
 * 桌面端：一个**多步向导**——`开始设置` → 「准备可用额度」→ `跳过` →
 * 「暂时跳过充值？」→ `我知道了` → 完成。它是全屏的，会盖住整个工作区。
 * 不跳过它，后面所有查询都只能看到向导文字，于是「设置打不开」「插件没那项」
 * 全都会红——而产品其实好好的。
 *
 * ## v0.2.33 修掉的那一步
 *
 * v0.2.32 的写法是「按固定顺序试 `跳过` / `我知道了`」，只要 `跳过` 还在 DOM 里
 * 就一直点它。而确认框弹出时，`跳过` 被遮住了：点击落在遮罩上，什么也没发生，
 * 于是循环 12 次、向导原地不动，报告写「关不掉」。
 *
 * 现在每一步都先看**当前屏幕上的文字**决定该点哪个，并且只点 `elementFromPoint`
 * 真的命中的那个按钮（见 {@link clickVisible}）。这两个改动一起，才让「点到的
 * 就是看到的」成立。
 */
export async function dismissOnboarding(ctx: ShellCtx): Promise<string> {
  const seen: string[] = []

  // 第一段：模态层（Web 版形态，桌面端也可能先来一个）
  for (let round = 0; round < 3; round += 1) {
    const current = await text(ctx)
    if (!/开始使用|预览版说明/.test(current)) break
    const { vw, vh } = await ctx.viewport()
    await ctx.clickAt(Math.round(vw * 0.5 + 0.13 * vw), Math.round(vh * 0.35))
    seen.push('modal')
    await ctx.sleep(600)
  }

  // 第二段：多步向导。每一步按「当前文字」选标签，而不是按固定顺序盲试。
  for (let round = 0; round < 12; round += 1) {
    const current = await text(ctx)
    /**
     * 顺序即优先级，且**从上层的对话框开始**：
     *
     * - 「暂时跳过充值？」确认框在向导之上，它的按钮必须先点；
     * - 然后是「准备可用额度」这一步的「跳过」；
     * - 最后是首屏的「开始设置」。
     */
    const candidates: string[] = []
    if (/暂时跳过充值|稍后前往|无法开始新的任务/.test(current)) candidates.push('我知道了', '前往')
    if (/准备可用额度/.test(current)) candidates.push('跳过')
    if (/开始设置/.test(current)) candidates.push('开始设置')
    // 兜底：文字判不出来时，按已知的三个标签依次试。仍然只点真的能点到的那个。
    candidates.push('跳过', '我知道了')

    let clicked = ''
    for (const label of candidates) {
      if (await clickVisible(ctx, label)) {
        clicked = label
        break
      }
    }
    if (clicked === '') break
    seen.push(clicked)
    await ctx.sleep(1300)
  }

  const left = await text(ctx)
  const blocked = /开始设置|准备可用额度|开始使用|预览版说明|暂时跳过充值/.test(left)
  return blocked ? `关不掉（走过：${seen.join('→') || '无'}）` : `clean（${seen.join('→') || '无需处理'}）`
}

/** 设置面板的特征文字。三个里任意一个在，就说明真的切到了设置视图。 */
const SETTINGS_MARKS = /通用设置|内置插件|Agent 预设/

/**
 * 打开设置：左下角账号菜单 → 「设置」。
 *
 * ## 三个坑，全部实测
 *
 * 1. **菜单项文字不是「设置」**，是 `设置\nCtrl\n+,\n`。用 `/^设置$/` 永远
 *    找不到，必须用 `startsWith`。
 * 2. **同一个菜单项在 DOM 里有两层**：`DIV._itemWrap` 与 `BUTTON._item`，
 *    文字一样。按 `div,button` 查会先命中包装层，点它没有任何反应。
 *    只查 `button,[role=menuitem]`。
 * 3. **取文档序第一个，不要取最后一个。** 这一条与直觉相反，但踩过：
 *    「取最后一个可见项」的写法在同一台机器上直接红，而「取第一个」连跑
 *    多次都对。菜单渲染在 body 末尾的说法在这里不成立——`querySelectorAll`
 *    的文档序已经能把包装层排除在外，剩下就是那一个。
 */
export async function openSettings(ctx: ShellCtx): Promise<{ ok: boolean; how: string }> {
  const accountMenu = await ctx.evaluate<string>(`(() => {
    const bs = [...document.querySelectorAll('button')]
      .map(b => { const r = b.getBoundingClientRect()
        return { label: b.getAttribute('aria-label') || '', x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height } })
      .filter(b => b.w > 0 && b.h > 0)
    const byLabel = bs.find(b => b.label === '账号菜单')
    const pick = byLabel ?? bs.sort((a, b) => b.y - a.y)[0]
    return pick === undefined ? 'not-found' : JSON.stringify({ x: Math.round(pick.x), y: Math.round(pick.y) })
  })()`)
  if (accountMenu === 'not-found') return { ok: false, how: '找不到账号菜单' }

  const menu = JSON.parse(accountMenu) as { x: number; y: number }
  /**
   * ## 菜单要「点开 → 看有没有 → 没有就再点一次」
   *
   * 一次点击不保证菜单已经渲染出来。真实撞到过一次：点击 1200ms 后菜单里找不到
   * 「设置」，于是整份报告从第一行起全红——看起来像插件坏了，实际上只是那一次
   * 点早了。重试的代价是几秒，误判的代价是一份不可信的失败报告。
   */
  let settingsPos = 'not-found'
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt > 0) {
      await ctx.clickAt(menu.x, menu.y)
      await ctx.sleep(900)
    }
    settingsPos = await ctx.evaluate<string>(`(() => {
      const el = [...document.querySelectorAll('button,[role=menuitem],[tabindex]')]
        .find(e => /^设置(\\s|$)/.test((e.innerText || '').trim()) && (e.innerText || '').trim().length < 20)
      if (!el) return 'not-found'
      const r = el.getBoundingClientRect()
      if (r.width < 2 || r.height < 2) return 'zero-size'
      return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) })
    })()`)
    if (settingsPos.startsWith('{')) break
  }
  if (!settingsPos.startsWith('{')) {
    return { ok: false, how: `菜单里没有可点的「设置」（${settingsPos}，试了 3 次）` }
  }

  const pos = JSON.parse(settingsPos) as { x: number; y: number }
  await ctx.clickAt(pos.x, pos.y)
  await ctx.sleep(2500)

  let opened = SETTINGS_MARKS.test(await text(ctx))
  if (!opened) {
    // 视图切换同理：点到了不等于已经切过去。再给一次机会，仍然不行才判失败。
    await ctx.clickAt(pos.x, pos.y)
    await ctx.sleep(2500)
    opened = SETTINGS_MARKS.test(await text(ctx))
  }
  return { ok: opened, how: opened ? `账号菜单 → 设置 @${pos.x},${pos.y}` : '点到了，但没切到设置视图' }
}

/**
 * 进插件配置页：设置 → 侧栏「AI代吵架」→ 等分区渲染出来。
 *
 * 新版设置页把插件放在**侧栏**（`settings.section`），不是页签；
 * 插件也不再有 `plugins.row.config` 那扇门（点卡片展开的是 README）。
 * 所以判据只能是「页面上出现了只有这个插件才有的文字」。
 */
export async function openPluginPage(
  ctx: ShellCtx,
  options: { navLabel?: string; markers?: RegExp } = {},
): Promise<{ nav: boolean; mounted: boolean; detail: string }> {
  const navLabel = options.navLabel ?? 'AI代吵架'
  const markers = options.markers ?? /离线讨论导入|主人贴吧数字 ID|当前步骤|登录凭据/

  /**
   * ## 必须等导航项稳定，且每次点击前现量坐标
   *
   * 这一条红过一次，原因很隐蔽：设置面板打开后约 2.5 秒才把 11 个分区
   * 排好版，而这段代码在面板还在展开时就量了坐标。那时 `AI代吵架` 那一行
   * 还没落到最终位置，点下去落到了**账号菜单**上——于是账号菜单弹出来盖住
   * 内容区，脚本看到的是「进到了但分区没渲染」，而产品其实好好的。
   *
   * 所以这里做三件事：
   *   1. 先轮询等那一项**存在且尺寸正常**（宽度 > 2 说明真的排了版）；
   *   2. 点之前**重新量一次**坐标（不缓存上一次的读数）；
   *   3. 没挂载就重试最多 3 次——浮层偶尔会吞掉第一次点击。
   *
   * 只做第 1 步不够：面板会继续回流，坐标还是可能变。
   */
  const measure = async (): Promise<{ ok: true; x: number; y: number } | { ok: false; why: string }> => {
    const raw = await ctx.evaluate<string>(`(() => {
      const nodes = [...document.querySelectorAll('button,[role=tab],[role=button],a,[tabindex]')]
        .filter(e => {
          const t = (e.innerText || '').trim()
          return t === ${JSON.stringify(navLabel)} || /AI代吵架|dsh-ai-debate/.test(t)
        })
      // 取面积最小的那个：它是最内层的可点元素，外面那层是包着图标的容器
      let best
      for (const e of nodes) {
        const r = e.getBoundingClientRect()
        if (r.width < 2 || r.height < 2) continue
        const area = r.width * r.height
        if (best === undefined || area < best.area) best = { area, x: r.x + r.width / 2, y: r.y + r.height / 2 }
      }
      if (best === undefined) return 'not-found'
      return JSON.stringify({ x: Math.round(best.x), y: Math.round(best.y) })
    })()`)
    return raw === 'not-found' ? { ok: false, why: '导航项还没出现' } : { ...(JSON.parse(raw) as { x: number; y: number }), ok: true as const }
  }

  // 等导航项排版完成（最多 20 秒）
  const navDeadline = Date.now() + 20_000
  let seen = await measure()
  while (!seen.ok && Date.now() < navDeadline) {
    await ctx.sleep(600)
    seen = await measure()
  }
  if (!seen.ok) return { nav: false, mounted: false, detail: `侧栏里没有「${navLabel}」（${seen.why}）` }

  let body = ''
  let clickedAt = ''
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    // 每次点击前现量坐标——面板回流会让上一次的读数作废
    const pos = await measure()
    if (!pos.ok) break
    clickedAt = `${pos.x},${pos.y}`
    await ctx.clickAt(pos.x, pos.y)

    const deadline = Date.now() + (attempt === 1 ? 8_000 : 6_000)
    while (Date.now() < deadline) {
      body = await text(ctx)
      if (markers.test(body)) break
      await ctx.sleep(600)
    }
    if (markers.test(body)) {
      return {
        nav: true,
        mounted: true,
        detail: (body.split('\n').find((line) => markers.test(line)) ?? '已挂载').slice(0, 100),
      }
    }
    // 没挂载时先关掉可能被误开的浮层，再重试
    await ctx.evaluate<string>(`(() => {
      // 点空白处收起浮层：点内容区顶部中央，那里通常是标题栏
      const el = document.elementFromPoint(Math.round(window.innerWidth * 0.5), Math.round(window.innerHeight * 0.06))
      if (el instanceof HTMLElement) el.click()
      return 'ok'
    })()`)
    await ctx.sleep(800)
  }

  return {
    nav: true,
    mounted: false,
    detail: `点了 ${clickedAt} 但分区没渲染：${body.slice(0, 160).replace(/\n/g, ' / ')}`,
  }
}
