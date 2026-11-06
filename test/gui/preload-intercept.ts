/**
 * A simulated Tieba, occupying the network boundary the plugin would otherwise reach.
 *
 * ## Why this is a network service and not a fake adapter
 *
 * A fake adapter behind a flag would prove that the UI can render objects the tests
 * invented. It would skip every parser, the real collector, the real publish path and
 * the real read-back. So this sits exactly where a server sits — `globalThis.fetch` —
 * and the plugin cannot tell the difference.
 *
 * Nothing is added to the shipped package: `NODE_OPTIONS=--import` loads this outside
 * the plugin, and there is no test mode a user could switch on.
 *
 * ## Writes are served, but only here
 *
 * Reads come from the fixture. A publish (`/f/commit/post/add`) is **accepted by this
 * simulated platform**, recorded, and then made visible to a subsequent read, which is
 * what makes the read-back path real rather than stubbed. Every accepted write is
 * appended to a log the runner asserts against; every request to any other host is
 * counted as a passthrough so "0 real publishes" is measured rather than promised.
 *
 * The failure modes the publish path must distinguish (`ok`, `http500`, `network`,
 * `timeout`, `lost`) are selected through a control file so one run can exercise all of
 * them without restarting the host.
 */

import { readFileSync, writeFileSync } from 'node:fs'

const TIEBA = 'tieba.baidu.com'

/** One accepted publish, as the simulated platform saw it. */
interface PublishRecord {
  readonly seq: number
  readonly threadId: string
  /** Floor the reply hangs under; absent for a top-level floor reply. */
  readonly floorPostId?: string
  /** Nested reply being answered; absent when the target was a floor. */
  readonly nestedReplyId?: string
  readonly kind: 'floor' | 'nested'
  readonly content: string
  readonly account?: string
  readonly at: string
  readonly mode: string
  readonly outcome: 'accepted' | 'rejected'
}

interface InterceptLog {
  readonly reads: { url: string; kind: string }[]
  /** Requests to a Tieba write endpoint. Non-empty means something tried to publish. */
  readonly blockedWrites: string[]
  readonly publishes: PublishRecord[]
  passthrough: number
  /**
   * 任何指向真实微博的 HTTP 请求（v0.2.30）。
   *
   * ## 为什么单独计数
   *
   * 微博走的是 `weibo-cli` 子进程，不经过 `globalThis.fetch`——所以这个计数**不是**
   * 「微博请求总数」，而是「有没有哪条代码路径绕开 CLI 直接用 fetch 打微博」。
   * 它必须永远是 0：一旦非零，说明出现了第二套微博客户端，而那套没经过只读允许列表。
   *
   * `passthrough` 会把这类请求真的发出去（这是拦截器的设计：它只模拟贴吧），
   * 所以这一项也是「离线流程有没有偷联网」的直接证据。
   */
  readonly weiboHttpCalls: string[]
}

const log: InterceptLog = {
  reads: [],
  blockedWrites: [],
  publishes: [],
  passthrough: 0,
  weiboHttpCalls: [],
}

const realFetch = globalThis.fetch

function json(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'application/json' } })
}

function html(body: string): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

interface FixtureBundle {
  wapPage: string
  totalComment: string
  commentPage: Record<string, string>
}

/** Replies this run has created, keyed by the floor they hang under. */
const publishedNested = new Map<string, { postId: string; author: string; handle: string; content: string }[]>()
/** Floors this run has created, appended to the floor list. */
const publishedFloors: { postId: string; author: string; handle: string; content: string }[] = []

let nextPostId = 9300000001

function publishMode(): string {
  const path = process.env.DSH_E2E_CONTROL_JSON
  if (path === undefined || path === '') return 'ok'
  try {
    const control = JSON.parse(readFileSync(path, 'utf8')) as { publishMode?: string }
    return control.publishMode ?? 'ok'
  } catch {
    return 'ok'
  }
}

