/**
 * A CAD plan -> the tracer.
 *
 * A rig plot or a floor plan saved as DXF or DWG is a 2D drawing in a 3D format: every
 * entity at z = 0. Converted as a model it comes out as hundreds of surfaces all lying on
 * the floor — a layer called `Ceiling Coffers` typed as a ceiling, at height zero. What the
 * file actually holds is what a PDF of the same plan holds: outlines, and no heights. So it
 * goes down the same road as a PDF, through the tracer, where the user picks out the regions
 * and types the heights.
 *
 * It arrives better off than a PDF does. A DXF states its own units, so the sheet is drawn
 * at a scale chosen here and the calibration is exact before anyone clicks; and the lines
 * are the drawing's own, so a traced corner snaps to the real intersection.
 *
 * Three jobs, all pure — the sheet is rasterised here, by hand, not on a canvas, so the whole
 * route from DXF text to a wand-traced room runs in node under test:
 *
 *   flatPlanReport   is this a plan? Answered on what is LEFT IN once clutter is out
 *   traceLayers      which layers go on the sheet
 *   cadTraceDocument the line work -> a raster, snapping paths, and a calibration
 *
 * Regions stay in pixels and metres stay in calibrate.ts (AGENTS.md §8): this module only
 * ever turns drawing units into pixels. What a pixel is worth is `calibrateByDrawingUnits`.
 */

import { type ImportedNode, type ImportedScene, type LayerLinework, ImportError, flattenNodes } from '../import/types.ts'
import { type TransformOptions, UNIT_PRESETS, guessUnits } from '../geom/transform.ts'
import { categorise } from '../prepare/vocabulary.ts'
import type { DetectedPath, Px, Raster, TraceDocument } from './types.ts'
import { calibrateByDrawingUnits, pixelsPerDrawingUnit } from './calibrate.ts'
import { DEFAULT_PATH_EXTRACT } from './pdfPaths.ts'

// ------------------------------------------------------------------ is it a plan?

/**
 * Metres. Geometry within this of the plan's level is ON it. Generous, because a plan's
 * "flat" is often a polyline elevation of a few millimetres someone typed by accident.
 */
const LEVEL_TOL_M = 0.05

/**
 * The share of what is left in that has to lie on one level for the drawing to be a plan.
 *
 * Not 1: a rig plot's speaker and fixture symbols are routinely 3D blocks, and the
 * vocabulary will not always know their layer for clutter — `Custom Sound` and `CAD-Audio`
 * on the plot this was built against carry a metre of height each. Their AREA is tiny next
 * to a floor plan's, which is why this is an area share and not a height span: one 3D
 * symbol must not turn a plan into a model. A real 3D model of even a flat-floored hall is
 * well under half floor — the walls and the ceiling are most of its surface.
 */
const FLAT_SHARE = 0.9

/** Within a degree or so of level. A ring filled flat is exactly level. */
const HORIZONTAL_COS = Math.cos((2.5 * Math.PI) / 180)

export interface FlatPlanReport {
  /** What is left in lies on one level: this is a plan, not a model. */
  flat: boolean
  /** 0..1: how much of what is left in lies on that level — by area, or by line work. */
  share: number
  /** Venue metres: the height of that level. */
  levelM: number
  /** What `share` was measured on: surfaces, or only lines for a drawing with none left in. */
  measuredOn: 'surfaces' | 'lines'
  /** Layers LEFT IN that do carry height, tallest first, in metres. Shown, not acted on. */
  withHeight: { name: string; spanM: number }[]
  /** Layers LEFT OUT that carry height — the truss and fixtures, usually. A count, for the report. */
  leftOutWithHeight: number
}

