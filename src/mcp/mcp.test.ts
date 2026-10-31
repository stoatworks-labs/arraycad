/**
 * The MCP server, from the protocol up, against the repo's own demo and fixture files.
 *
 * Three layers. The protocol on its own, because a client that cannot negotiate never gets
 * as far as a tool. The tools, driven in process the way a model drives them — open, read,
 * decide, convert, write — with every file written read back by the importer that would
 * read it in the target application's place. And the real server process over its own
 * stdio, because the launcher, the module runner and stdout carrying nothing but protocol
 * are exactly the parts no in-process test can see.
 */

import { describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'
import { parseDbacv } from '../lib/dbacv/read.ts'
import { Shape, type RoomObject } from '../lib/dbacv/types.ts'
import { readSoundvision } from '../lib/soundvision/read.ts'
import { readEaseFocus } from '../lib/easefocus/read.ts'
import { PROTOCOL_VERSIONS, type Tool, createMcpServer, formatJson, validate } from './protocol.ts'
import { SERVER_INFO, arraycadTools } from './tools.ts'

const repo = (p: string) => fileURLToPath(new URL(`../../${p}`, import.meta.url))
const scratch = () => mkdtempSync(join(tmpdir(), 'arraycad-mcp-'))

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any

/** An in-process client. `call` answers with the tool's text, parsed when it is JSON. */
function client(tools: Tool[] = arraycadTools()) {
  const sent: Json[] = []
  const server = createMcpServer(SERVER_INFO, tools, (m) => sent.push(m))
  let seq = 0
  const request = async (method: string, params?: object): Promise<Json> => {
    const id = ++seq
    await server.handle(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
    return sent.find((m) => m.id === id)
  }
  const call = async (name: string, args: object = {}): Promise<{ isError: boolean; text: string; json: Json }> => {
    const r = await request('tools/call', { name, arguments: args })
    const text: string = r.result.content[0].text
    let json: Json = null
    try {
      json = JSON.parse(text)
    } catch {
      // A refusal is prose.
    }
    return { isError: !!r.result.isError, text, json }
  }
  return { sent, server, request, call }
}

/** Every leaf object in a parsed venue. */
const leaves = (os: RoomObject[]): RoomObject[] => os.flatMap((o) => (o.shape === Shape.Group ? leaves(o.children) : [o]))

describe('protocol', () => {
  it('echoes a protocol version it knows, and offers its newest for one it does not', async () => {
    const c = client()
    const known = await c.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } })
    expect(known.result.protocolVersion).toBe('2025-06-18')
    expect(known.result.capabilities.tools).toBeDefined()
    expect(known.result.serverInfo.name).toBe('arraycad')
    expect(known.result.instructions).toMatch(/GUESSES/)
    const future = await c.request('initialize', { protocolVersion: '2099-01-01' })
    expect(future.result.protocolVersion).toBe(PROTOCOL_VERSIONS[0])
  })

  it('lists every tool with a strict object schema', async () => {
    const { result } = await client().request('tools/list')
    const names = result.tools.map((t: Json) => t.name)
    expect(names).toEqual([
      'open_model', 'status', 'list_tree', 'set_nodes', 'set_placement', 'set_reduction',
      'prepare', 'add_area', 'edit_area', 'remove_area', 'convert', 'export',
    ])
    for (const t of result.tools) {
      expect(t.inputSchema.type).toBe('object')
      expect(t.inputSchema.additionalProperties).toBe(false)
      expect(t.description.length).toBeGreaterThan(40)
    }
  })

  it('answers protocol mistakes as protocol errors, and notifications not at all', async () => {
    const c = client()
    expect((await c.request('resources/list')).error.code).toBe(-32601)
    expect((await c.request('tools/call', { name: 'no_such_tool' })).error.code).toBe(-32602)
    await c.server.handle('{not json')
    expect(c.sent.at(-1)).toMatchObject({ id: null, error: { code: -32700 } })
    const before = c.sent.length
    await c.server.handle(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }))
    expect(c.sent.length).toBe(before)
  })

  it('refuses an argument it does not know, naming the ones it does', async () => {
    // A typo the model would otherwise be told succeeded.
    const r = await client().call('list_tree', { dept: 3 })
    expect(r.isError).toBe(true)
    expect(r.text).toMatch(/dept is not a known argument.*depth/)
    expect(validate({ type: 'integer' }, 1.5)).toEqual(['arguments must be an integer, not number'])
    expect(validate({ oneOf: [{ type: 'number' }, { type: 'string', enum: ['mm'] }] }, 'mm')).toEqual([])
  })

  it('runs tool calls one at a time, in the order they arrived', async () => {
    const order: string[] = []
    const tool = (name: string, ms: number): Tool => ({
      name,
      title: name,
      description: name,
      inputSchema: { type: 'object', properties: {} },
      run: async () => {
        await new Promise((r) => setTimeout(r, ms))
        order.push(name)
        return name
      },
    })
    const c = client([tool('slow', 30), tool('fast', 0)])
    await Promise.all([
      c.server.handle(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'slow' } })),
      c.server.handle(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'fast' } })),
    ])
    expect(order).toEqual(['slow', 'fast'])
  })

  it('reports progress only when asked, and passes a cancellation through', async () => {
    let aborted = false
    const tool: Tool = {
      name: 'work',
      title: 'work',
      description: 'work',
      inputSchema: { type: 'object', properties: {} },
      run: async (_a, ctx) => {
        ctx.progress(1, 2, 'half')
        await new Promise((r) => setTimeout(r, 20))
        aborted = ctx.signal.aborted
        return 'done'
      },
    }
    const c = client([tool])
    const call = c.server.handle(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'work', _meta: { progressToken: 'p' } } }))
    await new Promise((r) => setTimeout(r, 5))
    await c.server.handle(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 7 } }))
    await call
    expect(c.sent.find((m) => m.method === 'notifications/progress')?.params).toMatchObject({ progressToken: 'p', progress: 1, total: 2 })
    expect(aborted).toBe(true)

    const quiet = client([tool])
    await quiet.request('tools/call', { name: 'work' })
    expect(quiet.sent.some((m) => m.method)).toBe(false)
  })

  it('writes plain arrays on one line and floats to six figures', () => {
    expect(formatJson({ a: [1, 2.123456789], b: { c: 'x' } })).toBe('{\n  "a": [1, 2.12346],\n  "b": {\n    "c": "x"\n  }\n}')
  })
})

