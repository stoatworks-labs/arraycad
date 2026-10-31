/**
 * One open model, held the way the app holds it, without React.
 *
 * The MCP server is a second FRONT END to ArrayCAD, not a second pipeline. Every step here
 * is a call into the functions `App.tsx` makes — `settingsForScene`, `prepareScene`,
 * `applyPlan`, `rationalisationsFromPlan`, `rationalisedAreas`, `targets.ts` — in the order
 * the app makes them. If what comes out differs from what the app gives for the same
 * clicks, the bug is in this file. It is never a reason to fork the reduction (AGENTS.md §6).
 *
 * The app's invariant holds here too (AGENTS.md §4): the imported scene is never edited.
 * Include, plane type and name are decisions keyed by node id, and an area is a
 * rationalisation record, so changing the units after an hour of pruning keeps the pruning.
 */

import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { PLANE_TYPES, PlaneType, Shape } from '../lib/dbacv/types.ts'
import type { RoomObject } from '../lib/dbacv/types.ts'
import {
  type ImportedNode,
  type ImportedScene,
  ImportError,
  countTriangles,
  flattenNodes,
  importFile,
} from '../lib/import/index.ts'
import { type TransformOptions, UNIT_PRESETS, applyTransform, boundsOf, withOriginAt } from '../lib/geom/transform.ts'
import type { FitMode } from '../lib/geom/outline.ts'
import type { SurfaceKind } from '../lib/geom/scan.ts'
import type { CaptureFaces, OutlineMode } from '../lib/geom/rationalise.ts'
import type { Pt2 } from '../lib/geom/polygon.ts'
import { deriveLabel, rowLabel } from '../lib/grouping.ts'
import { flatPlanReport } from '../lib/trace/index.ts'
// Pure at import time: pdf.js is behind a dynamic import inside it, and only the name test is used.
import { isTraceFile } from '../lib/trace/source.ts'
import {
  type Decisions,
  type PrepareSettings,
  type Prepared,
  type Rationalisation,
  type Settings,
  DEFAULT_PREPARE_SETTINGS,
  applyPlan,
  newRationalisation,
  prepareScene,
  rationalisationsFromPlan,
  rationalisedAreas,
  replacedNodeIds,
  seedDecisions,
  settingsForScene,
  subtreeIds,
} from '../state.ts'
import { type Target, type TargetFile, convertVenue, dbacvFile, easeFocusFile, mvrFile, soundvisionFile } from '../targets.ts'
import { ToolError } from './protocol.ts'

export interface Session {
  /** Absolute path the model was read from. */
  path: string
  /** What an export names the venue, and its default file name. */
  projectName: string
  prepareOptions: PrepareSettings
  prepared: Prepared
  settings: Settings
  decisions: Decisions
  rationalisations: Rationalisation[]
  /** Numbers the areas made here, as the app's own counter does. */
  areaSeq: number
}

export interface OpenOptions {
  /** Metres per source unit, in place of what the file states or the size suggests. */
  metresPerUnit?: number
  upAxis?: 'y' | 'z'
  surface?: SurfaceKind
  prepare?: Partial<PrepareSettings>
}

/**
 * What to say when a drawing has no surfaces but can be traced. The tracer is a drawing
 * tool — calibrate, click a room, type corner heights — and has no front end here.
 */
const TRACE_ADVICE =
  'It can be TRACED in the ArrayCAD app instead: it opens there in the tracer, where ' +
  'you calibrate the sheet, flood-fill or outline each region and type its corner heights. ' +
  'Tracing is not offered over MCP.'

/**
 * `.dbacv`, `.mvr` and `.fc3` are XML inside, and the readers take the browser's DOMParser.
 * The tests hand them jsdom's; so does this, once, the first time a file is opened.
 */
async function ensureDomParser(): Promise<void> {
  const g = globalThis as { DOMParser?: unknown }
  if (g.DOMParser) return
  const { JSDOM } = await import('jsdom')
  g.DOMParser = new JSDOM().window.DOMParser
}