/**
 * Is this drawing a plan once clutter is left out?
 *
 * Null when the question does not apply: a file that is already a venue, or one with no line
 * work to put on a sheet (every format but DXF and DWG). Height is the transform's up axis,
 * in metres at its scale — the same measuring convention as `prepare/plan.ts:measureNode`.
 *
 * Measured over what is LEFT IN, per `choice`, because the clutter is exactly where a plan's
 * real heights are: the truss is a 3D solid six metres up, and a plan with its rig drawn in
 * is still a plan.
 */
export function flatPlanReport(
  scene: ImportedScene,
  transform: TransformOptions,
  choice: LayerChoice,
): FlatPlanReport | null {
  if (scene.alreadyAVenue || !scene.linework || scene.linework.length === 0) return null
  const s = transform.unitsPerMetre
  const up = transform.upAxis === 'y' ? 1 : 2

  const nodes = flattenNodes(scene.nodes).filter((n) => n.positions.length > 0)
  const kept = nodes.filter((n) => choice.included.has(n.id))

  /** Every face left in: its height in metres, its area in m², and whether it is level. */
  const eachFace = (fn: (z: number, area: number, level: boolean) => void) => {
    for (const n of kept) {
      const p = n.positions
      for (let i = 0; i + 8 < p.length; i += 9) {
        const ux = p[i + 3] - p[i], uy = p[i + 4] - p[i + 1], uz = p[i + 5] - p[i + 2]
        const vx = p[i + 6] - p[i], vy = p[i + 7] - p[i + 1], vz = p[i + 8] - p[i + 2]
        const nx = uy * vz - uz * vy
        const ny = uz * vx - ux * vz
        const nz = ux * vy - uy * vx
        const l = Math.sqrt(nx * nx + ny * ny + nz * nz)
        if (!(l > 0)) continue
        const z = ((p[i + up] + p[i + 3 + up] + p[i + 6 + up]) / 3) * s
        fn(z, 0.5 * l * s * s, Math.abs(up === 1 ? ny : nz) / l >= HORIZONTAL_COS)
      }
    }
  }

  // The heights of the LEVEL faces, weighted by area. The peak is the plan's level: a plan
  // drawn at an elevation of 3 m is as flat as one drawn at 0.
  const levels = new Levels()
  let total = 0
  eachFace((z, area, level) => {
    total += area
    if (level) levels.add(z, area)
  })

  let measuredOn: FlatPlanReport['measuredOn'] = 'surfaces'
  let levelM: number
  let share: number
  if (total > 0) {
    levelM = levels.peak()
    let on = 0
    eachFace((z, area, level) => {
      if (level && Math.abs(z - levelM) <= LEVEL_TOL_M) on += area
    })
    share = on / total
  } else {
    // Nothing left in has a surface — a plan whose lines never close. The line work on the
    // sheet is all there is to judge it by, so judge it by that: the same peak, over points.
    measuredOn = 'lines'
    const layers = traceLayers(scene, choice)
    const lines = scene.linework.filter((l) => layers.has(l.layer))
    const eachPoint = (fn: (z: number) => void) => {
      for (const l of lines) for (let i = up; i < l.points.length; i += 3) fn(l.points[i] * s)
    }
    let count = 0
    eachPoint((z) => {
      count++
      levels.add(z, 1)
    })
    if (count === 0) return null
    levelM = levels.peak()
    let on = 0
    eachPoint((z) => {
      if (Math.abs(z - levelM) <= LEVEL_TOL_M) on++
    })
    share = on / count
  }

  const span = (n: ImportedNode) => {
    let lo = Infinity
    let hi = -Infinity
    const p = n.positions
    for (let i = up; i < p.length; i += 3) {
      if (p[i] < lo) lo = p[i]
      if (p[i] > hi) hi = p[i]
    }
    return (hi - lo) * s
  }
  const withHeight = kept
    .map((n) => ({ name: n.name, spanM: span(n) }))
    .filter((h) => h.spanM > LEVEL_TOL_M)
    .sort((a, b) => b.spanM - a.spanM)
  const leftOutWithHeight = nodes.filter((n) => !choice.included.has(n.id) && span(n) > LEVEL_TOL_M).length

  return { flat: share >= FLAT_SHARE, share, levelM, measuredOn, withHeight, leftOutWithHeight }
}

