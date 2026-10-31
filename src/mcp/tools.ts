/**
 * ArrayCAD's operations as MCP tools: the app's panels, one tool per thing a person does.
 *
 * Each tool is a thin wrapper over `session.ts`, which is in turn a thin wrapper over the
 * functions `App.tsx` calls. The schemas are strict — unknown arguments are refused — and
 * every answer says what changed in this model, with counts, the way the Prepare panel's
 * report does: a pass that silently left out forty objects is indistinguishable from an
 * importer that lost them.
 */

import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { ACCEPTED_EXTENSIONS } from '../lib/import/index.ts'
import { PLANE_TYPES } from '../lib/dbacv/types.ts'
import type { PrepareSettings } from '../state.ts'
import { PROVIDER_VERSION } from '../lib/mvr/write.ts'
import type { Target } from '../targets.ts'
import { type JsonSchema, type ServerInfo, type Tool, ToolError } from './protocol.ts'
import {
  type ReductionPatch,
  type Session,
  type TreeQuery,
  TARGETS,
  addArea,
  buildTarget,
  convert,
  editArea,
  openModel,
  parsePlaneType,
  parseUnits,
  rePrepare,
  removeArea,
  setNodes,
  setPlacement,
  setReduction,
  status,
  tree,
} from './session.ts'

export const SERVER_INFO: ServerInfo = {
  name: 'arraycad',
  version: PROVIDER_VERSION,
  instructions: [
    'ArrayCAD turns CAD venue models into d&b ArrayCalc venues (.dbacv), and writes Soundvision 3D room data (.txt), EASE Focus 3 (.fc3) and MVR as well. It works on files on this machine; nothing is uploaded.',
    'The work, in order: open_model — preparation runs at once, leaving out clutter, guessing plane types from names and shapes, and flattening scattered seats into areas. Then read status: the units and up axis may be GUESSES, and venueBounds.size should look like a room (tens of metres), not a city or a shoebox — fix them with set_placement. list_tree shows what is left in; set_nodes prunes and types it; convert reports the object count and warnings; export writes the file.',
    'Venue space is metres, Z up, +X towards the audience (stage at negative X). Plane types are shown as code and label; only 0 None and 5 Positioning area are confirmed names, the rest are inferred, so name the code when it matters. One model is open at a time.',
  ].join('\n\n'),
}

/** `~/x` and relative paths, resolved the way a shell in the client's directory would. */
function resolvePath(p: string): string {
  const expanded = p === '~' || p.startsWith('~/') ? join(homedir(), p.slice(1)) : p
  return resolve(process.cwd(), expanded)
}

const PLANE_TYPE: JsonSchema = {
  oneOf: [{ type: 'integer', enum: PLANE_TYPES.map((p) => p.code) }, { type: 'string' }],
  description: `ArrayCalc plane type, as a code or a label: ${PLANE_TYPES.map((p) => `${p.code} ${p.label}${p.verified ? '' : ' (inferred)'} — ${p.hint}`).join(' ')}`,
}

const UNITS: JsonSchema = {
  oneOf: [{ type: 'number', minimum: 1e-9 }, { type: 'string', enum: ['m', 'cm', 'mm', 'ft', 'in'] }],
  description: 'Source units: metres per unit (0.001 for millimetres) or one of m, cm, mm, ft, in.',
}

const XYZ: JsonSchema = { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 }

const PREPARE_OPTIONS: Record<string, JsonSchema> = {
  dropClutter: { type: 'boolean', description: 'Leave out objects whose names say they are not room surfaces (dimensions, lighting, rigging…). Default true.' },
  dropTiny: { type: 'boolean', description: 'Leave out objects with almost no surface: fixings, trim, stray facets. Default true.' },
  tinyArea: { type: 'number', minimum: 0, description: 'm². The threshold for dropTiny, on an object’s total surface. Default 0.25.' },
  flattenSeating: { type: 'boolean', description: 'Turn banks of repeated small objects, anything named as seating, and stepped rakes into one plane each. Default true.' },
  guessPlaneTypes: { type: 'boolean', description: 'Set plane types from names, and from shape where the name says nothing. Default true.' },
  tierGap: { type: 'number', minimum: 0, description: 'Metres. A jump in seat height larger than this starts a new seating area. Default 1.5.' },
  simplifyHeavy: { type: 'boolean', description: 'Re-cut heavy flat objects into fewer triangles, keeping their outline exactly. Never applied to a scan. Default true.' },
  splitOnePiece: { type: 'boolean', description: 'Cut a one-piece mesh into rakes, floor, ceiling and walls. Default true.' },
}