export async function openModel(path: string, opts: OpenOptions = {}): Promise<Session> {
  if (isTraceFile(path)) throw new ToolError(`${basename(path)} is a drawing, with no model in it to convert. ${TRACE_ADVICE}`)
  let bytes: Uint8Array
  try {
    bytes = await readFile(path)
  } catch (e) {
    throw new ToolError(`Cannot read ${path}: ${(e as Error).message}`)
  }
  await ensureDomParser()

  let raw: ImportedScene
  try {
    raw = await importFile(new File([bytes as BlobPart], basename(path)))
  } catch (e) {
    if (e instanceof ImportError) {
      throw new ToolError([e.message, e.advice, e.traceable ? TRACE_ADVICE : ''].filter(Boolean).join('\n\n'))
    }
    throw e
  }

  // The settings the file implies, decided BEFORE preparation as the app decides them,
  // because preparation's thresholds are in metres. A unit or axis the caller states takes
  // the place of the file's here rather than afterwards, so the scan guess — which welds
  // in metres — is made at the units that will actually be used.
  const settings = settingsForScene({
    ...raw,
    unitsPerMetre: opts.metresPerUnit ?? raw.unitsPerMetre,
    upAxis: opts.upAxis ?? raw.upAxis,
  })
  if (opts.surface) settings.planarize = { ...settings.planarize, surface: opts.surface }
  const prepareOptions = { ...DEFAULT_PREPARE_SETTINGS, ...opts.prepare }

  const s: Session = {
    path,
    projectName: basename(path).replace(/\.[^.]+$/, '') || 'Untitled',
    prepareOptions,
    prepared: prepareScene(raw, settings.transform, prepareOptions, settings.planarize.surface),
    settings,
    decisions: {},
    rationalisations: [],
    areaSeq: 0,
  }
  reseed(s)
  return s
}

/**
 * Decisions and areas from the plan, as the app seeds them whenever `prepared` changes.
 * Which is also why re-running preparation throws hand pruning away, there and here.
 */
function reseed(s: Session): void {
  s.decisions = applyPlan(seedDecisions(s.prepared.scene), s.prepared.plan)
  s.rationalisations = rationalisationsFromPlan(s.prepared.plan)
}

/** Re-run preparation from the RAW scene, against the transform in force now. */
export function rePrepare(s: Session, patch: Partial<PrepareSettings> = {}): void {
  s.prepareOptions = { ...s.prepareOptions, ...patch }
  s.prepared = prepareScene(s.prepared.raw, s.settings.transform, s.prepareOptions, s.settings.planarize.surface)
  reseed(s)
}

// ---------------------------------------------------------------- reading it back

const round = (v: number, places = 3) => Math.round(v * 10 ** places) / 10 ** places

/** `1 Listening`, `2 Surface (inferred)`: the raw code always beside the label (CLAUDE.md). */
export function planeTypeLabel(code: number): string {
  const t = PLANE_TYPES.find((p) => p.code === code)
  if (!t) return `${code} (unknown)`
  return `${code} ${t.label}${t.verified ? '' : ' (inferred)'}`
}

/** A plane type given as its code or its label. */
export function parsePlaneType(v: unknown): PlaneType {
  if (typeof v === 'number' && PLANE_TYPES.some((p) => p.code === v)) return v
  if (typeof v === 'string') {
    const want = v.trim().toLowerCase()
    const t = PLANE_TYPES.find((p) => p.label.toLowerCase() === want || String(p.code) === want)
    if (t) return t.code
  }
  throw new ToolError(
    `Unknown plane type ${JSON.stringify(v)}. Use a code or a label: ${PLANE_TYPES.map((p) => `${p.code} ${p.label}`).join(', ')}.`,
  )
}

/** Venue-space box of some nodes: the source box's corners, through the one transform. */
function venueBounds(nodes: ImportedNode[], t: TransformOptions) {
  const b = boundsOf(nodes)
  if (!b) return null
  const corners: number[] = []
  for (const x of [b.min.x, b.max.x]) for (const y of [b.min.y, b.max.y]) for (const z of [b.min.z, b.max.z]) corners.push(x, y, z)
  const v = applyTransform(new Float64Array(corners), t)
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < v.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], v[i + k])
      max[k] = Math.max(max[k], v[i + k])
    }
  }
  return { min: min.map((n) => round(n)), max: max.map((n) => round(n)), size: max.map((n, k) => round(n - min[k])) }
}