/** A weighted histogram of heights, in bins of the level tolerance. */
class Levels {
  private w = new Map<number, number>()
  private wz = new Map<number, number>()

  add(z: number, weight: number): void {
    const b = Math.round(z / LEVEL_TOL_M)
    this.w.set(b, (this.w.get(b) ?? 0) + weight)
    this.wz.set(b, (this.wz.get(b) ?? 0) + weight * z)
  }

  /**
   * The plan's level: the weighted mean height of the heaviest bin and its two neighbours,
   * so a level that straddles a bin edge is not split in half.
   */
  peak(): number {
    let best = 0
    let bestW = -1
    for (const [b, w] of this.w) {
      if (w > bestW) {
        bestW = w
        best = b
      }
    }
    let sw = 0
    let sz = 0
    for (let b = best - 1; b <= best + 1; b++) {
      sw += this.w.get(b) ?? 0
      sz += this.wz.get(b) ?? 0
    }
    return sw > 0 ? sz / sw : best * LEVEL_TOL_M
  }
}

// ------------------------------------------------------------- which layers to draw

export interface LayerChoice {
  /** Node ids currently in the venue. */
  included: ReadonlySet<string>
  /** Node ids Prepare left out, for any reason. */
  planExcluded: ReadonlySet<string>
  /** Whether Prepare is leaving clutter out. Decides the layers that never made a node. */
  dropClutter: boolean
}

/**
 * The layers that belong on the sheet: the ones left in, give or take two corrections.
 *
 * - A layer Prepare left out for its SIZE is drawn anyway. "Under 0.25 m² of surface" is a
 *   judgement about surfaces, and the walls of a plan whose corners do not quite meet have
 *   almost none — their lines are still exactly what the wand needs to stop at.
 * - A layer with no node at all, nothing but open lines, is drawn unless its name is
 *   clutter. Leaving out a `CENTRELINE` matters more here than anywhere: drawn, it cuts
 *   every room it crosses in two.
 *
 * Everything else follows the tree: a layer turned off by hand stays off the sheet, and a
 * clutter layer turned back on is drawn.
 */
export function traceLayers(scene: ImportedScene, choice: LayerChoice): Set<string> {
  const byLayer = new Map<string, ImportedNode>()
  for (const n of flattenNodes(scene.nodes)) {
    for (const t of n.tags) if (t.startsWith('layer:')) byLayer.set(t.slice(6), n)
  }
  const out = new Set<string>()
  for (const { layer } of scene.linework ?? []) {
    const node = byLayer.get(layer)
    if (node) {
      const clutter = categorise(node.name, node.tags) === 'clutter'
      if (choice.included.has(node.id) || (choice.planExcluded.has(node.id) && !clutter)) out.add(layer)
    } else if (!(choice.dropClutter && categorise(layer, [`layer:${layer}`]) === 'clutter')) {
      out.add(layer)
    }
  }
  return out
}

// --------------------------------------------------------------------- units

/** 'millimetres', for the report. Falls back to the number for a unit with no name here. */
export function drawingUnitName(metresPerUnit: number): string {
  const preset = UNIT_PRESETS.find((u) => Math.abs(u.unitsPerMetre - metresPerUnit) < 1e-12)
  return preset ? preset.label.toLowerCase() : `units of ${metresPerUnit} m`
}

/**
 * Metres per unit for a drawing that states none, guessed off its size exactly as the 3D
 * road guesses (`geom/transform.ts:guessUnits`) — but from the LINES, because a plan whose
 * lines never close has no surfaces to measure. A guess, and the sheet says so.
 */
