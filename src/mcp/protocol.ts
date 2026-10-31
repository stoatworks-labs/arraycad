/* ---------------------------------------------------------------------------
 * VENDORED from stoatworks-backend/mcp/protocol.ts. Do not edit here: the next
 * sync overwrites it. Change the master, then run
 *     stoatworks-backend/scripts/sync-mcp.py --apply
 * and commit this copy in every repo that has one.
 * --------------------------------------------------------------------------- */
/**
 * The Model Context Protocol, as much of it as a tool server needs.
 *
 * JSON-RPC 2.0, one message per line on stdin and stdout, and four methods: `initialize`,
 * `ping`, `tools/list` and `tools/call`, plus the progress and cancellation notifications.
 * That is the whole of the stdio transport for a server that offers tools and nothing else.
 *
 * Hand-rolled rather than taken from `@modelcontextprotocol/sdk`. The SDK brings an HTTP
 * server, a schema library and a dozen transitive packages into a static web app, every
 * one of them a Dependabot pull request, to frame messages this simple. What it would have
 * guaranteed — that a real client can talk to this — is what each server's `mcp.test.ts`
 * checks, by driving the actual server process over its own stdio.
 *
 * Nothing here knows about any one application. `tools.ts` beside it is the application;
 * this is the wire, and every server has the same copy of it. So it depends on nothing but
 * Node and uses no syntax Node's type stripping refuses: a server run straight from source
 * and one run through Vite's module runner both load it as it is.
 */

/** The subset of JSON Schema the tools use, and the subset `validate` checks. */
export interface JsonSchema {
  type?: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null'
  description?: string
  properties?: Record<string, JsonSchema>
  required?: string[]
  additionalProperties?: boolean
  items?: JsonSchema
  enum?: (string | number)[]
  minimum?: number
  maximum?: number
  minItems?: number
  maxItems?: number
  /** Either form is accepted: a string preset, or a number. */
  oneOf?: JsonSchema[]
  default?: unknown
}

export interface ToolContext {
  /** Aborted when the client cancels the call. */
  signal: AbortSignal
  /** Reports progress if the client asked for it, and does nothing if it did not. */
  progress(done: number, total?: number, message?: string): void
}

export interface Tool {
  name: string
  title: string
  description: string
  inputSchema: JsonSchema
  annotations?: {
    readOnlyHint?: boolean
    destructiveHint?: boolean
    idempotentHint?: boolean
    openWorldHint?: boolean
  }
  /** Returns what the model reads: a string as it is, anything else as JSON. */
  run(args: Record<string, unknown>, ctx: ToolContext): unknown
}

/**
 * A refusal the model should read and act on: nothing open yet, a file that already exists.
 * Reported as a tool result with `isError`, never as a protocol error, because the model
 * sees the first and only the client sees the second.
 */
export class ToolError extends Error {}

export interface ServerInfo {
  name: string
  version: string
  /** Sent once at `initialize`. What a model should know before its first call. */
  instructions?: string
}

/**
 * Newest first. A client asking for one of these gets it back; anything else gets the
 * newest. The tools surface has not changed shape across any of them.
 */
export const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']

type Id = string | number

class RpcError extends Error {
  code: number
  constructor(code: number, message: string) {
    super(message)
    this.code = code
  }
}

/**
 * Check `value` against `schema`. Returns every problem found, worded for the model.
 *
 * Unknown properties are refused rather than ignored. A model that writes `outputpath`
 * for `outputPath` would otherwise get a cheerful "done" and nothing changed.
 */
export function validate(schema: JsonSchema, value: unknown, path = 'arguments'): string[] {
  if (schema.oneOf) {
    const each = schema.oneOf.map((s) => validate(s, value, path))
    return each.some((p) => p.length === 0) ? [] : [`${path}: ${each.map((p) => p.join(', ')).join(' or ')}`]
  }
  const out: string[] = []
  const t = schema.type
  const kind = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value
  if (t === 'integer' ? !(typeof value === 'number' && Number.isInteger(value)) : t && t !== kind) {
    return [`${path} must be ${t === 'array' || t === 'object' || t === 'integer' ? 'an' : 'a'} ${t}, not ${kind}`]
  }
  if (schema.enum && !schema.enum.includes(value as string | number)) {
    out.push(`${path} must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(', ')}`)
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) out.push(`${path} must be finite`)
    if (schema.minimum !== undefined && value < schema.minimum) out.push(`${path} must be at least ${schema.minimum}`)
    if (schema.maximum !== undefined && value > schema.maximum) out.push(`${path} must be at most ${schema.maximum}`)
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      out.push(`${path} needs at least ${schema.minItems} item(s)`)
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      out.push(`${path} takes at most ${schema.maxItems} item(s)`)
    }
    if (schema.items) value.forEach((v, i) => out.push(...validate(schema.items!, v, `${path}[${i}]`)))
  }
  if (kind === 'object' && schema.properties) {
    const obj = value as Record<string, unknown>
    for (const r of schema.required ?? []) if (obj[r] === undefined) out.push(`${path}.${r} is required`)
    for (const [k, v] of Object.entries(obj)) {
      const s = schema.properties[k]
      if (s) out.push(...validate(s, v, `${path}.${k}`))
      else if (schema.additionalProperties === false) {
        out.push(`${path}.${k} is not a known argument (known: ${Object.keys(schema.properties).join(', ')})`)
      }
    }
  }
  return out
}

/**
 * A tool's answer as the model reads it: indented, but with each array of plain values on
 * one line, and floats cut to six significant figures. `1.526360848554494` m of gap is a
 * millimetre-scale fact written to the femtometre, and a bounding box down eighteen lines
 * costs more to read than it says.
 */
