/**
 * HTTP plumbing shared by every platform adapter.
 *
 * Three jobs, all of which past attempts at this get wrong in the same ways:
 *
 * 1. **A cookie jar.** Tieba refuses plain requests with a security challenge
 *    page until the client holds a real `BAIDUID`; the jar makes that
 *    bootstrap reusable instead of repeated on every call.
 * 2. **Bounded retry with classified errors.** Only transport-level failures
 *    and explicit throttling retry; a 403, a captcha or a 404 does not.
 * 3. **Encoding detection.** Several Tieba endpoints answer in GBK, and
 *    decoding those as UTF-8 produces mojibake that then gets fed to a model.
 */

import { PlatformError, type PlatformErrorCode } from '../types.js'

/** A minimal cookie jar: name → value, with no domain or path scoping. */
export class CookieJar {
  private readonly cookies = new Map<string, string>()

  /** Record every `Set-Cookie` from a response. */
  absorb(response: Response): void {
    const listed = response.headers.getSetCookie?.() ?? []
    for (const raw of listed) {
      const pair = raw.split(';', 1)[0] ?? ''
      const eq = pair.indexOf('=')
      if (eq <= 0) continue
      const name = pair.slice(0, eq).trim()
      const value = pair.slice(eq + 1).trim()
      if (name) this.cookies.set(name, value)
    }
  }

  /** Serialize for a `Cookie` request header; empty string when nothing is held. */
  header(): string {
    const parts: string[] = []
    for (const [name, value] of this.cookies) parts.push(`${name}=${value}`)
    return parts.join('; ')
  }

  /** True when a cookie with this exact name is held and non-empty. */
  has(name: string): boolean {
    const value = this.cookies.get(name)
    return value !== undefined && value !== ''
  }

  /** Number of held cookies, for diagnostics that never reveal values. */
  get size(): number {
    return this.cookies.size
  }

  /** The held cookie names, never their values. */
  names(): readonly string[] {
    return [...this.cookies.keys()]
  }

  /** Set or replace one cookie; used when the user supplies a session. */
  set(name: string, value: string): void {
    this.cookies.set(name, value)
  }

  /** Drop everything; used when a session is reset. */
  clear(): void {
    this.cookies.clear()
  }
}

/** Options for one logical request. */
export interface RequestOptions {
  readonly method?: 'GET' | 'POST'
  readonly headers?: Readonly<Record<string, string>>
  /** Form body for POST; serialized as `application/x-www-form-urlencoded`. */
  readonly form?: Readonly<Record<string, string>>
  readonly signal?: AbortSignal
  /** Per-attempt timeout in milliseconds. */
  readonly timeoutMs?: number
  /** How many extra attempts transport failures get. Defaults to 2. */
  readonly retries?: number
  /** Override the text encoding; `auto` sniffs from headers and content. */
  readonly encoding?: 'auto' | 'utf-8' | 'gbk'
}

/** The result of one successful logical request. */
export interface HttpResult {
  readonly status: number
  readonly url: string
  readonly text: string
  readonly contentType: string
}

/** A browser-shaped user agent; the mobile one triggers the WAP rendering. */
export const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

/** The WAP user agent, which makes Tieba serve the lightweight HTML tree. */
export const MOBILE_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36'

/** Map an HTTP status onto the normalized error classes. */
export function classifyStatus(status: number): PlatformErrorCode {
  if (status === 401) return 'auth_required'
  if (status === 403) return 'forbidden'
  if (status === 404) return 'not_found'
  if (status === 429) return 'rate_limited'
  if (status >= 500) return 'network'
  if (status >= 400) return 'unknown'
  return 'unknown'
}

/** Map a thrown fetch error onto the normalized error classes. */
export function classifyThrown(error: unknown): { code: PlatformErrorCode; message: string } {
  if (error instanceof PlatformError) return { code: error.code, message: error.message }
  const err = error as { name?: string; message?: string; cause?: { code?: string } }
  const message = err?.message ?? String(error)
  if (err?.name === 'AbortError') return { code: 'timeout', message: '请求被取消或超时' }
  if (err?.name === 'TimeoutError') return { code: 'timeout', message: '请求超时' }
  const causeCode = err?.cause?.code
  if (causeCode === 'ENOTFOUND' || causeCode === 'EAI_AGAIN') {
    return { code: 'dns', message: `DNS 解析失败：${message}` }
  }
  if (typeof causeCode === 'string' && causeCode.startsWith('UND_ERR')) {
    return { code: 'network', message: `连接失败：${message}` }
  }
  return { code: 'network', message }
}