export function guessDrawingUnits(scene: ImportedScene): number {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const l of scene.linework ?? []) {
    for (let i = 0; i + 2 < l.points.length; i += 3) {
      const x = l.points[i]
      const y = l.points[i + 1]
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
    }
  }
  if (!Number.isFinite(x0)) return 1
  return guessUnits({ min: { x: x0, y: y0, z: 0 }, max: { x: x1, y: y1, z: 0 } })
}

// --------------------------------------------------------------------- the sheet

export interface CadTraceOptions {
  /** The layers to draw. Undefined draws every layer the drawing has. */
  layers?: ReadonlySet<string>
  /** Metres per drawing unit: the drawing's own, or the user's Source units when it has none. */
  metresPerUnit: number
  /** Whether the drawing stated those units itself. */
  unitsStated: boolean
  /** Longest side of the sheet in pixels. Same budget as a PDF page — see source.ts. */
  targetPx?: number
  /** Snapping is capped like a PDF's vector paths are, for the same reason. */
  maxPoints?: number
}

/** Paper round the drawing, so a room against the edge of the extent is still enclosed. */
const MARGIN_PX = 24

/**
 * The extent is clustered per axis and paths further than this share of the whole span from
 * the main body of the drawing are left off the sheet. A title block forty metres from the
 * room, or one stray entity at a kilometre, would otherwise shrink the plan to a corner of
 * the page and take the wand's resolution with it.
 */
const CLUSTER_GAP = 0.1

/**
 * Draw a CAD plan's line work onto a sheet the tracer can work on.
 *
 * The sheet is black lines on white, one pixel wide and 8-connected, so a 4-connected flood
 * fill (detect.ts) cannot squeeze through a diagonal. The snapping paths are the same lines
 * in the same pixel space, exact. The calibration puts the venue origin at the drawing's own
 * 0,0 — where the 3D road puts it too — so tracing a plan and converting it as a model place
 * the room in the same spot, and the datum the architect drew to survives.
 */