const AREA_OPTIONS: Record<string, JsonSchema> = {
  name: { type: 'string' },
  planeType: PLANE_TYPE,
  faces: { type: 'string', enum: ['upward', 'all'], description: '"upward" (default) keeps only faces pointing up, so a modelled seat counts as its pan; "all" for a wall or a bare rake.' },
  gapMetres: { type: 'number', minimum: 0, description: 'The largest gap bridged, in metres: set it to the row pitch. Aisles wider than it stay aisles. Default 0.9.' },
  mode: {
    type: 'string',
    enum: ['concave', 'hull', 'footprint', 'rect'],
    description: 'How the outline is made: concave (default) bridges gaps up to gapMetres; hull is the convex hull; footprint is the drawn polygon; rect is a level bounding rectangle, required for a Positioning area.',
  },
  replaceMembers: { type: 'boolean', description: 'Take the member objects out of the venue, replaced by this area. Default true, or false when a footprint is drawn.' },
}

function need(state: { session: Session | null }): Session {
  if (!state.session) throw new ToolError('No model is open. Call open_model first.')
  return state.session
}

/** The tools, over one session. A fresh set per server, so the tests can run several. */
export function arraycadTools(state: { session: Session | null } = { session: null }): Tool[] {
  return [
    {
      name: 'open_model',
      title: 'Open a model',
      description:
        `Import a CAD model or venue file and prepare it, replacing any model already open. Reads ${ACCEPTED_EXTENSIONS.join(' ')}. ` +
        'Units and up axis come from the file when it states them and are guessed otherwise; the answer says which. Give units or upAxis to override before preparation decides anything (its thresholds are in metres). ' +
        'A .dbacv, Soundvision .txt or .fc3 is already a venue and is not prepared. A PDF, an image, or a DXF of lines that never close cannot be converted here: those are traced in the ArrayCAD app.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['path'],
        properties: {
          path: { type: 'string', description: 'The file. Relative paths resolve against the server’s working directory.' },
          units: UNITS,
          upAxis: { type: 'string', enum: ['y', 'z'], description: 'Which source axis points up.' },
          surface: { type: 'string', enum: ['cad', 'scan'], description: 'Read the model as modelled (flat means exactly flat) or as a scan (flat to within its noise). Guessed when omitted.' },
          prepare: { type: 'object', additionalProperties: false, properties: PREPARE_OPTIONS, description: 'Preparation options; omitted ones take their defaults.' },
        },
      },
      async run(a) {
        state.session = await openModel(resolvePath(a.path as string), {
          metresPerUnit: a.units === undefined ? undefined : parseUnits(a.units),
          upAxis: a.upAxis as 'y' | 'z' | undefined,
          surface: a.surface as 'cad' | 'scan' | undefined,
          prepare: a.prepare as Record<string, never> | undefined,
        })
        return status(state.session)
      },
    },
    {
      name: 'status',
      title: 'Model status',
      description: 'The open model: format, counts, units and up axis with where each came from, placement, venue bounds, reduction settings, import warnings, what preparation did, and the rationalised areas.',
      inputSchema: { type: 'object', additionalProperties: false, properties: {} },
      annotations: { readOnlyHint: true },
      run: () => status(need(state)),
    },
    {
      name: 'list_tree',
      title: 'List the object tree',
      description:
        'Rows of the object tree, labelled as the app labels them, with each row’s id, triangle count, include state (all / none / "n of m" for a container), plane type, and whether preparation left it out and why. ' +
        'Without match, lists `depth` levels from the top or from `under`. With match, finds every node whose label, name or tag contains the text, at any depth, with its path. Paged by limit and offset.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          under: { type: 'string', description: 'A node id: list its children instead of the top level.' },
          depth: { type: 'integer', minimum: 1, description: 'Levels to list. Default 2.' },
          match: { type: 'string', description: 'Case-insensitive text to find in labels, names and tags.' },
          limit: { type: 'integer', minimum: 1, maximum: 1000, description: 'Default 100.' },
          offset: { type: 'integer', minimum: 0 },
          bounds: { type: 'boolean', description: 'Add each row’s box in venue metres. Useful for finding the stage or setting an origin.' },
        },
      },
      annotations: { readOnlyHint: true },
      run: (a) => tree(need(state), a as TreeQuery),
    },
    {
      name: 'set_nodes',
      title: 'Include, exclude, type or rename',
      description:
        'Decide about nodes, as the tree’s checkboxes and the inspector do. Include and plane type apply to every object under each node named unless subtree is false; a name applies to exactly one node. ' +
        'Nothing is deleted: a left-out object can be included again at any time.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ids: { type: 'array', items: { type: 'string' }, description: 'Node ids from list_tree.' },
          match: { type: 'string', description: 'Also every node whose label, name or tag contains this text.' },
          include: { type: 'boolean' },
          planeType: PLANE_TYPE,
          name: { type: 'string', description: 'Rename one node. The name is what the exported object is called.' },
          subtree: { type: 'boolean', description: 'Apply to everything under each node too. Default true.' },
        },
      },
      run: (a) =>
        setNodes(need(state), {
          ids: a.ids as string[] | undefined,
          match: a.match as string | undefined,
          include: a.include as boolean | undefined,
          planeType: a.planeType === undefined ? undefined : parsePlaneType(a.planeType),
          name: a.name as string | undefined,
          subtree: a.subtree as boolean | undefined,
        }),
    },
    {
      name: 'set_placement',
      title: 'Units, axis and origin',
      description:
        'The Placement panel. Units and up axis, then heading (degrees about Z, to aim the room down +X), mirror, offset, and last originAt: a point in VENUE metres, from status.venueBounds or list_tree bounds, that becomes the origin. ' +
        'Set the heading before the origin, or in the same call. Changing units or axis does not re-run preparation; the answer says when it should be.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          units: UNITS,
          upAxis: { type: 'string', enum: ['y', 'z'] },
          headingDeg: { type: 'number' },
          flipX: { type: 'boolean', description: 'Mirror X, for a model that came in back to front.' },
          offset: { ...XYZ, description: 'Metres: where the source origin lands in venue space.' },
          originAt: { ...XYZ, description: 'A venue-space point, in metres, to move the origin onto.' },
        },
      },
      run: (a) =>
        setPlacement(need(state), {
          metresPerUnit: a.units === undefined ? undefined : parseUnits(a.units),
          upAxis: a.upAxis as 'y' | 'z' | undefined,
          headingDeg: a.headingDeg as number | undefined,
          flipX: a.flipX as boolean | undefined,
          offset: a.offset as [number, number, number] | undefined,
          originAt: a.originAt as [number, number, number] | undefined,
        }),
    },
    {
      name: 'set_reduction',
      title: 'Simplification settings',
      description:
        'How triangles become planes. fit "exact" keeps each outline (a face that is not a symmetric trapezoid may split into two triangles); "rect" writes one level rectangle per plane. ' +
        'Changing surface between cad and scan re-runs preparation from the file as imported, which resets pruning and areas.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          surface: { type: 'string', enum: ['cad', 'scan'] },
          fit: { type: 'string', enum: ['exact', 'rect'] },
          simplifyTolerance: { type: 'number', minimum: 0, description: 'Metres, on recovered outlines. Default 0.05.' },
          maxObjectsPerNode: { type: 'integer', minimum: 0, description: 'Keep only the largest N planes per node. 0 is no cap.' },
          weldTolerance: { type: 'number', minimum: 0, description: 'Metres. Vertices closer than this are one vertex. Default 0.001.' },
          angleTolerance: { type: 'number', minimum: 0, description: 'Degrees a triangle may turn from its plane and still join it. Default 5.' },
          offsetTolerance: { type: 'number', minimum: 0, description: 'Metres a triangle may sit off its plane and still join it. Default 0.02.' },
          minArea: { type: 'number', minimum: 0, description: 'm². Planes smaller than this are dropped. Default 0.05.' },
        },
      },
      run: (a) => setReduction(need(state), a as ReductionPatch),
    },
    {
      name: 'prepare',
      title: 'Re-run preparation',
      description:
        'Run preparation again from the file as imported, against the units and axis set now, with any options changed. This RESETS hand pruning and areas, as unticking a Prepare box in the app does. Does nothing to a file that is already a venue.',
      inputSchema: { type: 'object', additionalProperties: false, properties: PREPARE_OPTIONS },
      run(a) {
        const s = need(state)
        rePrepare(s, a as Partial<PrepareSettings>)
        return status(s).preparation
      },
    },
    {
      name: 'add_area',
      title: 'Rationalise into one plane',
      description:
        'Stand many objects in for ONE plane — four hundred seats for one audience area — fitted through their surface. Name the members by ids or match; a footprint (venue XY metres) clips the capture to a drawn polygon, and with no members named captures everything included under it. ' +
        'Separate blocks come back as separate areas; the gap that would join them is reported, not bridged. Answers with what the area produced: outlines, residual off the plane, areas captured and emitted.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ids: { type: 'array', items: { type: 'string' } },
          match: { type: 'string' },
          footprint: { type: 'array', minItems: 3, items: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 }, description: 'Polygon corners [x, y] in venue metres.' },
          ...AREA_OPTIONS,
        },
      },
      run(a) {
        const { planeType, ...rest } = a
        return addArea(need(state), { ...(rest as object), ...(planeType === undefined ? {} : { planeType: parsePlaneType(planeType) }) })
      },
    },
    {
      name: 'edit_area',
      title: 'Change an area',
      description: 'Change a rationalised area — a prepared seating area or one added here. footprint: null removes a drawn footprint. Answers with what it now produces.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['id'],
        properties: {
          id: { type: 'string', description: 'From status.areas.' },
          footprint: { oneOf: [{ type: 'array', minItems: 3, items: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 } }, { type: 'null' }] },
          stepped: { type: 'boolean', description: 'A stepped rake: judge the off-plane warning on surface RMS.' },
          ...AREA_OPTIONS,
        },
      },
      run(a) {
        const { id, planeType, ...rest } = a
        return editArea(need(state), id as string, { ...(rest as object), ...(planeType === undefined ? {} : { planeType: parsePlaneType(planeType) }) })
      },
    },
    {
      name: 'remove_area',
      title: 'Remove an area',
      description: 'Delete a rationalised area. The objects it stood in for come back into the venue as they were.',
      inputSchema: { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'string' } } },
      run: (a) => removeArea(need(state), a.id as string),
    },
    {
      name: 'convert',
      title: 'Convert to ArrayCalc',
      description:
        'Run the conversion the app shows live: objects out, by plane type, the reduction’s statistics, every warning, each area’s result, and a flag when what is left in is a flat 2D plan. objects: true lists the objects themselves.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          objects: { type: 'boolean', description: 'List each object: name, shape, plane type, origin.' },
          limit: { type: 'integer', minimum: 1, maximum: 2000, description: 'Objects listed at most. Default 200.' },
        },
      },
      annotations: { readOnlyHint: true },
      run: (a) => convert(need(state), a as { objects?: boolean; limit?: number }),
    },
    {
      name: 'export',
      title: 'Write a venue file',
      description:
        `Write the venue as one of: ${Object.entries(TARGETS).map(([k, v]) => `${k} — ${v}`).join('; ')}. ` +
        'Defaults to <projectName><extension> beside the model. Refuses to overwrite an existing file unless overwrite is true, and never writes over the model it read.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['format'],
        properties: {
          format: { type: 'string', enum: Object.keys(TARGETS) },
          path: { type: 'string' },
          projectName: { type: 'string', description: 'The project name written into the file, kept for later exports. Defaults to the model’s file name.' },
          overwrite: { type: 'boolean' },
        },
      },
      annotations: { destructiveHint: false },
      async run(a) {
        const s = need(state)
        if (a.projectName !== undefined) s.projectName = a.projectName as string
        const target = a.format as Target
        const file = buildTarget(s, target, s.projectName)
        if (file.count === 0) {
          throw new ToolError(
            target === 'fc3'
              ? 'Nothing to write: EASE Focus takes only Listening planes (plane type 1), and none is included.'
              : 'Nothing to write: no included object produced a plane. convert says why.',
          )
        }
        const out = resolvePath((a.path as string | undefined) ?? join(dirname(s.path), `${s.projectName || 'venue'}${file.extension}`))
        if (out === s.path) throw new ToolError(`${out} is the model that was opened; write somewhere else.`)
        if (existsSync(out) && !a.overwrite) throw new ToolError(`${out} already exists. Pass overwrite: true to replace it.`)
        await writeFile(out, file.data)
        return {
          wrote: out,
          format: TARGETS[target],
          bytes: typeof file.data === 'string' ? Buffer.byteLength(file.data) : file.data.length,
          count: file.count,
          stats: file.stats,
          warnings: [...new Set(file.warnings)],
        }
      },
    },
  ]
}
