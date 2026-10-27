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
import { type PlatformErrorCode } from '../types.js';
/** A minimal cookie jar: name → value, with no domain or path scoping. */
export declare class CookieJar {
    private readonly cookies;
    /** Record every `Set-Cookie` from a response. */
    absorb(response: Response): void;
    /** Serialize for a `Cookie` request header; empty string when nothing is held. */
    header(): string;
    /** True when a cookie with this exact name is held and non-empty. */
    has(name: string): boolean;
    /** Number of held cookies, for diagnostics that never reveal values. */
    get size(): number;
    /** The held cookie names, never their values. */
    names(): readonly string[];
    /** Set or replace one cookie; used when the user supplies a session. */
    set(name: string, value: string): void;
    /** Drop everything; used when a session is reset. */
    clear(): void;
}
/** Options for one logical request. */
export interface RequestOptions {
    readonly method?: 'GET' | 'POST';
    readonly headers?: Readonly<Record<string, string>>;
    /** Form body for POST; serialized as `application/x-www-form-urlencoded`. */
    readonly form?: Readonly<Record<string, string>>;
    readonly signal?: AbortSignal;
    /** Per-attempt timeout in milliseconds. */
    readonly timeoutMs?: number;
    /** How many extra attempts transport failures get. Defaults to 2. */
    readonly retries?: number;
    /** Override the text encoding; `auto` sniffs from headers and content. */
    readonly encoding?: 'auto' | 'utf-8' | 'gbk';
}
/** The result of one successful logical request. */
export interface HttpResult {
    readonly status: number;
    readonly url: string;
    readonly text: string;
    readonly contentType: string;
}
/** A browser-shaped user agent; the mobile one triggers the WAP rendering. */
export declare const DESKTOP_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
/** The WAP user agent, which makes Tieba serve the lightweight HTML tree. */
export declare const MOBILE_UA = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36";
/** Map an HTTP status onto the normalized error classes. */
export declare function classifyStatus(status: number): PlatformErrorCode;
/** Map a thrown fetch error onto the normalized error classes. */
export declare function classifyThrown(error: unknown): {
    code: PlatformErrorCode;
    message: string;
};
/**
 * Decode a response body, honoring the declared charset and falling back to
 * GBK when the bytes are not valid UTF-8.
 */
export declare function decodeBody(bytes: Uint8Array, contentType: string, mode: RequestOptions['encoding']): string;
/** The shared HTTP client: one cookie jar, bounded retry, classified errors. */
export declare class HttpClient {
    readonly jar: CookieJar;
    private readonly defaultTimeoutMs;
    private readonly defaultRetries;
    constructor(options?: {
        timeoutMs?: number;
        retries?: number;
    });
    /**
     * Perform one logical request, retrying only transport failures.
     *
     * @param url absolute URL
     * @param options method, headers, form body, timeout, retry count
     * @returns the decoded body with its status
     * @throws PlatformError with a normalized `code`
     */
    request(url: string, options?: RequestOptions): Promise<HttpResult>;
}
/** Sleep that honors an abort signal. */
export declare function delay(ms: number, signal?: AbortSignal): Promise<void>;
//# sourceMappingURL=http.d.ts.map