export function cadTraceDocument(scene: ImportedScene, opts: CadTraceOptions): TraceDocument {
  const targetPx = opts.targetPx ?? 2400
  const maxPoints = opts.maxPoints ?? DEFAULT_PATH_EXTRACT.maxPoints
  const all = scene.linework ?? []
  const drawn = all.filter((l) => !opts.layers || opts.layers.has(l.layer))
  const leftOff = all.filter((l) => opts.layers && !opts.layers.has(l.layer)).map((l) => l.layer)
  const warnings: string[] = []

  const paths = drawn.flatMap(pathsOf)
  if (paths.length === 0) {
    throw new ImportError(
      'There is nothing on the layers left in to draw.',
      'Every layer with lines on it has been left out. Untick "Draw only the layers left in", ' +
        'or include a layer in the tree, and trace again.',
    )
  }

  const box = mainExtent(paths)
  const onSheet = paths.filter((p) => p.x1 >= box.x0 && p.x0 <= box.x1 && p.y1 >= box.y0 && p.y0 <= box.y1)
  const offSheet = paths.length - onSheet.length
  if (offSheet > 0) {
    warnings.push(
      `${offSheet.toLocaleString()} path${offSheet === 1 ? ' lies' : 's lie'} far from the rest of the ` +
        'drawing — a title block, a key, or a stray entity — and ' +
        `${offSheet === 1 ? 'was' : 'were'} left off the sheet.`,
    )
  }

  const ppu = pixelsPerDrawingUnit(Math.max(box.x1 - box.x0, box.y1 - box.y0), opts.metresPerUnit, targetPx)
  const width = Math.max(1, Math.ceil((box.x1 - box.x0) * ppu)) + 2 * MARGIN_PX
  const height = Math.max(1, Math.ceil((box.y1 - box.y0) * ppu)) + 2 * MARGIN_PX
  // Raster rows run DOWN, drawing Y runs up: the same flip calibrate.ts undoes.
  const toPx = (x: number, y: number): Px => [(x - box.x0) * ppu + MARGIN_PX, (box.y1 - y) * ppu + MARGIN_PX]

  const ink = new Uint8Array(width * height)
  const snap: DetectedPath[] = []
  let snapPoints = 0
  let truncated = false
  for (const path of onSheet) {
    const pts: Px[] = []
    for (let i = 0; i < path.xs.length; i++) pts.push(toPx(path.xs[i], path.ys[i]))
    const n = pts.length
    const last = path.closed ? n : n - 1
    for (let i = 0; i < last; i++) drawLine(ink, width, height, pts[i], pts[(i + 1) % n])

    const thin = thinned(pts)
    if (lengthOf(thin, path.closed) < DEFAULT_PATH_EXTRACT.minLengthPx) continue
    if (snapPoints + thin.length > maxPoints) {
      truncated = true
      continue
    }
    snap.push({ points: thin, closed: path.closed })
    snapPoints += thin.length
  }
  if (truncated) {
    warnings.push(
      `This drawing has more line work than snapping needs; ${snapPoints.toLocaleString()} points ` +
        'of it were kept. The sheet itself shows every line.',
    )
  }

  const data = new Uint8ClampedArray(width * height * 4).fill(255)
  for (let i = 0; i < ink.length; i++) {
    if (ink[i]) {
      const o = i * 4
      data[o] = 0
      data[o + 1] = 0
      data[o + 2] = 0
    }
  }
  const raster: Raster = { width, height, data }

  const calibration = calibrateByDrawingUnits(opts.metresPerUnit, ppu, toPx(0, 0), opts.unitsStated)
  if (!calibration) throw new ImportError('The drawing units are not a usable scale.', 'Set Source units and trace again.')
  // Stated is not the same as right. When the drawing's own seats disagree with its units,
  // the sheet says so rather than calling the scale exact.
  const doubt = opts.unitsStated ? scene.unitsDoubt?.message : undefined
  if (doubt && calibration.source.kind === 'drawing-units') {
    calibration.source = { ...calibration.source, doubt }
    warnings.push(doubt)
  }
  if (!opts.unitsStated) {
    warnings.push(
      'This drawing does not state its units, so the scale comes from the Source units setting. ' +
        'Check it against a dimension you know with Set scale before tracing.',
    )
  }

  return {
    format: `${scene.format} plan`,
    sourceName: scene.sourceName,
    raster,
    paths: snap,
    calibration,
    regions: [],
    drawing: { layersDrawn: drawn.map((l) => l.layer), layersLeftOff: leftOff },
    warnings,
  }
}

/** One path in plan: x and y in drawing units, its closure, and its bounding box. */
interface PlanPath {
  xs: Float64Array
  ys: Float64Array
  closed: boolean
  x0: number
  y0: number
  x1: number
  y1: number
}

/** A layer's packed line work -> plan paths. The plan is X and Y: a DXF is Z-up. */
function pathsOf(l: LayerLinework): PlanPath[] {
  const out: PlanPath[] = []
  for (let k = 0; k + 1 < l.starts.length; k++) {
    const a = l.starts[k]
    const b = l.starts[k + 1]
    const xs = new Float64Array(b - a)
    const ys = new Float64Array(b - a)
    let x0 = Infinity
    let y0 = Infinity
    let x1 = -Infinity
    let y1 = -Infinity
    for (let i = a; i < b; i++) {
      const x = l.points[i * 3]
      const y = l.points[i * 3 + 1]
      xs[i - a] = x
      ys[i - a] = y
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
    }
    if (Number.isFinite(x0)) out.push({ xs, ys, closed: l.closed[k] === 1, x0, y0, x1, y1 })
  }
  return out
}

/**
 * The extent of the main body of the drawing, leaving out what sits far from it.
 *
 * Per axis: the paths' intervals, sorted and merged wherever the gap between them is under
 * `CLUSTER_GAP` of the whole span; the cluster holding the most points wins. A point-count
 * quantile would be the obvious alternative and is wrong here — the walls of a room are a
 * handful of points against tens of thousands in the symbols inside it, so trimming the
 * extreme half-percent of points trims the walls.
 */