function unitsReport(s: Session) {
  const raw = s.prepared.raw
  const m = s.settings.transform.unitsPerMetre
  const preset = UNIT_PRESETS.find((p) => p.unitsPerMetre === m)
  const stated = raw.unitsPerMetre
  return {
    metresPerUnit: m,
    unit: preset?.label ?? 'custom',
    source:
      stated === undefined
        ? 'guessed from the size of the model — check it'
        : stated === m
          ? 'stated by the file'
          : `set by hand (the file states ${stated} m per unit)`,
    ...(stated === m && raw.unitsDoubt ? { doubt: raw.unitsDoubt.message } : {}),
  }
}

function prepareReport(s: Session) {
  const p = s.prepared
  if (p.raw.alreadyAVenue) {
    return { ran: false, why: 'This file is already a venue, so preparation leaves it exactly as its author built it.' }
  }
  const reasons = new Map<string, { count: number; examples: string[] }>()
  const byId = new Map(flattenNodes(p.scene.nodes).map((n) => [n.id, n]))
  for (const [id, why] of p.plan.exclude) {
    const key = why.replace(/[0-9]+(\.[0-9]+)?/g, '#')
    const r = reasons.get(key) ?? { count: 0, examples: [] }
    r.count++
    if (r.examples.length < 5) r.examples.push(byId.get(id)?.name ?? id)
    reasons.set(key, r)
  }
  const t = s.settings.transform
  const stale = p.transform.unitsPerMetre !== t.unitsPerMetre || p.transform.upAxis !== t.upAxis
  return {
    ran: true,
    options: s.prepareOptions,
    decidedAt: { metresPerUnit: p.transform.unitsPerMetre, upAxis: p.transform.upAxis, surface: p.surface },
    ...(stale
      ? { stale: 'The units or up axis have changed since preparation decided. Its thresholds are in metres: run `prepare` to decide again (this resets pruning).' }
      : {}),
    summary: p.plan.summary,
    notes: p.plan.notes,
    leftOut: [...reasons].map(([reason, r]) => ({ reason, ...r })),
    split: p.split,
    simplify: p.simplify,
  }
}

function areaSummary(r: Rationalisation) {
  return {
    id: r.id,
    name: r.name,
    planeType: planeTypeLabel(r.planeType),
    members: r.memberIds.length,
    faces: r.faces,
    mode: r.mode,
    gapMetres: r.gapMetres,
    replaceMembers: r.replaceMembers,
    ...(r.footprint ? { footprint: r.footprint } : {}),
    ...(r.stepped ? { stepped: true } : {}),
  }
}

/** Everything a caller needs to know about the open model, short of the tree itself. */
export function status(s: Session) {
  const raw = s.prepared.raw
  const scene = s.prepared.scene
  const all = flattenNodes(scene.nodes)
  const geometry = all.filter((n) => n.positions.length > 0)
  const t = s.settings.transform
  return {
    file: s.path,
    format: raw.format,
    projectName: s.projectName,
    alreadyAVenue: !!raw.alreadyAVenue,
    objects: {
      nodes: all.length,
      withGeometry: geometry.length,
      included: geometry.filter((n) => s.decisions[n.id]?.include).length,
      triangles: countTriangles(scene.nodes),
    },
    units: unitsReport(s),
    upAxis: { axis: t.upAxis, source: raw.upAxis === undefined ? 'guessed from the way the surfaces face' : raw.upAxis === t.upAxis ? 'stated by the file' : 'set by hand' },
    placement: { headingDeg: t.headingDeg, offset: [t.offset.x, t.offset.y, t.offset.z], flipX: t.flipX },
    venueBounds: venueBounds(scene.nodes, t),
    reduction: {
      surface: s.settings.planarize.surface ?? 'cad',
      fit: s.settings.fit,
      simplifyTolerance: s.settings.simplifyTolerance,
      maxObjectsPerNode: s.settings.maxObjectsPerNode,
      weldTolerance: s.settings.planarize.weldTolerance,
      angleTolerance: s.settings.planarize.angleTolerance,
      offsetTolerance: s.settings.planarize.offsetTolerance,
      minArea: s.settings.planarize.minArea,
    },
    importWarnings: raw.warnings,
    preparation: prepareReport(s),
    areas: s.rationalisations.map(areaSummary),
  }
}

