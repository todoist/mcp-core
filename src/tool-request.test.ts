import {
    Client,
    type ClientCapabilities,
    InMemoryTransport,
    StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client'
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createToolRegistrar } from './register-tool.js'
import type { Confirmation, McpTool } from './tool.js'

type Notes = {
    remove: (id: string) => Promise<void>
    getTitle: (id: string) => Promise<string>
}

const deleteNote = {
    name: 'delete-note',
    description: 'Deletes a note.',
    parameters: { id: z.string() },
    outputSchema: { deleted: z.boolean() },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    async execute({ id }, notes, request?) {
        const confirmation: Confirmation = (await request?.confirm({
            key: 'delete',
            message: async () => `Delete "${await notes.getTitle(id)}"? It cannot be restored.`,
        })) ?? { status: 'unavailable' }
        if (confirmation.status === 'asking') return confirmation.result
        if (confirmation.status === 'declined') {
            return { textContent: `Kept note ${id}.`, structuredContent: { deleted: false } }
        }
        await notes.remove(id)
        const how = confirmation.status === 'confirmed' ? 'with confirmation' : 'without asking'
        return { textContent: `Deleted note ${id} ${how}.`, structuredContent: { deleted: true } }
    },
} satisfies McpTool<{ id: z.ZodString }, { deleted: z.ZodBoolean }, Notes>

type ElicitAnswer =
    | { action: 'accept'; content: { confirm: boolean } }
    | { action: 'decline' }
    | { action: 'cancel' }

/** What the client declares under `capabilities.elicitation`; `{}` means form mode alone. */
type ConnectOptions = { elicitation?: ClientCapabilities['elicitation'] }

const remove = vi.fn<Notes['remove']>(async () => undefined)
const getTitle = vi.fn<Notes['getTitle']>(async () => 'Groceries')
const clients: Client[] = []

afterEach(async () => {
    remove.mockClear()
    getTitle.mockClear()
    await Promise.all(clients.splice(0).map((client) => client.close()))
})

function buildServer(): McpServer {
    const server = new McpServer({ name: 'notes', version: '1.0.0' })
    createToolRegistrar<Notes>({
        titlePrefix: 'Notes',
        createContext: () => ({ remove, getTitle }),
        formatError: (error) => `Failed: ${error instanceof Error ? error.message : 'unknown'}`,
    })(server, deleteNote)
    return server
}

/** A client that records each question it is asked and answers with `answer`; none when omitted. */
function buildClient(
    answer: ElicitAnswer | undefined,
    { modern = false, elicitation = {} }: ConnectOptions & { modern?: boolean } = {},
) {
    const questions: unknown[] = []
    const client = new Client(
        { name: 'test', version: '1.0.0' },
        {
            ...(answer ? { capabilities: { elicitation } } : {}),
            ...(modern ? { versionNegotiation: { mode: { pin: '2026-07-28' as const } } } : {}),
        },
    )
    if (answer) {
        client.setRequestHandler('elicitation/create', async (request) => {
            questions.push(request.params)
            return answer
        })
    }
    clients.push(client)
    return { client, questions }
}

/** Connects over the 2025-11-25 handshake, where the SDK asks the client itself. */
async function connectLegacy(answer?: ElicitAnswer, options: ConnectOptions = {}) {
    const { client, questions } = buildClient(answer, options)
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([buildServer().connect(serverTransport), client.connect(clientTransport)])
    return { client, questions }
}

/**
 * Connects to an HTTP handler that builds a server per request: on 2026-07-28 (`modern`) the
 * client answers and calls the tool again; on 2025-11-25 the requests are stateless.
 */
async function connectOverHttp(
    answer?: ElicitAnswer,
    options: ConnectOptions & { modern?: boolean } = {},
) {
    const { client, questions } = buildClient(answer, options)
    const handler = createMcpHandler(buildServer)
    const transport = new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), {
        fetch: (input, init) => handler.fetch(new Request(input, init)),
    })
    await client.connect(transport)
    return { client, questions }
}

async function deleteN1(client: Client) {
    const result = await client.callTool({ name: 'delete-note', arguments: { id: 'n1' } })
    return {
        text: result.content.map((block) => (block.type === 'text' ? block.text : '')).at(-1),
        structuredContent: result.structuredContent,
    }
}