/** Append the replies this run created to the floor page, keeping the fixture's shape. */
function wapPageWithPublished(bundle: FixtureBundle): string {
  if (publishedFloors.length === 0) return bundle.wapPage
  const extra = publishedFloors
    .map((floor, index) =>
      [
        `<li tid="${floor.postId}" data-tid="${floor.postId}" fn="${100 + index}" data-info="${escapeHtml(
          JSON.stringify({ un: floor.handle, name_show: floor.author, user_id: 600001 }),
        )}">`,
        `<div class="floor_head"><a href="javascript:;" class="user_name">${escapeHtml(floor.author)}</a></div>`,
        `<div class="floor_content">${escapeHtml(floor.content)}</div>`,
        `</li>`,
      ].join(''),
    )
    .join('')
  return bundle.wapPage.replace('</ul>', `${extra}</ul>`)
}

/** The `/p/comment` page, plus anything this run published into that floor. */
function commentPageWithPublished(bundle: FixtureBundle, pid: string): string {
  const base = bundle.commentPage[pid] ?? '{"total_num":0,"total_page":1}<ul class="lzl_list"></ul>'
  const extra = (publishedNested.get(pid) ?? [])
    .map((reply) =>
      [
        `<li class="lzl_single_post" data-field='${escapeHtml(
          JSON.stringify({
            spid: Number(reply.postId),
            pid: Number(pid),
            un: reply.handle,
            user_id: 600001,
            name: reply.author,
            content: reply.content,
          }),
        )}'>`,
        `<span class="lzl_panel_wrapper"><span class="lzl_cnt">`,
        // `user_id` is what makes the author check pass in the numeric namespace: the
        // plugin authorises the account by `user_id`, and a row that carries only a
        // `username` cannot be matched against it. Real pages publish both here.
        `<a class="at" username="${escapeHtml(reply.handle)}" user_id="600001">${escapeHtml(reply.author)}</a>`,
        `<span class="lzl_content_main">${escapeHtml(reply.content)}</span>`,
        `</span></span>`,
        `</li>`,
      ].join(''),
    )
    .join('')
  if (extra === '') return base
  return base.replace('</ul>', `${extra}</ul>`)
}

/**
 * Accept one publish.
 *
 * The form is what `publishReply` sends: `content`, `tid`, and either `comment_id`
 * (nested) or nothing (floor). Reading it here is what lets the run assert on the
 * *effective* target rather than on the target the page claimed.
 */
async function handlePublish(body: string): Promise<Response> {
  const form = new URLSearchParams(body)
  const mode = publishMode()
  const threadId = form.get('tid') ?? ''
  const nestedReplyId = form.get('comment_id') ?? undefined
  const floorPostId = form.get('reply_id') ?? undefined
  const content = form.get('content') ?? ''
  const postId = String(nextPostId++)
  const kind: 'floor' | 'nested' = nestedReplyId !== undefined && nestedReplyId !== '' ? 'nested' : 'floor'

  const record: PublishRecord = {
    seq: log.publishes.length + 1,
    threadId,
    ...(floorPostId === undefined || floorPostId === '' ? {} : { floorPostId }),
    ...(nestedReplyId === undefined || nestedReplyId === '' ? {} : { nestedReplyId }),
    kind,
    content,
    at: new Date().toISOString(),
    mode,
    outcome: mode === 'http500' ? 'rejected' : 'accepted',
  }
  log.publishes.push(record)
  flush()

  if (mode === 'http500') {
    return json(JSON.stringify({ no: 1, error: 'simulated platform error' }), 500)
  }

  // Accepted from here on: the platform has the reply even if the client never hears back.
  if (kind === 'nested') {
    const parent = floorPostId === undefined || floorPostId === '' ? (nestedReplyId ?? '') : floorPostId
    const list = publishedNested.get(parent) ?? []
    list.push({ postId, author: 'AI小号', handle: 'ai_account', content })
    publishedNested.set(parent, list)
  } else {
    publishedFloors.push({ postId, author: 'AI小号', handle: 'ai_account', content })
  }

  if (mode === 'network') {
    // The platform accepted it; the transport died on the way back. This is the case
    // that must never be retried blindly and must never be called a success.
    throw new TypeError('simulated transport failure after the platform accepted the post')
  }
  if (mode === 'timeout') {
    // Never resolves: the client aborts, and the abort is what the plugin must treat as
    // "outcome unknown" rather than "failed, try again".
    return new Promise<Response>(() => undefined)
  }
  if (mode === 'lost') {
    // Accepted, but the answer carries no post id — a success claim that cannot be checked.
    return json(JSON.stringify({ no: 0, error: null, data: { is_login: 1 } }))
  }

  return json(JSON.stringify({ no: 0, error: null, data: { is_login: 1, pid: Number(postId) } }))
}

