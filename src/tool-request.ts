import {
    acceptedContent,
    CLIENT_CAPABILITIES_META_KEY,
    type ClientCapabilities,
    type ElicitRequestFormParams,
    inputRequired,
    type McpServer,
    type ServerContext,
} from '@modelcontextprotocol/server'
import { z } from 'zod'
import type { Confirmation, ToolRequest } from './tool.js'

const confirmationContent = z.object({ confirm: z.boolean() })

// Ticked by default, so accepting the form means yes and declining it means no.
const confirmationForm: ElicitRequestFormParams['requestedSchema'] = {
    type: 'object',
    properties: { confirm: { type: 'boolean', title: 'Confirm', default: true } },
    required: ['confirm'],
}

/**
 * Whether the client can show a form. On 2026-07-28 each request declares its capabilities in
 * its envelope; on 2025-11-25 they were declared once at `initialize`. A stateless 2025 request
 * has neither, and so cannot be asked anything.
 */
function canAskWithForm(server: McpServer, serverContext: ServerContext): boolean {
    const envelope: Record<string, unknown> | undefined = serverContext.mcpReq.envelope
    const declared =
        (envelope?.[CLIENT_CAPABILITIES_META_KEY] as ClientCapabilities | undefined) ??
        server.server.getClientCapabilities()
    const elicitation = declared?.elicitation
    if (elicitation === undefined) return false
    // An empty object declares form mode alone; a client that names its modes has to name form.
    return elicitation.form !== undefined || elicitation.url === undefined
}

/** The `ToolRequest` a tool receives for one MCP call. */
export function createToolRequest(server: McpServer, serverContext: ServerContext): ToolRequest {
    function answer(key: string): 'confirmed' | 'declined' | undefined {
        const responses = serverContext.mcpReq.inputResponses
        if (responses === undefined || !(key in responses)) return undefined
        const content = acceptedContent(responses, key, confirmationContent)
        return content?.confirm === true ? 'confirmed' : 'declined'
    }

    return {
        answer,
        async confirm({ key, message }): Promise<Confirmation> {
            const given = answer(key)
            if (given) return { status: given }
            if (!canAskWithForm(server, serverContext)) return { status: 'unavailable' }
            return {
                status: 'asking',
                result: {
                    inputRequired: inputRequired({
                        inputRequests: {
                            [key]: inputRequired.elicit({
                                message: typeof message === 'function' ? await message() : message,
                                requestedSchema: confirmationForm,
                            }),
                        },
                    }),
                },
            }
        },
    }
}
