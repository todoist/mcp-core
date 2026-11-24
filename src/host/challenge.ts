export type BearerChallengeOptions = {
    /**
     * The RFC 6750 error code. `invalid_token` for a 401 on a token that was sent but is revoked,
     * expired or otherwise refused, so the client knows to refresh it or authorise again.
     * `insufficient_scope` for a 403 on a token that lacks a scope, so the client asks for consent
     * again. Left out when the request carried no token at all (RFC 6750 §3.1): there is nothing
     * wrong with a token that was never sent.
     */
    error?: 'invalid_token' | 'insufficient_scope'
    /** The resource's protected-resource metadata (RFC 9728), where the client finds how to authorise. */
    resourceMetadataUrl?: string
    /**
     * The scopes a token needs for this resource, sent as RFC 6750's `scope` attribute. MCP clients
     * request these first, ahead of the metadata's `scopes_supported`, so a client that can't find
     * the resource's metadata still asks for the right ones. Left out when empty.
     */
    scopes?: readonly string[]
}

/** The `WWW-Authenticate` value for a refused bearer token. */
export function buildBearerChallenge({
    error,
    resourceMetadataUrl,
    scopes,
}: BearerChallengeOptions = {}): string {
    const params = [
        ...(error ? [`error="${error}"`] : []),
        ...(resourceMetadataUrl ? [`resource_metadata="${resourceMetadataUrl}"`] : []),
        ...(scopes && scopes.length > 0 ? [`scope="${scopes.join(' ')}"`] : []),
    ]
    return params.length > 0 ? `Bearer ${params.join(', ')}` : 'Bearer'
}