export function formatJson(value: unknown): string {
  const text = JSON.stringify(
    value,
    (_k, v) => (typeof v === 'number' && !Number.isInteger(v) ? Number(v.toPrecision(6)) : v),
    2,
  )
  return text.replace(/\[\s*\n\s*([^[\]{}]*?)\s*\n\s*\]/g, (_m, items: string) => `[${items.split(/,\s*\n\s*/).join(', ')}]`)
}

/**
 * The server. `handle` takes one line of input; everything it has to say goes to `send`.
 *
 * Tool calls run one at a time, in the order they arrive. The tools share one open document
 * and some of them wait on I/O, and a client is free to send several calls at once; run
 * concurrently, a read could see a document that an open call behind it is halfway through
 * replacing. Pings and cancellations are answered at once, ahead of the queue.
 */
export function createMcpServer(info: ServerInfo, tools: Tool[], send: (message: object) => void) {
  const byName = new Map(tools.map((t) => [t.name, t]))
  const running = new Map<Id, AbortController>()
  let queue: Promise<unknown> = Promise.resolve()

  const describe = (t: Tool) => ({
    name: t.name,
    title: t.title,
    description: t.description,
    inputSchema: t.inputSchema,
    ...(t.annotations ? { annotations: { title: t.title, ...t.annotations } } : {}),
  })

  async function callTool(params: Record<string, unknown>, id: Id): Promise<object> {
    const tool = byName.get(String(params.name))
    if (!tool) throw new RpcError(-32602, `Unknown tool: ${String(params.name)}`)
    const args = (params.arguments ?? {}) as Record<string, unknown>
    const problems = validate(tool.inputSchema, args)
    if (problems.length > 0) {
      return { content: [{ type: 'text', text: `Invalid arguments for ${tool.name}:\n- ${problems.join('\n- ')}` }], isError: true }
    }

    const controller = new AbortController()
    running.set(id, controller)
    const token = (params._meta as { progressToken?: Id } | undefined)?.progressToken
    const ctx: ToolContext = {
      signal: controller.signal,
      progress(progress, total, message) {
        if (token === undefined) return
        send({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: token, progress, total, message } })
      },
    }
    try {
      const out = await tool.run(args, ctx)
      return { content: [{ type: 'text', text: typeof out === 'string' ? out : formatJson(out) }] }
    } catch (e) {
      const message = e instanceof ToolError ? e.message : `${tool.name} failed: ${(e as Error)?.stack ?? String(e)}`
      return { content: [{ type: 'text', text: message }], isError: true }
    } finally {
      running.delete(id)
    }
  }

  async function request(method: string, params: Record<string, unknown>, id: Id): Promise<object> {
    switch (method) {
      case 'initialize': {
        const asked = String(params.protocolVersion ?? '')
        return {
          protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: info.name, version: info.version },
          ...(info.instructions ? { instructions: info.instructions } : {}),
        }
      }
      case 'ping':
        return {}
      case 'tools/list':
        return { tools: tools.map(describe) }
      case 'tools/call': {
        const run = queue.then(() => callTool(params, id))
        queue = run.catch(() => undefined)
        return run
      }
      default:
        throw new RpcError(-32601, `Method not found: ${method}`)
    }
  }

  function notification(method: string, params: Record<string, unknown>) {
    if (method === 'notifications/cancelled') running.get(params.requestId as Id)?.abort(params.reason)
    // notifications/initialized and anything else: nothing to do.
  }

  async function handle(line: string): Promise<void> {
    const text = line.trim()
    if (!text) return
    let msg: unknown
    try {
      msg = JSON.parse(text)
    } catch {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
      return
    }
    if (typeof msg !== 'object' || msg === null || Array.isArray(msg)) {
      // A batch. Removed from the protocol in 2025-06-18 and never sent by a client that
      // negotiated a version this server offers.
      send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request: one message per line' } })
      return
    }
    const m = msg as { id?: Id | null; method?: unknown; params?: unknown }
    // A response to a request this server never makes.
    if (typeof m.method !== 'string') return
    const params = (m.params && typeof m.params === 'object' ? m.params : {}) as Record<string, unknown>
    if (m.id === undefined || m.id === null) {
      notification(m.method, params)
      return
    }
    const id = m.id
    try {
      send({ jsonrpc: '2.0', id, result: await request(m.method, params, id) })
    } catch (e) {
      const code = e instanceof RpcError ? e.code : -32603
      send({ jsonrpc: '2.0', id, error: { code, message: (e as Error)?.message ?? String(e) } })
    }
  }

  return { handle }
}

/**
 * Serve over this process's stdin and stdout until stdin closes.
 *
 * stdout carries protocol and nothing else, so anything the libraries print has to go
 * elsewhere — and has to be moved BEFORE they load, which is why each server's entry point
 * does that and not this function. Lines are handled as they arrive, not one after another: a ping
 * must be answered while a long tool call is still running. When stdin closes, calls
 * already received are finished and answered before this resolves.
 */
export async function serveStdio(info: ServerInfo, tools: Tool[]): Promise<void> {
  const { createInterface } = await import('node:readline')
  const write = process.stdout.write.bind(process.stdout)
  const server = createMcpServer(info, tools, (message) => write(JSON.stringify(message) + '\n'))
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
  const pending = new Set<Promise<void>>()
  lines.on('line', (line) => {
    const p = server.handle(line).finally(() => pending.delete(p))
    pending.add(p)
  })
  await new Promise<void>((resolve) => lines.on('close', resolve))
  while (pending.size) await Promise.all(pending)
}
