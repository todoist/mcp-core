import { statusOf } from './transient.js'

/** How a host answers a validation the API refused with a 429. */
export type ValidationRateLimit = {
    /** The API's `Retry-After`, in seconds. Undefined when it sent none, so the host picks one. */
    retryAfterSeconds: number | undefined
}

/**
 * Whether a `ValidateToken` rejection is the API rate-limiting the token's user (a 429), and if
 * so how long the API asked the client to wait. Undefined for any other rejection.
 *
 * A 429 is no verdict on the token, and retrying it at once only spends more of the user's
 * limit, so it is not transient either. A host answers 429 with `Retry-After` rather than
 * letting the request through, where the same limit would refuse it again, and never caches it
 * as a verdict.
 */
export function getValidationRateLimit(error: unknown): ValidationRateLimit | undefined {
    if (error === null || typeof error !== 'object' || statusOf(error) !== 429) return undefined
    const retryAfter = (error as { retryAfterSeconds?: unknown }).retryAfterSeconds
    return {
        retryAfterSeconds:
            typeof retryAfter === 'number' && Number.isFinite(retryAfter) && retryAfter >= 0
                ? retryAfter
                : undefined,
    }
}