describe('a drawing, through the tools', () => {
  it('opens with the file’s own units and the preparation it implies', async () => {
    const c = client()
    expect((await c.call('status')).text).toMatch(/No model is open/)
    const { json } = await c.call('open_model', { path: repo('demo/demo-venue.dxf') })
    expect(json.format).toBe('DXF')
    expect(json.units).toMatchObject({ metresPerUnit: 0.001, source: 'stated by the file' })
    // A room, not a city: the check the instructions ask a model to make.
    expect(json.venueBounds.size[0]).toBeGreaterThan(10)
    expect(json.venueBounds.size[0]).toBeLessThan(200)
    expect(json.preparation.leftOut[0].examples).toContain('LIGHTING BARS')
    expect(json.areas.map((a: Json) => a.name)).toContain('SEATING - BALCONY')
  })

  it('prunes, types and renames by decision, and the conversion follows', async () => {
    const c = client()
    await c.call('open_model', { path: repo('demo/demo-venue.dxf') })
    const before = (await c.call('convert')).json
    const ceiling = (await c.call('list_tree', { match: 'ceiling' })).json.rows
    expect(ceiling).toHaveLength(1)

    const off = await c.call('set_nodes', { ids: [ceiling[0].id], include: false })
    expect(off.json.objectsChanged).toBe(1)
    const pruned = (await c.call('convert')).json
    expect(pruned.objectsOut).toBeLessThan(before.objectsOut)

    await c.call('set_nodes', { match: 'WALLS', planeType: 'Stage', name: 'Side walls' })
    const typed = (await c.call('convert', { objects: true })).json
    expect(typed.byPlaneType['4 Stage (inferred)']).toBeGreaterThan(before.byPlaneType['4 Stage (inferred)'])
    // Several planes go out as one group, and the group is what carries the node's name.
    expect(typed.objects.some((o: Json) => o.group === 'Side walls')).toBe(true)

    // Back in again: nothing was deleted.
    await c.call('set_nodes', { ids: [ceiling[0].id], include: true })
    expect((await c.call('convert')).json.objectsOut).toBe(typed.objectsOut + (before.objectsOut - pruned.objectsOut))
  })

  it('puts the origin on a venue-space point by subtraction, after the heading', async () => {
    const c = client()
    const open = (await c.call('open_model', { path: repo('demo/demo-venue.dxf') })).json
    const turned = (await c.call('set_placement', { headingDeg: 90 })).json
    // A quarter turn swaps the plan's two sides.
    expect(turned.venueBounds.size[0]).toBeCloseTo(open.venueBounds.size[1], 2)
    const moved = (await c.call('set_placement', { originAt: turned.venueBounds.min })).json
    expect(moved.venueBounds.min).toEqual([0, 0, 0])
    expect(moved.placement.headingDeg).toBe(90)
  })

  it('says when the units changed under a preparation decided in metres', async () => {
    const c = client()
    await c.call('open_model', { path: repo('demo/demo-venue.dxf') })
    const r = (await c.call('set_placement', { units: 'cm' })).json
    expect(r.units).toMatchObject({ metresPerUnit: 0.01, source: 'set by hand (the file states 0.001 m per unit)' })
    expect(r.note).toMatch(/run `prepare`/)
    expect((await c.call('prepare')).json.decidedAt.metresPerUnit).toBe(0.01)
  })

  it('writes all four targets, each of which reads back with what it said it wrote', async () => {
    const c = client()
    await c.call('open_model', { path: repo('demo/demo-venue.dxf') })
    const objectsOut = (await c.call('convert')).json.objectsOut
    const dir = scratch()

    const dbacv = (await c.call('export', { format: 'dbacv', path: join(dir, 'venue.dbacv'), projectName: 'Demo' })).json
    const venue = parseDbacv(readFileSync(dbacv.wrote, 'utf8'), new (new JSDOM().window.DOMParser)())
    expect(venue.projectName).toBe('Demo')
    expect(leaves(venue.objects)).toHaveLength(objectsOut)
    expect(dbacv.count).toBe(objectsOut)

    const sv = (await c.call('export', { format: 'soundvision', path: join(dir, 'room.txt') })).json
    expect(readSoundvision(readFileSync(sv.wrote, 'utf8')).scene.faces).toHaveLength(sv.count)

    const fc3 = (await c.call('export', { format: 'fc3', path: join(dir, 'venue.fc3') })).json
    expect(readEaseFocus(new Uint8Array(readFileSync(fc3.wrote))).project.zones).toHaveLength(fc3.count)

    const mvr = (await c.call('export', { format: 'mvr', path: join(dir, 'venue.mvr') })).json
    // And back in through the importer, as a visualiser's export would arrive.
    const reopened = (await c.call('open_model', { path: mvr.wrote })).json
    expect(reopened.format).toMatch(/^MVR/)
    expect(reopened.objects.withGeometry).toBe(mvr.count)
  })

  it('refuses to overwrite, to write over its own source, or to write nothing', async () => {
    const c = client()
    await c.call('open_model', { path: repo('demo/demo-venue.dxf') })
    const path = join(scratch(), 'v.dbacv')
    expect((await c.call('export', { format: 'dbacv', path })).isError).toBe(false)
    expect((await c.call('export', { format: 'dbacv', path })).text).toMatch(/already exists.*overwrite: true/)
    expect((await c.call('export', { format: 'dbacv', path, overwrite: true })).isError).toBe(false)
    expect((await c.call('export', { format: 'soundvision', path: repo('demo/demo-venue.dxf'), overwrite: true })).text).toMatch(
      /is the model that was opened/,
    )
    // An area is not an include decision: the prepared balcony stays in the venue until it
    // is removed, which is what lets its seats be left out from under it.
    await c.call('set_nodes', { match: '', include: false })
    expect((await c.call('export', { format: 'dbacv', path: join(scratch(), 'balcony.dbacv') })).json.count).toBe(1)
    await c.call('remove_area', { id: 'prep1' })
    expect((await c.call('export', { format: 'dbacv', path: join(scratch(), 'empty.dbacv') })).text).toMatch(/Nothing to write/)
  })
})

