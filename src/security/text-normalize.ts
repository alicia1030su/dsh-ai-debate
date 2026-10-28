/**
 * Normalise text for inspection without destroying the evidence.
 *
 * ## Two copies, on purpose
 *
 * An attacker hides an instruction with a full-width character, a zero-width
 * joiner, or a homoglyph. To recognise it, the checker has to look at a
 * normalised copy. But that copy must **never** be what we quote, store, or show
 * a human: the owner reviewing a block needs to see what was actually written,
 * and the evidence a report cites has to be the platform's bytes.
 *
 * So this module produces a `ScanView` holding both. Callers use `scan` for
 * detection and `raw` for everything else.
 *
 * ## What normalisation does *not* do
 *
 * - It does not "clean" the text for the model. Feeding a sanitised copy to the
 *   model would mean the model never sees the real argument, and stripping
 *   characters from a comment is a silent edit of someone's words.
 * - It does not decode encodings to execute them. Base64 that decodes to
 *   "ignore previous instructions" is recorded as *a suspicious encoded fragment*
 *   and scored; the decoded text is never treated as an instruction.
 * - It does not flag ordinary mentions of `system`, `prompt` or `删除`. Those are
 *   normal words in a discussion about software, and a false positive here
 *   wastes the owner's attention on a review that says nothing.
 */

/** How much invisible or deceptive formatting the input contains. */
export interface FormattingAnomaly {
  /** Zero-width and other invisible characters, as (codepoint, count) pairs. */
  readonly invisible: readonly { readonly cp: number; readonly name: string; readonly count: number }[]
  /** Count of characters that are not what they appear to be (mixed scripts). */
  readonly mixedScripts: readonly string[]
  /** True when the text uses bidirectional overrides, a classic spoofing tool. */
  readonly bidiOverride: boolean
  /** Control characters that should never appear in a post. */
  readonly controlChars: number
  /** HTML entities such as `&lt;script&gt;` that would render as markup. */
  readonly htmlEntities: number
}

/** The two views of one input. */
export interface ScanView {
  /** Exactly what the platform returned. Use this for quotes and evidence. */
  readonly raw: string
  /** NFKC-normalised, invisibles stripped, lowercased for matching. Detection only. */
  readonly scan: string
  readonly anomalies: FormattingAnomaly
  /** True when `raw` was too long to scan in full; `scan` holds a prefix. */
  readonly truncated: boolean
}

/** Maximum characters inspected. Beyond this the tail is not analysed. */
export const MAX_SCAN_CHARS = 20_000

const INVISIBLE: Readonly<Record<number, string>> = Object.freeze({
  0x200b: 'zero-width space',
  0x200c: 'zero-width non-joiner',
  0x200d: 'zero-width joiner',
  0x200e: 'left-to-right mark',
  0x200f: 'right-to-left mark',
  0xfeff: 'byte-order mark',
  0x00ad: 'soft hyphen',
  0x2060: 'word joiner',
  0x180e: 'mongolian vowel separator',
})

/** Ranges whose presence means someone is trying to reorder displayed text. */
function isBidiOverride(cp: number): boolean {
  return cp >= 0x202a && cp <= 0x202e
}

/** Script buckets, enough to notice Latin+Greek mixes used for homoglyphs. */
function scriptOf(cp: number): string | undefined {
  if (cp >= 0x41 && cp <= 0x7a) return 'latin'
  if (cp >= 0x0370 && cp <= 0x03ff) return 'greek'
  if (cp >= 0x0400 && cp <= 0x04ff) return 'cyrillic'
  if (cp >= 0x4e00 && cp <= 0x9fff) return 'han'
  return undefined
}

/**
 * Build the two views.
 *
 * NFKC is the right choice because it folds the full-width and compatibility
 * forms an attacker uses, while leaving ordinary Chinese, Latin and punctuation
 * intact. NFD/NFC variants would not fold `ｉｇｎｏｒｅ` into `ignore`.
 */
