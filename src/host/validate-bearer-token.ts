import type { TokenValidationResult } from './server-contract.js'

const DEFAULT_TIMEOUT_MS = 5_000

/**
 * The validation call got an answer that is no verdict on the token: a 5xx, a 429, a redirect,
 * or a 404 from a misconfigured base URL. `httpStatusCode` is what a host reads to treat a 5xx
 * as transient and a 429 as the token's user being rate-limited. `retryAfterSeconds` is the
 * response's `Retry-After`, when it sent one that can be read.
 */
export class TokenValidationError extends Error {
    readonly httpStatusCode: number
    readonly retryAfterSeconds: number | undefined

    constructor(
        httpStatusCode: number,
        { retryAfterSeconds }: { retryAfterSeconds?: number } = {},
    ) {
        super(`Token validation failed with status ${httpStatusCode}`)
        this.name = 'TokenValidationError'
        this.httpStatusCode = httpStatusCode
        this.retryAfterSeconds = retryAfterSeconds
    }
}

/**
 * The seconds a `Retry-After` header asks for (RFC 9110 section 10.2.3): its delay-seconds, or the
 * time until its HTTP date, never below 0. Undefined when the header is missing or unreadable.
 */
function parseRetryAfter(value: string | null): number | undefined {
    if (value === null) return undefined
    const trimmed = value.trim()
    if (/^\d+$/.test(trimmed)) return Number(trimmed)
    // An HTTP date always names its day and month. Without a letter, Date.parse would read a
    // stray number such as "-5" as a year.
    if (!/[a-z]/i.test(trimmed)) return undefined
    const date = Date.parse(trimmed)
    if (Number.isNaN(date)) return undefined
    return Math.max(0, Math.ceil((date - Date.now()) / 1000))
}

export type ValidateBearerTokenOptions = {
    /** An endpoint every usable token can read, ideally the cheapest one. */
    url: string | URL
    token: string
    /** Sent with the request, for example to tag it for usage tracking. */
    headers?: Record<string, string>
    /** How long to wait before giving up with a `TimeoutError`. Defaults to 5 seconds. */
    timeoutMs?: number
    /**
     * Classifies a 403. Defaults to `forbidden`. A product whose 403 can also mean a refusal that
     * consent cannot lift reads the response here, such as its `WWW-Authenticate` challenge.
     */
    classifyForbidden?: (response: Response) => TokenValidationResult
    /**
     * Sends the request. Defaults to the global `fetch`. A server whose API client has its own
     * transport passes it here, so validation takes the same route as every other call: through
     * a proxy from `HTTPS_PROXY`, for example.
     */
    fetch?: (url: string | URL, init: RequestInit) => Promise<Response>
}

/**
 * Validates a bearer token with one status-only `GET`: 2xx is `valid`, 401 `invalid`, 403
 * `forbidden` (or whatever `classifyForbidden` says). The body is drained unread, so a change
 * to the response's shape can never misclassify a token.
 *
 * Redirects are not followed: a 302 to a sign-in page that anyone can load would otherwise
 * come back 200 and pass for an accepted token.
 *
 * @throws {TokenValidationError} for any other status, a redirect included, carrying the
 * response's `Retry-After`. Network and timeout errors propagate unchanged.
 */
export async function validateBearerToken({
    url,
    token,
    headers,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    classifyForbidden = () => 'forbidden',
    fetch: send = fetch,
}: ValidateBearerTokenOptions): Promise<TokenValidationResult> {
    const requestHeaders = new Headers(headers)
    requestHeaders.set('Authorization', `Bearer ${token}`)

    const response = await send(url, {
        headers: requestHeaders,
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
    })
    // Read to the end without decoding, so the connection goes back to the pool: cancelling the
    // body instead closes it, and the next validation pays for a new handshake. The verdict comes
    // from the status, so a body that fails to arrive does not change it.
    await response.body?.pipeTo(new WritableStream()).catch(() => undefined)

    if (response.ok) return 'valid'
    if (response.status === 401) return 'invalid'
    if (response.status === 403) return classifyForbidden(response)
    throw new TokenValidationError(response.status, {
        retryAfterSeconds: parseRetryAfter(response.headers.get('retry-after')),
    })
}