describe('seats modelled one by one', () => {
  it('arrives as two prepared areas, and as thousands of objects without them', async () => {
    // demo-seats.dxf is 3,710 ArrayCalc objects unrationalised (AGENTS.md §11).
    const c = client()
    const open = (await c.call('open_model', { path: repo('demo/demo-seats.dxf') })).json
    expect(open.preparation.summary.seatingAreas).toBe(2)
    const prepared = (await c.call('convert')).json
    expect(prepared.objectsOut).toBeLessThan(100)
    expect(prepared.areas.every((a: Json) => a.outlines > 0)).toBe(true)

    for (const a of open.areas) await c.call('remove_area', { id: a.id })
    expect((await c.call('convert')).json.objectsOut).toBeGreaterThan(3000)
  })

  it('draws round one bank of a layer the tree cannot split', async () => {
    const c = client()
    await c.call('open_model', { path: repo('demo/demo-seats.dxf'), prepare: { flattenSeating: false } })
    // The same footprint pipeline.test.ts draws round the left bank of the stalls.
    const left = (
      await c.call('add_area', { match: 'STALLS', footprint: [[0, 0.5], [30, 0.5], [30, 12], [0, 12]], gapMetres: 2, mode: 'concave' })
    ).json
    expect(left.replaceMembers).toBe(false)
    expect(left.produced.componentsOut).toBe(1)
    expect(left.produced.trianglesOutside).toBeGreaterThan(0)

    const widened = (await c.call('edit_area', { id: left.id, footprint: null })).json
    expect(widened.footprint).toBeUndefined()
    expect(widened.produced.trianglesKept).toBe(left.produced.trianglesKept + left.produced.trianglesOutside)
  })
})