// ---------------------------------------------------------------- the tree

export interface TreeQuery {
  under?: string
  depth?: number
  match?: string
  limit?: number
  offset?: number
  bounds?: boolean
}

function nodeIndex(s: Session) {
  const byId = new Map<string, ImportedNode>()
  const parent = new Map<string, ImportedNode>()
  const walk = (ns: ImportedNode[], up?: ImportedNode) => {
    for (const n of ns) {
      byId.set(n.id, n)
      if (up) parent.set(n.id, up)
      walk(n.children, n)
    }
  }
  walk(s.prepared.scene.nodes)
  return { byId, parent }
}

/** The geometry-bearing ids at or under a node: the only ones include and type act on. */
function geometryIds(n: ImportedNode, out: string[] = []): string[] {
  if (n.positions.length > 0) out.push(n.id)
  for (const c of n.children) geometryIds(c, out)
  return out
}

function matcher(text: string) {
  const want = text.trim().toLowerCase()
  return (s: Session, n: ImportedNode) => {
    const label = rowLabel(n, (id) => s.decisions[id]?.name)
    return [label, n.name, ...n.tags].some((x) => x.toLowerCase().includes(want))
  }
}

export function tree(s: Session, q: TreeQuery) {
  const { byId, parent } = nodeIndex(s)
  const replaced = replacedNodeIds(s.rationalisations)
  const nameOf = (id: string) => s.decisions[id]?.name
  const limit = Math.min(q.limit ?? 100, 1000)
  const offset = q.offset ?? 0

  const root = q.under ? byId.get(q.under) : undefined
  if (q.under && !root) throw new ToolError(`No node with id ${JSON.stringify(q.under)}. list_tree gives the ids.`)

  const tris = new Map<string, number>()
  const count = (n: ImportedNode): number => {
    let t = n.positions.length / 9
    for (const c of n.children) t += count(c)
    tris.set(n.id, t)
    return t
  }
  s.prepared.scene.nodes.forEach(count)

  const pathOf = (n: ImportedNode) => {
    const out: string[] = []
    for (let p = parent.get(n.id); p; p = parent.get(p.id)) out.unshift(rowLabel(p, nameOf))
    return out.join(' / ')
  }

  const row = (n: ImportedNode, depth: number, withPath: boolean) => {
    const ids = geometryIds(n)
    const on = ids.filter((id) => s.decisions[id]?.include).length
    const types = [...new Set(ids.map((id) => s.decisions[id]?.planeType ?? PlaneType.Listening))]
    const label = rowLabel(n, nameOf)
    const leftOut = s.prepared.plan.exclude.get(n.id)
    return {
      id: n.id,
      label,
      ...(label !== n.name ? { sourceName: n.name } : {}),
      ...(withPath ? { path: pathOf(n) } : { depth }),
      triangles: tris.get(n.id) ?? 0,
      ...(n.children.length ? { children: n.children.length } : {}),
      include: ids.length === 0 ? 'no geometry' : on === 0 ? 'none' : on === ids.length ? 'all' : `${on} of ${ids.length}`,
      ...(ids.length ? { planeType: types.length === 1 ? planeTypeLabel(types[0]) : 'mixed' } : {}),
      ...(leftOut ? { leftOutBy: `preparation: ${leftOut}` } : {}),
      ...(ids.some((id) => replaced.has(id)) ? { replacedByArea: true } : {}),
      ...(n.tags.length ? { tags: n.tags.slice(0, 6) } : {}),
      ...(q.bounds ? { bounds: venueBounds([n], s.settings.transform) } : {}),
    }
  }

  const rows: ReturnType<typeof row>[] = []
  let total = 0
  const take = (n: ImportedNode, depth: number, withPath: boolean) => {
    if (total >= offset && rows.length < limit) rows.push(row(n, depth, withPath))
    total++
  }

  const start = root ? root.children : s.prepared.scene.nodes
  if (q.match) {
    const hit = matcher(q.match)
    const walk = (ns: ImportedNode[]) => {
      for (const n of ns) {
        if (hit(s, n)) take(n, 0, true)
        walk(n.children)
      }
    }
    walk(start)
  } else {
    const maxDepth = q.depth ?? 2
    const walk = (ns: ImportedNode[], depth: number) => {
      for (const n of ns) {
        take(n, depth, false)
        if (depth + 1 < maxDepth) walk(n.children, depth + 1)
      }
    }
    walk(start, 0)
  }

  return {
    ...(root ? { under: row(root, 0, true) } : {}),
    rows,
    shown: rows.length,
    total,
    ...(offset + rows.length < total ? { more: `Pass offset: ${offset + rows.length} for the next rows.` } : {}),
  }
}