function mainExtent(paths: PlanPath[]): { x0: number; y0: number; x1: number; y1: number } {
  const axis = (lo: (p: PlanPath) => number, hi: (p: PlanPath) => number): [number, number] => {
    const sorted = [...paths].sort((a, b) => lo(a) - lo(b))
    const min = lo(sorted[0])
    let max = -Infinity
    for (const p of paths) max = Math.max(max, hi(p))
    const gap = (max - min) * CLUSTER_GAP
    let best: [number, number] = [min, max]
    let bestW = -1
    let start = lo(sorted[0])
    let end = hi(sorted[0])
    let w = 0
    for (const p of sorted) {
      if (lo(p) > end + gap) {
        if (w > bestW) {
          bestW = w
          best = [start, end]
        }
        start = lo(p)
        end = hi(p)
        w = 0
      }
      end = Math.max(end, hi(p))
      w += p.xs.length
    }
    if (w > bestW) best = [start, end]
    return best
  }
  const [x0, x1] = axis((p) => p.x0, (p) => p.x1)
  const [y0, y1] = axis((p) => p.y0, (p) => p.y1)
  return { x0, y0, x1, y1 }
}

/**
 * One-pixel line, 8-connected, clipped to the sheet.
 *
 * Stepped along the major axis at one pixel per step, so consecutive pixels always touch —
 * at least at a corner, which is all a 4-connected fill needs to be stopped.
 */
function drawLine(ink: Uint8Array, w: number, h: number, a: Px, b: Px): void {
  const c = clip(a, b, w, h)
  if (!c) return
  const [[ax, ay], [bx, by]] = c
  const dx = bx - ax
  const dy = by - ay
  const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy))))
  for (let i = 0; i <= steps; i++) {
    const x = Math.floor(ax + (dx * i) / steps)
    const y = Math.floor(ay + (dy * i) / steps)
    if (x >= 0 && y >= 0 && x < w && y < h) ink[y * w + x] = 1
  }
}

/** Liang–Barsky against [0, w) x [0, h). Null when the segment misses the sheet entirely. */
function clip(a: Px, b: Px, w: number, h: number): [Px, Px] | null {
  let t0 = 0
  let t1 = 1
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const edges: [number, number][] = [
    [-dx, a[0]],
    [dx, w - 1e-9 - a[0]],
    [-dy, a[1]],
    [dy, h - 1e-9 - a[1]],
  ]
  for (const [p, q] of edges) {
    if (p === 0) {
      if (q < 0) return null
      continue
    }
    const r = q / p
    if (p < 0) {
      if (r > t1) return null
      if (r > t0) t0 = r
    } else {
      if (r < t0) return null
      if (r < t1) t1 = r
    }
  }
  return [
    [a[0] + dx * t0, a[1] + dy * t0],
    [a[0] + dx * t1, a[1] + dy * t1],
  ]
}

/**
 * Drop points closer than a pixel to the last one kept, keeping both ends. An arc flattened
 * at 72 segments a turn is hundreds of points a pixel apart on a small symbol, and snapping
 * cannot tell them apart.
 */
function thinned(pts: Px[]): Px[] {
  if (pts.length <= 2) return pts
  const out: Px[] = [pts[0]]
  for (let i = 1; i < pts.length - 1; i++) {
    const q = out[out.length - 1]
    if (Math.hypot(pts[i][0] - q[0], pts[i][1] - q[1]) >= 1) out.push(pts[i])
  }
  out.push(pts[pts.length - 1])
  return out
}

function lengthOf(pts: Px[], closed: boolean): number {
  let l = 0
  for (let i = 1; i < pts.length; i++) l += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1])
  if (closed && pts.length > 2) {
    const a = pts[pts.length - 1]
    l += Math.hypot(pts[0][0] - a[0], pts[0][1] - a[1])
  }
  return l
}