describe('a file that is already a venue', () => {
  it('is left as its author built it, and converts back to ArrayCalc', async () => {
    const c = client()
    const open = (await c.call('open_model', { path: repo('test/fixtures/theatre.dbacv') })).json
    expect(open.alreadyAVenue).toBe(true)
    expect(open.preparation.ran).toBe(false)
    const out = (await c.call('export', { format: 'dbacv', path: join(scratch(), 'theatre.dbacv') })).json
    const venue = parseDbacv(readFileSync(out.wrote, 'utf8'), new (new JSDOM().window.DOMParser)())
    expect(leaves(venue.objects)).toHaveLength(out.count)
  })

  it('crosses from Soundvision to EASE Focus', async () => {
    const c = client()
    expect((await c.call('open_model', { path: repo('test/fixtures/roomdata.txt') })).json.format).toMatch(/Soundvision/)
    const out = await c.call('export', { format: 'fc3', path: join(scratch(), 'room.fc3') })
    expect(out.isError).toBe(false)
  })
})

describe('what cannot be opened', () => {
  it('says why, and what to do instead', async () => {
    const c = client()
    const dir = scratch()
    writeFileSync(join(dir, 'model.vwx'), 'not really')
    expect((await c.call('open_model', { path: join(dir, 'model.vwx') })).text).toMatch(/Vectorworks.*glTF/s)
    expect((await c.call('open_model', { path: repo('demo/demo-plan.pdf') })).text).toMatch(/TRACED in the ArrayCAD app/)
    expect((await c.call('open_model', { path: join(dir, 'missing.dxf') })).text).toMatch(/Cannot read/)
  })
})

describe('the real server process', () => {
  it('answers over stdio with nothing but protocol on stdout', async () => {
    const child = spawn(process.execPath, [repo('scripts/mcp-server.mjs')], { cwd: repo('.'), stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    child.stdout.on('data', (d) => (stdout += d))
    const lines = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'open_model', arguments: { path: 'demo/demo-onepiece.obj' } } },
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'convert', arguments: {} } },
    ]
    child.stdin.end(lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
    const code = await new Promise((r) => child.on('close', r))
    expect(code).toBe(0)

    // Every line parses: one stray console.log from a library would fail here.
    const replies = stdout.trim().split('\n').map((l) => JSON.parse(l))
    expect(replies.map((r) => r.id)).toEqual([1, 2, 3, 4])
    expect(replies[1].result.tools).toHaveLength(12)
    const opened = JSON.parse(replies[2].result.content[0].text)
    // The one-piece theatre is Y-up, said nowhere in the file, and split by preparation.
    expect(opened.upAxis).toMatchObject({ axis: 'y', source: 'guessed from the way the surfaces face' })
    expect(opened.preparation.split.nodesSplit).toBe(1)
    expect(JSON.parse(replies[3].result.content[0].text).objectsOut).toBeGreaterThan(0)
  }, 60_000)
})