// ---------------------------------------------------------------- decisions

/** Ids named directly, plus every node whose label, name or tag matches. */
function resolveTargets(s: Session, ids: string[] | undefined, match: string | undefined): ImportedNode[] {
  const { byId } = nodeIndex(s)
  const out = new Map<string, ImportedNode>()
  const missing = (ids ?? []).filter((id) => !byId.has(id))
  if (missing.length) throw new ToolError(`No node with id ${missing.map((m) => JSON.stringify(m)).join(', ')}. list_tree gives the ids.`)
  for (const id of ids ?? []) out.set(id, byId.get(id)!)
  if (match !== undefined) {
    const hit = matcher(match)
    for (const n of byId.values()) if (hit(s, n)) out.set(n.id, n)
    if (out.size === 0) throw new ToolError(`Nothing matches ${JSON.stringify(match)}.`)
  }
  return [...out.values()]
}

export interface NodePatch {
  ids?: string[]
  match?: string
  include?: boolean
  planeType?: PlaneType
  name?: string
  subtree?: boolean
}

export function setNodes(s: Session, p: NodePatch) {
  if (!p.ids?.length && p.match === undefined) throw new ToolError('Name the nodes: give ids, match, or both.')
  if (p.include === undefined && p.planeType === undefined && p.name === undefined) {
    throw new ToolError('Nothing to change: give include, planeType or name.')
  }
  const targets = resolveTargets(s, p.ids, p.match)
  const warnings: string[] = []

  if (p.name !== undefined) {
    if (targets.length !== 1) throw new ToolError(`A name goes on one node; ${targets.length} were named.`)
    s.decisions[targets[0].id] = { ...s.decisions[targets[0].id], name: p.name }
  }

  // Include and plane type act on what carries geometry, as the tree's checkboxes do: a
  // container is not exported, it is where its children live.
  const subtree = p.subtree ?? true
  const ids = new Set<string>()
  for (const n of targets) for (const id of subtree ? subtreeIds(n) : [n.id]) ids.add(id)
  const { byId } = nodeIndex(s)
  const geometry = [...ids].filter((id) => (byId.get(id)?.positions.length ?? 0) > 0)

  if (p.include !== undefined || p.planeType !== undefined) {
    for (const id of geometry) {
      s.decisions[id] = {
        ...s.decisions[id],
        ...(p.include !== undefined ? { include: p.include } : {}),
        ...(p.planeType !== undefined ? { planeType: p.planeType } : {}),
      }
    }
    if (geometry.length === 0) warnings.push('None of the nodes named carries geometry, so nothing was included, left out or typed.')
  }
  if (p.planeType === PlaneType.None && geometry.length) {
    warnings.push('Plane type 0 is for groups. On a real object ArrayCalc silently changes it to 1 Listening.')
  }
  if (p.planeType === PlaneType.PositioningArea) {
    warnings.push('A Positioning area must be rectangular; the conversion squares it off and says so.')
  }
  const replaced = replacedNodeIds(s.rationalisations)
  const standIn = geometry.filter((id) => replaced.has(id)).length
  if (p.include && standIn) {
    warnings.push(`${standIn} of these are replaced by an area, so they stay out of the venue until that area is removed or stops replacing them.`)
  }
  return {
    nodesNamed: targets.length,
    objectsChanged: p.include !== undefined || p.planeType !== undefined ? geometry.length : 0,
    ...(p.name !== undefined ? { renamed: targets[0].id } : {}),
    includedNow: Object.entries(s.decisions).filter(([id, d]) => d.include && (byId.get(id)?.positions.length ?? 0) > 0).length,
    warnings,
  }
}