async function handleTieba(url: URL, bundle: FixtureBundle, init?: RequestInit): Promise<Response | undefined> {
  if (url.pathname.includes('/f/commit/post/add')) {
    log.blockedWrites.push(url.pathname)
    const body = typeof init?.body === 'string' ? init.body : init?.body instanceof URLSearchParams ? init.body.toString() : ''
    return handlePublish(body)
  }

  if (url.pathname === '/mo/q/m' || url.pathname === '/mo/q/m/') {
    const pn = Number(url.searchParams.get('pn') ?? '0')
    if (pn !== 0) {
      log.reads.push({ url: url.toString(), kind: 'floor-page-unavailable' })
      return new Response('', { status: 503 })
    }
    log.reads.push({ url: url.toString(), kind: 'floor-page' })
    return html(wapPageWithPublished(bundle))
  }

  if (url.pathname === '/p/totalComment') {
    log.reads.push({ url: url.toString(), kind: 'total-comment' })
    return json(bundle.totalComment)
  }

  if (url.pathname === '/p/comment') {
    const pid = url.searchParams.get('pid') ?? ''
    log.reads.push({ url: url.toString(), kind: `comment-page:${pid}` })
    return json(commentPageWithPublished(bundle, pid))
  }

  return undefined
}

const fixturePath = process.env.DSH_E2E_FIXTURE_JSON
const logPath = process.env.DSH_E2E_INTERCEPT_LOG ?? ''
const publishLogPath = process.env.DSH_E2E_PUBLISH_LOG ?? ''

function flush(): void {
  const payload = JSON.stringify(
    { ...log, publishLog: publishLogPath === '' ? undefined : publishLogPath },
    null,
    2,
  )
  for (const path of [logPath, publishLogPath]) {
    if (path === '') continue
    try {
      writeFileSync(path, payload, 'utf8')
    } catch {
      // The run's verdict must not depend on a log write.
    }
  }
}

if (fixturePath !== undefined && fixturePath !== '') {
  const bundle = JSON.parse(readFileSync(fixturePath, 'utf8')) as FixtureBundle

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    let url: URL
    try {
      url = new URL(raw)
    } catch {
      log.passthrough += 1
      return realFetch(input as never, init)
    }

    if (url.hostname === TIEBA) {
      const response = await handleTieba(url, bundle, init)
      if (response !== undefined) return response
    }

    /**
     * 微博必须只经 CLI 子进程。这里记下来并**拒绝**，而不是放行。
     *
     * 放行就等于让一条绕开 CLI 的路径真的打到平台上——而那正是「真实写请求为零」
     * 这条要求的反面。拒绝使它成为一个可测的断言（`weiboHttpCalls` 为空），
     * 而不是一句承诺。
     */
    if (/(^|\.)weibo\.(com|cn)$/.test(url.hostname)) {
      log.weiboHttpCalls.push(raw)
      return json(
        JSON.stringify({
          ok: false,
          reason:
            'E2E 拦截器：微博只允许通过 weibo-cli 子进程访问，这条 HTTP 请求已被拒绝。',
        }),
        403,
      )
    }

    log.passthrough += 1
    return realFetch(input as never, init)
  }) as typeof globalThis.fetch

  flush()
  setInterval(flush, 500).unref?.()
  process.on('exit', flush)
}
