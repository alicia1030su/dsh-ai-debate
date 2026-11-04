/**
 * A real HTTP server standing in for an OpenAI-compatible endpoint.
 *
 * ## Why a server and not a stub client
 *
 * `ScriptedLlmClient` already exists and is used elsewhere, but it bypasses the part
 * that actually breaks: the request encoding, the status handling, the abort wiring,
 * and the response parsing. A stub that returns an object cannot tell you that a 429
 * was classified as retryable, because it never produced a 429.
 *
 * This runs on `127.0.0.1` with an ephemeral port, accepts one request at a time, and
 * answers with whatever the case says. No real key is involved: the server never
 * inspects the authorization header beyond recording that one was sent.
 *
 * Nothing here reaches the internet, and the port is bound to the loopback interface.
 */

import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface MockReply {
  readonly status?: number
  /** Raw body text. Used as-is so malformed JSON can be sent on purpose. */
  readonly body?: string
  /** Delay before answering, for timeout and abort cases. */
  readonly delayMs?: number
  /** Answer only after this promise settles, for cancellation tests. */
  readonly waitFor?: Promise<void>
  /** Never answer at all. Closed by the fixture teardown. */
  readonly hang?: boolean
}

export interface CapturedRequest {
  readonly method: string
  readonly url: string
  readonly authorization?: string
  readonly body: unknown
}

export interface MockServer {
  readonly baseUrl: string
  readonly requests: CapturedRequest[]
  /** Queue the replies to serve, in order. Extra requests get the last one. */
  push(reply: MockReply): void
  close(): Promise<void>
}

/** A well-formed chat completion body. */
export function completion(content: string): string {
  return JSON.stringify({
    choices: [{ message: { role: 'assistant', content } }],
    usage: { prompt_tokens: 12, completion_tokens: 8 },
  })
}

export async function startMockServer(): Promise<MockServer> {
  const queue: MockReply[] = []
  const requests: CapturedRequest[] = []
  const open = new Set<import('node:http').ServerResponse>()

  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      let body: unknown = raw
      try {
        body = JSON.parse(raw)
      } catch {
        // Keep the raw text; a malformed request is itself worth asserting.
      }
      requests.push({
        method: request.method ?? '',
        url: request.url ?? '',
        ...(typeof request.headers.authorization === 'string'
          ? { authorization: request.headers.authorization }
          : {}),
        body,
      })
      open.add(response)
      response.on('close', () => open.delete(response))

      const reply = queue.length > 1 ? (queue.shift() as MockReply) : (queue[0] ?? {})
      void serve(reply, response)
    })
  })

  async function serve(reply: MockReply, response: import('node:http').ServerResponse): Promise<void> {
    if (reply.hang === true) return
    if (reply.waitFor !== undefined) await reply.waitFor
    if (reply.delayMs !== undefined) await new Promise((resolve) => setTimeout(resolve, reply.delayMs))
    if (response.writableEnded) return
    response.writeHead(reply.status ?? 200, { 'content-type': 'application/json' })
    response.end(reply.body ?? completion('ok'))
  }

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo

  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    push(reply) {
      queue.push(reply)
    },
    async close() {
      for (const response of open) response.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