// ---------------------------------------------------------------- settings

/** Short names for the unit presets. The numbers stay in `UNIT_PRESETS`. */
const UNIT_ALIASES: Record<string, string> = {
  m: 'Metres', metre: 'Metres', metres: 'Metres', meter: 'Metres', meters: 'Metres',
  cm: 'Centimetres', centimetre: 'Centimetres', centimetres: 'Centimetres', centimeters: 'Centimetres',
  mm: 'Millimetres', millimetre: 'Millimetres', millimetres: 'Millimetres', millimeters: 'Millimetres',
  ft: 'Feet', foot: 'Feet', feet: 'Feet',
  in: 'Inches', inch: 'Inches', inches: 'Inches',
}

export function parseUnits(v: unknown): number {
  if (typeof v === 'number' && v > 0) return v
  const label = typeof v === 'string' ? UNIT_ALIASES[v.trim().toLowerCase()] : undefined
  const preset = UNIT_PRESETS.find((p) => p.label === label)
  if (preset) return preset.unitsPerMetre
  throw new ToolError(`Unknown units ${JSON.stringify(v)}: give metres per unit (0.001 for mm) or one of m, cm, mm, ft, in.`)
}

export interface PlacementPatch {
  metresPerUnit?: number
  upAxis?: 'y' | 'z'
  headingDeg?: number
  flipX?: boolean
  offset?: [number, number, number]
  originAt?: [number, number, number]
}

/**
 * Units, axis, heading, mirror, offset — then the origin, which is set last on purpose.
 *
 * `originAt` is a point already in VENUE space, and the origin moves onto it by
 * `withOriginAt`'s subtraction, exactly as a pick in the viewport does. Nothing reaches
 * back to source coordinates (AGENTS.md §5). The offset is applied after the heading, so a
 * heading given in the same call is applied first and the picked point stays at zero.
 */
export function setPlacement(s: Session, p: PlacementPatch) {
  let t: TransformOptions = { ...s.settings.transform }
  if (p.metresPerUnit !== undefined) t.unitsPerMetre = p.metresPerUnit
  if (p.upAxis !== undefined) t.upAxis = p.upAxis
  if (p.headingDeg !== undefined) t.headingDeg = p.headingDeg
  if (p.flipX !== undefined) t.flipX = p.flipX
  if (p.offset) t.offset = { x: p.offset[0], y: p.offset[1], z: p.offset[2] }
  if (p.originAt) t = withOriginAt(t, { x: p.originAt[0], y: p.originAt[1], z: p.originAt[2] })
  s.settings = { ...s.settings, transform: t }
  const st = status(s)
  const prep = st.preparation
  return {
    units: st.units,
    upAxis: st.upAxis,
    placement: st.placement,
    venueBounds: st.venueBounds,
    ...('stale' in prep && prep.stale ? { note: prep.stale } : {}),
  }
}

export interface ReductionPatch {
  surface?: SurfaceKind
  fit?: FitMode
  simplifyTolerance?: number
  maxObjectsPerNode?: number
  weldTolerance?: number
  angleTolerance?: number
  offsetTolerance?: number
  minArea?: number
}

/**
 * The Simplification panel. Changing `surface` re-runs preparation from the raw scene, as
 * the panel's Surfaces control does, because splitting a one-piece model reads it too.
 */