describe.each([
    ['2025-11-25', connectLegacy],
    [
        '2026-07-28',
        (answer?: ElicitAnswer, options: ConnectOptions = {}) =>
            connectOverHttp(answer, { ...options, modern: true }),
    ],
])('ToolRequest.confirm on %s', (_revision, connect) => {
    it('asks the user, then runs the tool once they confirm', async () => {
        const { client, questions } = await connect({
            action: 'accept',
            content: { confirm: true },
        })

        const result = await deleteN1(client)

        // The box arrives ticked, so accepting the form is what confirms.
        expect(questions).toEqual([
            expect.objectContaining({
                message: 'Delete "Groceries"? It cannot be restored.',
                requestedSchema: {
                    type: 'object',
                    properties: { confirm: { type: 'boolean', title: 'Confirm', default: true } },
                    required: ['confirm'],
                },
            }),
        ])
        // Built for the question only, not again on the call that carries the answer.
        expect(getTitle).toHaveBeenCalledTimes(1)
        expect(result).toEqual({
            text: 'Deleted note n1 with confirmation.',
            structuredContent: { deleted: true },
        })
        expect(remove).toHaveBeenCalledTimes(1)
    })

    it('does nothing when the user declines', async () => {
        const { client } = await connect({ action: 'decline' })

        const result = await deleteN1(client)

        expect(result).toEqual({ text: 'Kept note n1.', structuredContent: { deleted: false } })
        expect(remove).not.toHaveBeenCalled()
    })

    it('treats a dismissed form as declined', async () => {
        const { client } = await connect({ action: 'cancel' })

        const result = await deleteN1(client)

        expect(result).toEqual({ text: 'Kept note n1.', structuredContent: { deleted: false } })
        expect(remove).not.toHaveBeenCalled()
    })

    it('treats an accepted form with confirm unticked as declined', async () => {
        const { client } = await connect({ action: 'accept', content: { confirm: false } })

        const result = await deleteN1(client)

        expect(result).toEqual({ text: 'Kept note n1.', structuredContent: { deleted: false } })
        expect(remove).not.toHaveBeenCalled()
    })

    // Asking a client that cannot show a form would fail the whole call, so the tool is told the
    // question cannot be asked and decides for itself.
    it('reports the question as unavailable to a client without elicitation', async () => {
        const { client } = await connect()

        const result = await deleteN1(client)

        expect(result).toEqual({
            text: 'Deleted note n1 without asking.',
            structuredContent: { deleted: true },
        })
        expect(remove).toHaveBeenCalledTimes(1)
        expect(getTitle).not.toHaveBeenCalled()
    })

    it('reports the question as unavailable to a client that only opens URLs', async () => {
        const { client, questions } = await connect(
            { action: 'accept', content: { confirm: true } },
            { elicitation: { url: {} } },
        )

        const result = await deleteN1(client)

        expect(questions).toEqual([])
        expect(result).toEqual({
            text: 'Deleted note n1 without asking.',
            structuredContent: { deleted: true },
        })
    })
})

// The server built for a stateless 2025 request never saw the client's initialize, so it has no
// capabilities to go on and no channel to ask over: the call has to go ahead without asking
// rather than fail or wait on a question nobody can see.
describe('ToolRequest.confirm on stateless 2025-11-25 HTTP', () => {
    it('reports the question as unavailable even when the client declared elicitation', async () => {
        const { client, questions } = await connectOverHttp({
            action: 'accept',
            content: { confirm: true },
        })

        const result = await deleteN1(client)

        expect(questions).toEqual([])
        expect(result).toEqual({
            text: 'Deleted note n1 without asking.',
            structuredContent: { deleted: true },
        })
    })
})

// Another integration can call a tool's execute directly, with no MCP request behind it: the
// confirmation is then unavailable, and the result reads like any other.
describe('a tool called directly', () => {
    it('acts without asking', async () => {
        const result = await deleteNote.execute({ id: 'n1' }, { remove, getTitle })

        expect(result.textContent).toBe('Deleted note n1 without asking.')
        expect(remove).toHaveBeenCalledWith('n1')
        expect(getTitle).not.toHaveBeenCalled()
    })
})
