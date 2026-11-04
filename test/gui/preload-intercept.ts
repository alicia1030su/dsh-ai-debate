/**
 * Serve the fixture discussion to the *real* plugin, without touching product code.
 *
 * ## The constraint that shaped this
 *
 * The browser run must exercise the production chain: real plugin routes, real
 * `collectThread`, real parsers, real analysis. Introducing a FakeAdapter behind a
 * flag would satisfy the letter of "end-to-end" while skipping every parser — and a
 * publicly reachable test mode in a shipped plugin is a security hole regardless of
 * how it is named.
 *
 * So this preloads *outside* the plugin. `HttpClient` calls the global `fetch`, so
 * replacing `fetch` in the host process intercepts the adapter's network reads at the
 * exact boundary a real server would occupy. The plugin cannot tell the difference,
 * and the shipped package contains none of this.
 *
 * Loaded with `NODE_OPTIONS=--import …`, which the DSH CLI honours (verified against
 * 0.2.1-rc.5).
 *
 * ## What it does and does not intercept
 *
 * Reads of the fixture thread are answered locally. Writes are refused outright with a
 * counter, so "0 real publish requests" is measured rather than promised. Anything
 * else — the harness's own calls, the local model server — passes through untouched.
 */

import { readFileSync } from 'node:fs'

const TIEBA = 'tieba.baidu.com'

/** Counters the end-to-end script reads back from a file after the run. */
interface InterceptLog {
  reads: { url: string; kind: string }[]
  blockedWrites: string[]
  passthrough: number
}

const log: InterceptLog = { reads: [], blockedWrites: [], passthrough: 0 }

const realFetch = globalThis.fetch

function json(body: string): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } })
}

function html(body: string): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })
}

/**
 * Route one Tieba URL to a fixture response, or return `undefined` to pass through.
 *
 * The paths mirror the adapter's own call sites, so a change there shows up here as a
 * passthrough (and therefore a real network attempt) rather than as a silent pass.
 */
async function handleTieba(url: URL, fixture: FixtureApi): Promise<Response | undefined> {
  // A write is never served from the fixture: the whole point is to prove that no
  // real publish happens. Recording it and refusing makes that measurable.
  if (url.pathname.includes('/f/commit/post/add')) {
    log.blockedWrites.push(url.pathname)
    return json(JSON.stringify({ no: 1, error: 'blocked by e2e fixture: real publish is not allowed' }))
  }

  if (url.pathname === '/mo/q/m' || url.pathname === '/mo/q/m/') {
    const pn = Number(url.searchParams.get('pn') ?? '0')
    // `pn` is a reply offset; page 1 is offset 0. Anything beyond is the deliberate
    // "page 2 unreadable" case, which must surface as an incomplete read.
    if (pn !== 0) {
      log.reads.push({ url: url.toString(), kind: 'floor-page-unavailable' })
      return new Response('', { status: 503 })
    }
    log.reads.push({ url: url.toString(), kind: 'floor-page' })
    return html(fixture.wapPage())
  }

  if (url.pathname === '/p/totalComment') {
    log.reads.push({ url: url.toString(), kind: 'total-comment' })
    return json(fixture.totalComment())
  }

  if (url.pathname === '/p/comment') {
    const pid = url.searchParams.get('pid') ?? ''
    log.reads.push({ url: url.toString(), kind: `comment-page:${pid}` })
    return json(fixture.commentPage(pid))
  }

  return undefined
}

interface FixtureApi {
  wapPage(): string
  totalComment(): string
  commentPage(pid: string): string
}

function loadFixture(path: string): FixtureApi {
  const bundle = JSON.parse(readFileSync(path, 'utf8')) as {
    wapPage: string
    totalComment: string
    commentPage: Record<string, string>
  }
  return {
    wapPage: () => bundle.wapPage,
    totalComment: () => bundle.totalComment,
    commentPage: (pid: string) => bundle.commentPage[pid] ?? JSON.stringify({ no: 0, data: { comment_list: [], has_more: 0 } }),
  }
}

const fixturePath = process.env.DSH_E2E_FIXTURE_JSON
if (fixturePath !== undefined && fixturePath !== '') {
  const fixture = loadFixture(fixturePath)

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
      const response = await handleTieba(url, fixture)
      if (response !== undefined) return response
    }

    log.passthrough += 1
    return realFetch(input as never, init)
  }) as typeof globalThis.fetch

  // Written on every change so a crashed run still leaves evidence of what was served.
  const logPath = process.env.DSH_E2E_INTERCEPT_LOG
  if (logPath !== undefined && logPath !== '') {
    const { writeFileSync } = await import('node:fs')
    const flush = (): void => {
      try {
        writeFileSync(logPath, JSON.stringify(log, null, 2), 'utf8')
      } catch {
        // The run's verdict must not depend on a log write.
      }
    }
    flush()
    setInterval(flush, 500).unref?.()
    process.on('exit', flush)
  }
}