export function setReduction(s: Session, p: ReductionPatch) {
  const { surface, fit, simplifyTolerance, maxObjectsPerNode, ...planarize } = p
  const before = s.settings.planarize.surface ?? 'cad'
  s.settings = {
    ...s.settings,
    ...(fit !== undefined ? { fit } : {}),
    ...(simplifyTolerance !== undefined ? { simplifyTolerance } : {}),
    ...(maxObjectsPerNode !== undefined ? { maxObjectsPerNode } : {}),
    planarize: { ...s.settings.planarize, ...planarize, ...(surface !== undefined ? { surface } : {}) },
  }
  const reran = surface !== undefined && surface !== before
  if (reran) rePrepare(s)
  return {
    reduction: status(s).reduction,
    ...(reran ? { note: `Read as ${surface} now, so preparation ran again from the file as imported; hand pruning and areas were reset.` } : {}),
  }
}

// ---------------------------------------------------------------- areas

export interface AreaPatch {
  name?: string
  planeType?: PlaneType
  faces?: CaptureFaces
  gapMetres?: number
  mode?: OutlineMode
  footprint?: Pt2[] | null
  replaceMembers?: boolean
  stepped?: boolean
}

/** One area, run against the current scene and settings: what it would put in the venue. */
function areaResult(s: Session, id: string) {
  const r = s.rationalisations.find((x) => x.id === id)!
  const run = rationalisedAreas(s.prepared.scene, [r], s.settings)
  const area = run.areas[0]
  return {
    ...areaSummary(r),
    produced: area ? { outlines: area.outlines.length, ...area.stats } : null,
    warnings: run.warnings,
  }
}

export function addArea(s: Session, p: AreaPatch & { ids?: string[]; match?: string }) {
  const { ids, match, name: given, footprint, ...rest } = p
  let members: string[]
  if (ids?.length || match !== undefined) {
    members = [...new Set(resolveTargets(s, ids, match).flatMap((n) => geometryIds(n)))]
  } else if (footprint) {
    // A drawn area with nothing selected captures everything included, as in the app.
    members = flattenNodes(s.prepared.scene.nodes)
      .filter((n) => n.positions.length > 0 && s.decisions[n.id]?.include)
      .map((n) => n.id)
  } else {
    throw new ToolError('Say what the area is made of: ids or match, a footprint, or both.')
  }
  if (members.length === 0) throw new ToolError('None of those nodes carries geometry.')

  const { byId } = nodeIndex(s)
  const id = `mcp${++s.areaSeq}`
  const name = given ?? deriveLabel(members.map((m) => s.decisions[m]?.name ?? byId.get(m)?.name ?? '')) ?? `Area ${s.areaSeq}`
  const r: Rationalisation = {
    ...newRationalisation(id, name, members),
    // A drawn boundary is a statement about where the area is, and it nearly always covers
    // part of a node, so — as in the app — it outlines by the footprint and does not
    // replace whole members unless asked to.
    ...(footprint ? { footprint, mode: 'footprint' as const, replaceMembers: false } : {}),
    ...definedOnly(rest),
  }
  if (r.mode === 'footprint' && !r.footprint) throw new ToolError('Outline mode "footprint" needs a footprint.')
  s.rationalisations = [...s.rationalisations, r]
  return areaResult(s, id)
}

export function editArea(s: Session, id: string, p: AreaPatch) {
  const i = s.rationalisations.findIndex((r) => r.id === id)
  if (i === -1) throw new ToolError(`No area ${JSON.stringify(id)}. status lists them.`)
  const next: Rationalisation = { ...s.rationalisations[i], ...definedOnly({ ...p, footprint: undefined }) }
  if (p.footprint === null) delete next.footprint
  else if (p.footprint) next.footprint = p.footprint
  if (next.mode === 'footprint' && !next.footprint) throw new ToolError('Outline mode "footprint" needs a footprint.')
  s.rationalisations = s.rationalisations.map((r, k) => (k === i ? next : r))
  return areaResult(s, id)
}

