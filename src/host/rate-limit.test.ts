import { describe, expect, it } from 'vitest'
import { getValidationRateLimit } from './rate-limit.js'
import { TokenValidationError } from './validate-bearer-token.js'

describe('getValidationRateLimit', () => {
    it('reads the wait from a 429 that sent Retry-After', () => {
        expect(
            getValidationRateLimit(new TokenValidationError(429, { retryAfterSeconds: 30 })),
        ).toEqual({ retryAfterSeconds: 30 })
    })

    it('leaves the wait to the host for a 429 without Retry-After', () => {
        expect(getValidationRateLimit(new TokenValidationError(429))).toEqual({
            retryAfterSeconds: undefined,
        })
    })

    it.each([
        ['httpStatusCode', { httpStatusCode: 429, retryAfterSeconds: 5 }, 5],
        ['statusCode', { statusCode: 429 }, undefined],
    ])(
        'reads a plain object carrying the 429 as %s, as another copy of the class would be',
        (_label, error, retryAfterSeconds) => {
            expect(getValidationRateLimit(error)).toEqual({ retryAfterSeconds })
        },
    )

    it.each([
        ['negative', -1],
        ['not a number', Number.NaN],
        ['infinite', Number.POSITIVE_INFINITY],
        ['a string', '30'],
    ])('drops a wait that is %s', (_label, retryAfterSeconds) => {
        expect(getValidationRateLimit({ httpStatusCode: 429, retryAfterSeconds })).toEqual({
            retryAfterSeconds: undefined,
        })
    })

    it.each([
        ['a 503 with Retry-After', new TokenValidationError(503, { retryAfterSeconds: 30 })],
        ['a 500', new TokenValidationError(500)],
        ['a 404', new TokenValidationError(404)],
        ['a timeout', Object.assign(new Error('timed out'), { name: 'TimeoutError' })],
        ['an unrelated error', new Error('boom')],
        ['a string', '429'],
        ['null', null],
        ['undefined', undefined],
    ])('treats %s as not rate-limited', (_label, error) => {
        expect(getValidationRateLimit(error)).toBeUndefined()
    })
})