/**
 * Decode a response body, honoring the declared charset and falling back to
 * GBK when the bytes are not valid UTF-8.
 */
export function decodeBody(bytes: Uint8Array, contentType: string, mode: RequestOptions['encoding']): string {
  const declared =
    mode === 'utf-8' || mode === 'gbk'
      ? mode
      : /charset=["']?\s*([\w-]+)/i.exec(contentType)?.[1]?.toLowerCase() ?? 'auto'

  if (declared === 'gbk' || declared === 'gb2312' || declared === 'gb18030') {
    return new TextDecoder('gb18030').decode(bytes)
  }
  if (declared === 'utf-8' || declared === 'utf8') {
    return new TextDecoder('utf-8').decode(bytes)
  }

  // `auto`: UTF-8 is the common case, so try it strictly first.
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return new TextDecoder('gb18030').decode(bytes)
  }
}

/** The shared HTTP client: one cookie jar, bounded retry, classified errors. */
export class HttpClient {
  readonly jar = new CookieJar()
  private readonly defaultTimeoutMs: number
  private readonly defaultRetries: number

  constructor(options: { timeoutMs?: number; retries?: number } = {}) {
    this.defaultTimeoutMs = options.timeoutMs ?? 20_000
    this.defaultRetries = options.retries ?? 2
  }

  /**
   * Perform one logical request, retrying only transport failures.
   *
   * @param url absolute URL
   * @param options method, headers, form body, timeout, retry count
   * @returns the decoded body with its status
   * @throws PlatformError with a normalized `code`
   */
  async request(url: string, options: RequestOptions = {}): Promise<HttpResult> {
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs
    const attempts = Math.max(1, (options.retries ?? this.defaultRetries) + 1)
    let lastError: PlatformError | undefined

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (options.signal?.aborted) {
        throw new PlatformError('请求已取消', 'timeout')
      }
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      const onAbort = (): void => controller.abort()
      options.signal?.addEventListener('abort', onAbort, { once: true })

      try {
        const headers: Record<string, string> = {
          'user-agent': DESKTOP_UA,
          accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
          'accept-language': 'zh-CN,zh;q=0.9',
          ...options.headers,
        }
        const cookie = this.jar.header()
        if (cookie) headers.cookie = cookie

        let body: string | undefined
        if (options.form) {
          body = new URLSearchParams(options.form).toString()
          headers['content-type'] ??= 'application/x-www-form-urlencoded;charset=UTF-8'
        }

        const response = await fetch(url, {
          method: options.method ?? (options.form ? 'POST' : 'GET'),
          headers,
          body,
          redirect: 'follow',
          signal: controller.signal,
        })
        this.jar.absorb(response)

        const buffer = await response.arrayBuffer()
        const text = decodeBody(new Uint8Array(buffer), response.headers.get('content-type') ?? '', options.encoding)

        if (response.status >= 400) {
          const code = classifyStatus(response.status)
          const retryAfter = parseRetryAfter(response.headers.get('retry-after'))
          const failure = new PlatformError(
            `平台返回 ${response.status}（${code}）`,
            code,
            { status: response.status, retryAfterMs: retryAfter },
          )
          if (!failure.retryable) throw failure
          lastError = failure
        } else {
          return {
            status: response.status,
            url: response.url || url,
            text,
            contentType: response.headers.get('content-type') ?? '',
          }
        }
      } catch (error) {
        if (error instanceof PlatformError && !error.retryable) throw error
        const classified = classifyThrown(error)
        lastError = new PlatformError(classified.message, classified.code, { cause: error })
      } finally {
        clearTimeout(timer)
        options.signal?.removeEventListener('abort', onAbort)
      }

      if (attempt + 1 < attempts) {
        await delay(Math.min(2_000, 300 * 2 ** attempt))
      }
    }

    throw lastError ?? new PlatformError('请求失败且没有捕获到具体错误', 'unknown')
  }
}

/** Parse an RFC-ish `Retry-After` header into milliseconds. */
function parseRetryAfter(raw: string | null): number | undefined {
  if (!raw) return undefined
  const seconds = Number(raw)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds, 120) * 1000
  const date = Date.parse(raw)
  if (Number.isFinite(date)) return Math.max(0, Math.min(date - Date.now(), 120_000))
  return undefined
}

/** Sleep that honors an abort signal. */
export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new PlatformError('等待被取消', 'timeout'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new PlatformError('等待被取消', 'timeout'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