export function removeArea(s: Session, id: string) {
  if (!s.rationalisations.some((r) => r.id === id)) throw new ToolError(`No area ${JSON.stringify(id)}. status lists them.`)
  s.rationalisations = s.rationalisations.filter((r) => r.id !== id)
  return { removed: id, areas: s.rationalisations.map(areaSummary) }
}

function definedOnly<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>
}

// ---------------------------------------------------------------- converting and writing

/**
 * Every object written, with the group it sits in. A node of several planes is written as
 * a group under the node's name — a rename lands there — and its planes keep the source
 * name with a number, as the app writes them.
 */
function leafObjects(objects: RoomObject[], group?: string, out: { o: RoomObject; group?: string }[] = []) {
  for (const o of objects) {
    if (o.shape === Shape.Group) leafObjects(o.children, o.name, out)
    else out.push({ o, group })
  }
  return out
}

/** The ArrayCalc conversion the app shows live, with its statistics and warnings. */
export function convert(s: Session, opts: { objects?: boolean; limit?: number } = {}) {
  const { result, areas } = convertVenue({ ...inputs(s) })
  const leaves = leafObjects(result.objects)
  const byType: Record<string, number> = {}
  for (const { o } of leaves) byType[planeTypeLabel(o.planeType)] = (byType[planeTypeLabel(o.planeType)] ?? 0) + 1

  // Is what is left in a flat plan? The app asks this as the tree changes, and offers the
  // tracer instead: converted as a model, a plan's surfaces all lie on the floor.
  const included = new Set(Object.entries(s.decisions).filter(([, d]) => d.include).map(([id]) => id))
  const flat = flatPlanReport(s.prepared.scene, s.settings.transform, {
    included,
    planExcluded: new Set(s.prepared.plan.exclude.keys()),
    dropClutter: s.prepared.options.dropClutter,
  })

  const limit = Math.min(opts.limit ?? 200, 2000)
  return {
    objectsOut: leaves.length,
    byPlaneType: byType,
    stats: result.stats,
    warnings: [...new Set(result.warnings)],
    areas: areas.map((a) => ({ id: a.id, name: a.name, planeType: planeTypeLabel(a.planeType), outlines: a.outlines.length, ...a.stats })),
    ...(flat?.flat
      ? {
          flatPlan: `${Math.round(flat.share * 100)}% of what is left in lies level at ${round(flat.levelM, 2)} m: this is a 2D plan, and converted as a model every surface lands on that level. Trace it in the ArrayCAD app instead.`,
        }
      : {}),
    ...(opts.objects
      ? {
          objects: leaves.slice(0, limit).map(({ o, group }) => ({
            name: o.name,
            ...(group ? { group } : {}),
            shape: Shape[o.shape],
            planeType: planeTypeLabel(o.planeType),
            origin: [round(o.origin.x), round(o.origin.y), round(o.origin.z)],
            rotationZ: round(o.rotation.z, 2),
            points: o.points.length,
          })),
          ...(leaves.length > limit ? { objectsShown: limit } : {}),
        }
      : {}),
  }
}

function inputs(s: Session) {
  return { scene: s.prepared.scene, decisions: s.decisions, settings: s.settings, rationalisations: s.rationalisations }
}

export const TARGETS: Record<Target, string> = {
  dbacv: 'ArrayCalc venue (.dbacv)',
  soundvision: 'Soundvision 3D room data (.txt) — import with 3D room data > Import 3D room data',
  fc3: 'EASE Focus 3 project (.fc3) — Listening planes only, one audience zone each',
  mvr: 'MVR (.mvr) for lighting visualisers — the room as surfaces, one object per node',
}

/** The file a target would be, without writing it. */
export function buildTarget(s: Session, target: Target, projectName: string): TargetFile {
  switch (target) {
    case 'dbacv':
      return dbacvFile(convertVenue(inputs(s)).result, projectName, s.prepared.raw.format)
    case 'soundvision':
      return soundvisionFile(inputs(s))
    case 'fc3':
      return easeFocusFile(inputs(s), projectName)
    case 'mvr':
      return mvrFile(inputs(s), projectName)
  }
}