export function scanView(raw: string): ScanView {
  const truncated = raw.length > MAX_SCAN_CHARS
  const head = truncated ? raw.slice(0, MAX_SCAN_CHARS) : raw

  const invisibleCounts = new Map<number, number>()
  let bidiOverride = false
  let controlChars = 0
  const scripts = new Set<string>()

  for (const ch of head) {
    const cp = ch.codePointAt(0) ?? 0
    if (INVISIBLE[cp] !== undefined) {
      invisibleCounts.set(cp, (invisibleCounts.get(cp) ?? 0) + 1)
      continue
    }
    if (isBidiOverride(cp)) {
      bidiOverride = true
      continue
    }
    // Tab and newline are legitimate in a post; other C0/C1 controls are not.
    if ((cp < 0x20 && cp !== 0x09 && cp !== 0x0a && cp !== 0x0d) || (cp >= 0x7f && cp <= 0x9f)) {
      controlChars += 1
      continue
    }
    const script = scriptOf(cp)
    if (script !== undefined) scripts.add(script)
  }

  // Default NFKC already decomposes and recomposes; it also folds full-width
  // forms. Lowercasing is done here rather than in each pattern so the detection
  // rules never have to carry a case-insensitive flag and forget one.
  const normalised = head.normalize('NFKC')
  // Strip invisibles from the scan copy by construction, so a zero-width joiner
  // cannot split "ignore" into two tokens that no pattern matches.
  let scan = ''
  for (const ch of normalised) {
    const cp = ch.codePointAt(0) ?? 0
    if (INVISIBLE[cp] !== undefined || isBidiOverride(cp)) continue
    scan += ch
  }
  scan = scan.toLowerCase()

  const htmlEntities = (head.match(/&(lt|gt|amp|quot|#\d+|#x[0-9a-f]+);/gi) ?? []).length

  // Mixed scripts matter only when Latin is involved: Cyrillic 'а' replacing
  // Latin 'a' is the classic spoof, while Chinese text mixing ASCII words is
  // completely normal and must not be flagged.
  const mixed = scripts.has('latin') && (scripts.has('cyrillic') || scripts.has('greek'))
    ? [...scripts].filter((name) => name !== 'han').sort()
    : []

  return {
    raw,
    scan,
    truncated,
    anomalies: {
      invisible: [...invisibleCounts.entries()].map(([cp, count]) => ({
        cp,
        name: INVISIBLE[cp] ?? 'unknown',
        count,
      })),
      mixedScripts: mixed,
      bidiOverride,
      controlChars,
      htmlEntities,
    },
  }
}

/** True when the formatting itself is suspicious enough to mention. */
export function hasFormattingAnomaly(anomalies: FormattingAnomaly): boolean {
  return (
    anomalies.invisible.length > 0 ||
    anomalies.bidiOverride ||
    anomalies.controlChars > 0 ||
    anomalies.mixedScripts.length > 0
  )
}

/** One-line description of the anomalies, for a security event. */
export function describeAnomalies(anomalies: FormattingAnomaly): string {
  const parts: string[] = []
  if (anomalies.invisible.length > 0) {
    const total = anomalies.invisible.reduce((sum, item) => sum + item.count, 0)
    const kinds = anomalies.invisible.map((item) => item.name).join('、')
    parts.push(`${total} 个不可见字符（${kinds}）`)
  }
  if (anomalies.bidiOverride) parts.push('双向文本覆盖字符')
  if (anomalies.controlChars > 0) parts.push(`${anomalies.controlChars} 个控制字符`)
  if (anomalies.mixedScripts.length > 0) {
    parts.push(`混用字母系统（${anomalies.mixedScripts.join('+')}），可能是同形字伪装`)
  }
  if (anomalies.htmlEntities > 2) parts.push(`${anomalies.htmlEntities} 个 HTML 实体`)
  return parts.length === 0 ? '无异常格式' : parts.join('；')
}

/**
 * Candidate decodings of a suspicious fragment, for *analysis* only.
 *
 * Returns the decoded strings so a detector can look for instruction-shaped text
 * inside them. **Never** treat a successful decode as permission to act on its
 * contents; a base64 blob that decodes to "delete all sessions" is still just a
 * comment that said something odd.
 */
export function decodeCandidates(text: string): readonly { readonly encoding: string; readonly decoded: string }[] {
  const out: { encoding: string; decoded: string }[] = []
  for (const match of text.matchAll(/[A-Za-z0-9+/]{24,}={0,2}/g)) {
    const candidate = match[0]
    try {
      const decoded = Buffer.from(candidate, 'base64').toString('utf8')
      // Require mostly-printable output: random base64 decodes to binary noise,
      // and treating noise as text wastes the scorer's budget.
      if (decoded.length >= 8 && /^[\x20-\x7e\u4e00-\u9fff\s]{8,}$/.test(decoded)) {
        out.push({ encoding: 'base64', decoded })
      }
    } catch {
      // Not base64 after all; nothing to report.
    }
    if (out.length >= 4) break
  }
  for (const match of text.matchAll(/(?:\\u[0-9a-fA-F]{4}){4,}|(?:%[0-9a-fA-F]{2}){6,}/g)) {
    try {
      const decoded =
        match[0].includes('%')
          ? decodeURIComponent(match[0])
          : match[0].replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) =>
              String.fromCharCode(Number.parseInt(hex, 16)),
            )
      if (decoded.length >= 4) {
        out.push({ encoding: match[0].includes('%') ? 'percent' : 'unicode-escape', decoded })
      }
    } catch {
      // Malformed escape; ignore.
    }
    if (out.length >= 8) break
  }
  return out
}
