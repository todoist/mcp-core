import type {
    ContentBlock,
    InputRequiredResult,
    ToolAnnotations,
} from '@modelcontextprotocol/server'
import type { z } from 'zod'

/**
 * The three hints every tool must state. The MCP defaults (`readOnlyHint: false`,
 * `destructiveHint: true`, `idempotentHint: false`) describe the riskiest tool possible,
 * so a tool that omits one is either misdescribed or frightens a client for nothing.
 */
export type RequiredToolAnnotations = ToolAnnotations & {
    readOnlyHint: boolean
    destructiveHint: boolean
    idempotentHint: boolean
}

/** What a tool's `execute` returns, before it is shaped into an MCP `CallToolResult`. */
export type ToolResult<Output extends z.ZodRawShape = z.ZodRawShape> = {
    /** Prose for the model, sent as the last content block. */
    textContent?: string
    /** The payload `outputSchema` describes. Nulls and empty objects are stripped before it is sent. */
    structuredContent?: z.infer<z.ZodObject<Output>>
    /** Blocks the tool authors itself, such as images or embedded resources. Sent first. */
    contentItems?: ContentBlock[]
    /**
     * A question for the user instead of an answer: the client asks it and calls the tool again
     * with the reply. Returned as is, so the other fields are ignored. Comes from
     * `ToolRequest.confirm`; a `wrapExecute` that rewrites results must keep it.
     */
    inputRequired?: InputRequiredResult
}

export type ExecuteResult<Output extends z.ZodRawShape = z.ZodRawShape> = Promise<
    ToolResult<Output>
>

/**
 * A result that asks the user instead of answering. It carries nothing else, and says so in its
 * type, so a tool's result can still be read as a `ToolResult` whichever branch produced it.
 */
export type InputRequiredToolResult = {
    inputRequired: InputRequiredResult
    textContent?: undefined
    structuredContent?: undefined
    contentItems?: undefined
}

/**
 * Where a confirmation stands for this call.
 *
 * - `asking`: return `result` from `execute`. The client puts the question to the user and
 *   calls the tool again, with the same arguments, carrying the answer.
 * - `confirmed` / `declined`: the user answered. Dismissing the question counts as declining.
 * - `unavailable`: the client cannot ask (it declared no form elicitation, or the call did not
 *   come over MCP), so the tool decides on its own, as it would have without asking.
 */
export type Confirmation =
    | { status: 'asking'; result: InputRequiredToolResult }
    | { status: 'confirmed' }
    | { status: 'declined' }
    | { status: 'unavailable' }

/** The MCP request a tool call is serving, for asking the user before acting. */
export type ToolRequest = {
    /**
     * Asks the user to confirm before the tool acts, typically before something that cannot be
     * undone. The tool runs from the top again once the user answers, so it must not write
     * anything before calling this. `key` names the question within the call: a tool asking more
     * than one question in a run gives each its own key (such as the item's ID), or the later ones
     * find the first answer and act without asking. `message` says
     * exactly what will happen. Pass `message` as a function when building it costs a lookup,
     * such as the name of what is about to be deleted: it is called only when the question is
     * asked, not on the call that carries the answer or when the client cannot ask.
     *
     * The answer comes from the client and is not proof the user saw the question: this keeps a
     * model from acting alone, not a client from bypassing it.
     */
    confirm: (question: {
        key: string
        message: string | (() => string | Promise<string>)
    }) => Promise<Confirmation>
}

/**
 * A tool that can be registered on an MCP server or called directly by another
 * conversational AI integration.
 *
 * `Context` is whatever the server hands each call: an API client, or an object carrying
 * one along with an abort signal and a progress reporter.
 */
export type McpTool<
    Params extends z.ZodRawShape,
    Output extends z.ZodRawShape = Record<string, never>,
    Context = unknown,
> = {
    /** Kebab-case. Also the source of the default title ("find-tasks" gives "Find Tasks"). */
    name: string
    /** What the tool does and how to call it. This is what the model reads. */
    description: string
    /** The argument schema as a Zod raw shape, not a `z.object`. */
    parameters: Params
    /**
     * The `structuredContent` schema as a Zod raw shape. Never use `.nullable()`: nulls are
     * stripped before the SDK validates the result, so a nullable field promises a value the
     * tool cannot send. Declare it `.optional()` and leave the key out instead.
     */
    outputSchema?: Output
    annotations: RequiredToolAnnotations
    /** Sent with the tool listing, e.g. the MCP Apps `ui` resource. */
    _meta?: Record<string, unknown>
    /**
     * `request` is set when the call came over MCP, and absent when another integration calls
     * the tool directly.
     */
    execute: (
        args: z.infer<z.ZodObject<Params>>,
        context: Context,
        request?: ToolRequest,
    ) => ExecuteResult<Output>
}

/**
 * A tool of any parameter and output shape.
 *
 * `McpTool` is generic over its schemas, and `execute` is contravariant in its argument, so no
 * single instantiation of it accepts every tool. Declaring the argument as `never` does: `never`
 * is assignable to any parameter type, so a tool taking concrete args satisfies this while a
 * caller cannot invoke `execute` without narrowing back to the real tool type first.
 *
 * Use it for collections that hold tools of mixed shapes. Each tool keeps its precise type
 * through its own `satisfies McpTool<...>`.
 */
export type AnyMcpTool<Context = unknown> = Omit<
    McpTool<z.ZodRawShape, z.ZodRawShape, Context>,
    'execute'
> & {
    execute: (args: never, context: Context, request?: ToolRequest) => ExecuteResult<z.ZodRawShape>
}

/** The parts of a tool its schemas come from. Wide enough for tools not built on `McpTool`. */
export type ToolSchemaSource = {
    name: string
    parameters: z.ZodRawShape
    outputSchema?: z.ZodRawShape
}
