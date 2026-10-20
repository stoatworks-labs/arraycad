/**
 * The pre-work pass: read the model, decide what can be settled without asking.
 *
 * A CAD model of a theatre arrives with several thousand objects, of which a few dozen are
 * room surfaces and the rest are dimensions, lighting bars, cable trays and four hundred
 * separately-modelled seats. Every one of them is converted, drawn and picked against until
 * somebody prunes it, so the first minutes with a new file are spent doing work the names
 * in the file already describe.
 *
 * This module does that work up front and hands back a PLAN — what to leave out, what each
 * surface probably is, and which scatterings of objects stand for one audience plane. It is
 * the same set of answers a user reaches by hand; it just reaches them before the first
 * conversion instead of after the twentieth.
 *
 * ## Nothing here touches the scene
 *
 * A plan is applied as `Decisions` and `Rationalisation[]` — the two records the app already
 * keeps beside the immutable scene (AGENTS.md §4). So every part of it is visible in the
 * tree, ghosted rather than hidden in the viewport, and undone by one click. That is the
 * whole reason this is a plan and not a filter: a heuristic that quietly deleted geometry
 * would be indistinguishable from a broken importer.
 *
 * `simplify.ts` is the one part of preparation that does change geometry, and it is
 * separate for exactly that reason.
 *
 * ## It is decided once, at import
 *
 * The thresholds are in metres, so the plan depends on the unit setting, which is itself a
 * guess when the format does not state one. Changing the units afterwards does NOT re-run
 * the plan — the decisions stay where they are, the way a user's own decisions do. Re-run
 * it from the panel if the guess was wrong. Anything else would have a units change quietly
 * un-prune the model an hour into the work.
 */

import { PlaneType } from '../dbacv/types.ts'
import { type ImportedNode, type ImportedScene, flattenNodes } from '../import/types.ts'
import { DEFAULT_RATIONALISE } from '../geom/rationalise.ts'
import { type TransformOptions, applyTransform } from '../geom/transform.ts'
import { LevelIndex, RAKE_TAG, levelKind } from './split.ts'
import { type Category, categorise } from './vocabulary.ts'

export interface PrepareOptions {
  /** Leave out objects whose names say they are not room surfaces. */
  dropClutter: boolean
  /** Leave out objects with almost no surface: fixings, trim, stray facets. */
  dropTiny: boolean
  /** m². The threshold for `dropTiny`, on an object's TOTAL surface area. */
  tinyArea: number
  /**
   * Turn banks of repeated small objects, anything named as seating, and the stepped rakes
   * `split.ts` found, into one plane each.
   */
  flattenSeating: boolean
  /**
   * Set plane types from the names — stage, wall, ceiling — and, where a name says nothing,
   * from the shape: an object that is all wall, or a level one with a room under it and
   * nothing over it, is an obstacle.
   */
  guessPlaneTypes: boolean
  /**
   * Metres. A jump in seat height larger than this starts a new seating area.
   *
   * A rake is continuous — a step of 0.1 to 0.4 m per row — so a real tier is the only
   * thing that clears this. Without it, a stalls block and a balcony four metres above it
   * are fitted with ONE plane, which passes through neither.
   */
  tierGap: number
}

export const DEFAULT_PREPARE: PrepareOptions = {
  dropClutter: true,
  dropTiny: true,
  // A seat pan is ~0.2 m², a door leaf ~2 m². 0.25 m² is below anything that is a surface
  // in its own right and above the bracket, the bolt and the stray facet.
  tinyArea: 0.25,
  flattenSeating: true,
  guessPlaneTypes: true,
  tierGap: 1.5,
}

/** A bank of objects that stands for one audience plane. */
export interface SeatingCluster {
  name: string
  memberIds: string[]
  /** Metres. Handed to the rationalisation as its bridging gap — physically, the row pitch. */
  gapMetres: number
  /**
   * How it was found. Shown to the user, because they carry different confidence. `shape`
   * is a stepped rake `split.ts` cut out of a one-piece model.
   */
  found: 'name' | 'repetition' | 'shape'
  /** Objects captured, for the report. */
  objectCount: number
}

export interface PrepareSummary {
  clutterExcluded: number
  tinyExcluded: number
  planeTypesSet: number
  /** Of `planeTypesSet`, the ones read off the shape because the name said nothing. */
  planeTypesFromShape: number
  seatingAreas: number
  seatingObjects: number
  /** Of `seatingAreas`, the stepped rakes. */
  rakes: number
}

export interface PreparePlan {
  /** Node id -> why it was left out. The reason is shown, so a surprise is explicable. */
  exclude: Map<string, string>
  planeTypes: Map<string, PlaneType>
  seating: SeatingCluster[]
  summary: PrepareSummary
  /** Human-readable lines for the panel. Facts about this model, not general advice. */
  notes: string[]
}

export const EMPTY_PLAN: PreparePlan = {
  exclude: new Map(),
  planeTypes: new Map(),
  seating: [],
  summary: {
    clutterExcluded: 0,
    tinyExcluded: 0,
    planeTypesSet: 0,
    planeTypesFromShape: 0,
    seatingAreas: 0,
    seatingObjects: 0,
    rakes: 0,
  },
  notes: [],
}

/**
 * What one node is, measured rather than named.
 *
 * Everything is in METRES, converted with the transform's scale only. Rotation, mirror and
 * offset are all rigid or sign-flipping, so no question asked here — how big, how much
 * surface, which way up, how far apart — has a different answer before and after them. The
 * one exception is the up axis, which decides which source component is height, and that is
 * read from the transform too.
 *
 * This deliberately does not call `applyTransform`: that copies every coordinate of the
 * model into a new array per node, and preparation runs on the whole scene at import, when
 * the model is at its largest and the user is waiting.
 */
export interface NodeMetrics {
  node: ImportedNode
  category: Category | null
  triangles: number
  /** m², total, both sides counted once. */
  area: number
  /** m², of faces pointing up. A seat solid's pan; a wall has none. */
  upwardArea: number
  /**
   * m², of faces steeper than 60° — walls, whichever way they are wound. The rest of the
   * area is level or gently sloping, again either way up.
   */
  steepArea: number
  /**
   * Metres. The typical edge length of an upward face — how finely the surface is drawn.
   *
   * The floor under a bridging gap. Nothing can be bridged more finely than the mesh that
   * draws it: a deck cut into 1.3 m squares has no two corners closer together than that,
   * so asking to bridge 0.9 m of it joins nothing at all and the area comes back empty.
   */
  upEdge: number
  /** Metres: the two horizontal extents and the vertical one. */
  plan: [number, number]
  height: number
  /** Metres, in venue orientation (z is height). Bounding-box centre. */
  centre: { x: number; y: number; z: number }
}

const upwardCos = Math.cos((DEFAULT_RATIONALISE.upwardDeg * Math.PI) / 180)
/** cos 60°: a face steeper than this is a wall. The same 60° the upward capture stops at. */
const STEEP = 0.5

export function measureNode(node: ImportedNode, transform: TransformOptions): NodeMetrics {
  const s = transform.unitsPerMetre
  const p = node.positions
  // Which source component is height, and which two are the plan. Y-up maps source Y to
  // venue Z (transform.ts), so the plan is X and Z; Z-up leaves the plan as X and Y.
  const up = transform.upAxis === 'y' ? 1 : 2
  const planAxes = up === 1 ? [0, 2] : [0, 1]

  let area = 0
  let upwardArea = 0
  let steepArea = 0
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  // Sampled, not collected: a median over a few hundred edges is the same answer as a
  // median over a hundred thousand, and this runs on the whole scene at import.
  const edges: number[] = []
  const edgeStride = Math.max(1, Math.floor(p.length / 9 / 400))
  let tri = 0

  for (let i = 0; i + 8 < p.length; i += 9) {
    for (let k = 0; k < 9; k += 3) {
      for (let a = 0; a < 3; a++) {
        const v = p[i + k + a]
        if (v < min[a]) min[a] = v
        if (v > max[a]) max[a] = v
      }
    }
    const ux = p[i + 3] - p[i]
    const uy = p[i + 4] - p[i + 1]
    const uz = p[i + 5] - p[i + 2]
    const vx = p[i + 6] - p[i]
    const vy = p[i + 7] - p[i + 1]
    const vz = p[i + 8] - p[i + 2]
    const nx = uy * vz - uz * vy
    const ny = uz * vx - ux * vz
    const nz = ux * vy - uy * vx
    const l = Math.sqrt(nx * nx + ny * ny + nz * nz)
    if (l <= 0) continue
    const a = 0.5 * l * s * s
    area += a
    // Not abs(): the underside of a seat is not a seating surface, which is the same rule
    // `rationalise.capture` follows and for the same reason.
    const upComponent = (up === 1 ? ny : nz) / l
    if (Math.abs(upComponent) < STEEP) steepArea += a
    if (upComponent >= upwardCos) {
      upwardArea += a
      if (tri++ % edgeStride === 0) {
        edges.push(
          Math.hypot(ux, uy, uz) * s,
          Math.hypot(vx, vy, vz) * s,
          Math.hypot(vx - ux, vy - uy, vz - uz) * s,
        )
      }
    }
  }

  edges.sort((x, y) => x - y)

  const span = (a: number) => (min[a] === Infinity ? 0 : (max[a] - min[a]) * s)
  const mid = (a: number) => (min[a] === Infinity ? 0 : ((min[a] + max[a]) / 2) * s)

  return {
    node,
    category: categorise(node.name, node.tags),
    triangles: p.length / 9,
    area,
    upwardArea,
    steepArea,
    upEdge: edges.length ? edges[Math.floor(edges.length / 2)] : 0,
    plan: [span(planAxes[0]), span(planAxes[1])],
    height: span(up),
    centre: { x: mid(planAxes[0]), y: mid(planAxes[1]), z: mid(up) },
  }
}

const PLANE_TYPE_FOR: Partial<Record<Category, PlaneType>> = {
  seating: PlaneType.Listening,
  stage: PlaneType.Stage,
  // Ceilings, walls and rails are all the same thing to ArrayCalc: an acoustic obstacle.
  ceiling: PlaneType.Surface,
  wall: PlaneType.Surface,
  // `floor` is deliberately absent. A floor is Listening as often as it is not — a standing
  // audience, a flat-floor conference room — and Listening is already the default, so
  // naming it here would change nothing and imply a confidence that is not there.
}

/**
 * The largest object a seat can be.
 *
 * A seat is under 0.8 m in plan and about 1.1 m tall; a bar stool and a wheelchair space are
 * bigger. 1.6 m gives room for a modelled seat with its armrests, its base and a bit of
 * loose modelling, and stops a bank of 1 m tables or a row of doors reading as seating.
 */
const SEAT_MAX_SPAN = 1.6
const SEAT_MAX_AREA = 6
/** Below this many alike objects, "repeated" is a coincidence and not a bank of seats. */
const MIN_REPEATS = 8

/**
 * Seats do not tile their own floor, and a floor does.
 *
 * The test that separates the case rationalising is FOR — a scattering of separate objects
 * with air between them — from a continuous surface that merely has "seating" in its name.
 * A seat pan is 0.48 x 0.45 m on a 0.55 x 0.9 m grid, so a packed block covers under half
 * its own footprint; a raked deck covers all of it and then some, being tilted.
 *
 * It matters because rationalising a deck does not merely gain nothing, it can LOSE the
 * deck: a continuous surface drawn coarsely has its corners metres apart, no two of them
 * within the bridging gap, and the alpha shape comes back empty. The venue is then missing
 * its audience, which is a great deal worse than not having been offered the shortcut.
 * `rationalisedAreas` refuses to drop the originals in that case, and this is the other
 * half of it: do not propose it in the first place.
 */
const SEATING_MAX_COVERAGE = 0.7

/**
 * Metres. The bridging gap for a stepped rake.
 *
 * Its treads tile their own footprint, so there is no row pitch to bridge — only the shift
 * that laying steps onto an incline introduces, one step height times the sine of the rake,
 * under 0.4 m for any real seating. A metre clears that with room to spare and still
 * leaves a vomitory standing as a hole.
 */
const RAKE_GAP = 1

/** Share of an unnamed object's surface that has to agree before its shape types it. */
const SHAPE_SHARE = 0.9

/** Bucket key for "the same object again": bounding box to the nearest 100 mm. */
function shapeKey(m: NodeMetrics): string {
  const q = (v: number) => Math.round(v * 10)
  const [a, b] = m.plan[0] <= m.plan[1] ? m.plan : [m.plan[1], m.plan[0]]
  return `${q(a)}:${q(b)}:${q(m.height)}`
}

/**
 * The distance that has to be bridged to join one seat to the next row, measured.
 *
 * The FOURTH nearest neighbour, not the first. In a grid of seats the two nearest are the
 * neighbours to either side — the column pitch, about 0.55 m — and bridging only that turns
 * each row into its own long thin area. The third and fourth are the seats in front and
 * behind, which is the row pitch, and the row pitch is exactly what `rationalise`'s
 * bridging gap is documented to want.
 *
 * The LOWER QUARTILE of those, not the median. A seat on the edge of a block has no
 * neighbours on one side, so its fourth nearest is a diagonal — longer than the pitch, and
 * on a small block the edges outnumber the middle. Taking the quartile reads the answer off
 * the interior of the block, where the spacing is what it says it is. Erring low is also
 * the safe direction: too small splits one area into rows, which is visible and fixable,
 * while too large paves a gangway, which looks right and is not.
 *
 * Sampled above a few hundred objects: this is O(n²) and it is answering "what is the
 * typical spacing", which a sample answers just as well as the whole set.
 */
function estimateRowPitch(members: NodeMetrics[]): number {
  const fallback = DEFAULT_RATIONALISE.gapMetres
  if (members.length < MIN_REPEATS) return fallback

  const sample = members.length > 300 ? members.filter((_, i) => i % Math.ceil(members.length / 300) === 0) : members
  const fourths: number[] = []
  for (const m of sample) {
    const d: number[] = []
    for (const o of members) {
      if (o === m) continue
      const dx = o.centre.x - m.centre.x
      const dy = o.centre.y - m.centre.y
      d.push(Math.hypot(dx, dy))
    }
    if (d.length < 4) continue
    d.sort((a, b) => a - b)
    fourths.push(d[3])
  }
  if (fourths.length === 0) return fallback

  fourths.sort((a, b) => a - b)
  const quartile = fourths[Math.floor(fourths.length / 4)]
  if (!Number.isFinite(quartile) || quartile <= 0) return fallback
  // Clamped: a wild estimate off an odd model must not pave a gangway (too large) or
  // shatter a block into rows (too small). 2 m is already a very generous row pitch.
  return Math.min(Math.max(quartile, 0.6), 2)
}

/**
 * Split a bank by height, so a tier is its own plane.
 *
 * Sorted by height and cut wherever consecutive objects step by more than `tierGap`. One
 * pass, no clustering: seating tiers are separated in height and in nothing else that can
 * be relied on — left and right banks of the same stalls share a plane and must NOT be
 * split, which is why this does not cluster horizontally as well.
 */
function splitByHeight(members: NodeMetrics[], tierGap: number): NodeMetrics[][] {
  const sorted = [...members].sort((a, b) => a.centre.z - b.centre.z)
  const out: NodeMetrics[][] = []
  let current: NodeMetrics[] = []
  let last = Number.NaN
  for (const m of sorted) {
    if (current.length > 0 && m.centre.z - last > tierGap) {
      out.push(current)
      current = []
    }
    current.push(m)
    last = m.centre.z
  }
  if (current.length > 0) out.push(current)
  return out
}

/**
 * The gap a rationalisation should bridge: the row pitch, or the mesh, whichever is coarser.
 *
 * The row pitch is the answer the feature is documented around, and on a bank of separately
 * modelled seats it is the right one. It is not always reachable: a seating deck drawn as a
 * grid of 1.3 m squares has nothing within 0.9 m of anything, and a 0.9 m gap over it
 * bridges NOTHING — every recovered area falls under the minimum and the whole surface
 * disappears from the venue. The mesh's own spacing is the floor under that.
 *
 * Erring coarse here can pave a gangway narrower than the mesh, which is reported as one
 * area where there should be two. Erring fine loses the surface altogether and reports it
 * as a warning nobody asked for. The first is visible; the second is a silent hole.
 */
function bridgingGap(members: NodeMetrics[]): number {
  const mesh = members.reduce((a, m) => Math.max(a, m.upEdge), 0)
  return Math.min(Math.max(estimateRowPitch(members), mesh * 1.2), 3)
}

/** How much of its own plan footprint a group's upward faces cover. */
function coverage(members: NodeMetrics[]): number {
  const box = planBox(members)
  const footprint = Math.max(box.x1 - box.x0, 0) * Math.max(box.y1 - box.y0, 0)
  if (footprint <= 0) return Infinity
  return members.reduce((a, m) => a + m.upwardArea, 0) / footprint
}

/** `Seat.001`, `SEAT 12`, `chair-04` -> the name without its index. */
function unnumbered(name: string): string {
  return name.replace(/[\s._\-#]*\d+\s*$/, '').trim() || name.trim()
}

/**
 * Group the members of a seating bank into the areas they stand for.
 *
 * Name first, because a name is the strongest evidence there is: two nodes called
 * `SEATING - STALLS` and `SEATING - BALCONY` are two areas and no measurement is needed to
 * know it. Height second, for the models that call all 468 seats `Seat.nnn`.
 */
function clusterSeating(
  members: NodeMetrics[],
  found: 'name' | 'repetition',
  opts: PrepareOptions,
): SeatingCluster[] {
  const byName = new Map<string, NodeMetrics[]>()
  for (const m of members) {
    const key = unnumbered(m.node.name)
    const b = byName.get(key)
    if (b) b.push(m)
    else byName.set(key, [m])
  }

  const out: SeatingCluster[] = []
  for (const [name, group] of byName) {
    const tiers = splitByHeight(group, opts.tierGap)
    tiers.forEach((tier, i) => {
      if (coverage(tier) > SEATING_MAX_COVERAGE) return
      out.push({
        name: tiers.length > 1 ? `${name} ${i + 1}` : name,
        memberIds: tier.map((m) => m.node.id),
        gapMetres: bridgingGap(tier),
        found,
        objectCount: tier.length,
      })
    })
  }
  return out
}

/**
 * Banks of alike objects: a bank of chairs nobody named.
 *
 * A glTF or IFC export of an auditorium is hundreds of sibling nodes with the same
 * bounding box, a metre apart, each with an upward face on top. That IS a bank of chairs,
 * whatever it is called, and it is the case the vocabulary cannot reach — the names are
 * `Component#412` or a GUID.
 *
 * Three conditions together, because any one alone has a common false positive: alike in
 * size (but so are floor tiles), small (but so are bollards), and with a face pointing up
 * (a floor tile has one of those too — which is why "alike AND small AND upward AND at
 * least eight of them" is the test and no single part of it is).
 */
function detectRepeatedBanks(all: NodeMetrics[], taken: Set<string>): NodeMetrics[][] {
  const buckets = new Map<string, NodeMetrics[]>()
  for (const m of all) {
    if (taken.has(m.node.id)) continue
    if (m.triangles === 0 || m.node.children.length > 0) continue
    if (m.category !== null) continue
    if (Math.max(m.plan[0], m.plan[1]) > SEAT_MAX_SPAN || m.height > SEAT_MAX_SPAN) continue
    if (m.area > SEAT_MAX_AREA || m.upwardArea <= 0) continue
    const k = shapeKey(m)
    const b = buckets.get(k)
    if (b) b.push(m)
    else buckets.set(k, [m])
  }
  return [...buckets.values()].filter((b) => b.length >= MIN_REPEATS)
}

const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`

/**
 * Read a scene and decide what can be settled without asking.
 *
 * Pure, and cheap: one pass over the geometry for the measurements and no planarising at
 * all. On a model big enough for this to matter, the conversion it saves costs orders of
 * magnitude more than the pass itself.
 */
export function preparePlan(
  scene: ImportedScene,
  transform: TransformOptions,
  options: Partial<PrepareOptions> = {},
): PreparePlan {
  const opts = { ...DEFAULT_PREPARE, ...options }
  const metrics = flattenNodes(scene.nodes).map((n) => measureNode(n, transform))
  const withGeometry = metrics.filter((m) => m.triangles > 0)

  const exclude = new Map<string, string>()
  const planeTypes = new Map<string, PlaneType>()
  const notes: string[] = []

  // Clutter first: a lighting bar is not a candidate for anything that follows.
  if (opts.dropClutter) {
    for (const m of withGeometry) {
      if (m.category === 'clutter') exclude.set(m.node.id, 'named as something other than a room surface')
    }
  }

  // Seating BEFORE the size test, and that order is load-bearing. A seat modelled as a flat
  // pan has about 0.2 m² of surface, which is below any sensible "too small to matter"
  // threshold — so running the size test first would leave out the entire audience, one
  // seat at a time, and the report would call it four hundred pieces of trim.
  const seating: SeatingCluster[] = []
  if (opts.flattenSeating) {
    // Stepped rakes `split.ts` cut out of a one-piece model, first: they are already one
    // sector each, measured to fit a plane, and need no clustering. Not through the
    // coverage test either — a rake's treads tile its footprint by construction, which is
    // exactly what that test refuses, and the risk it guards (a coarse deck losing its
    // area) is the one the bridging below is set for.
    for (const m of withGeometry) {
      if (!m.node.tags.includes(RAKE_TAG) || exclude.has(m.node.id)) continue
      seating.push({ name: m.node.name, memberIds: [m.node.id], gapMetres: RAKE_GAP, found: 'shape', objectCount: 1 })
    }

    const named = withGeometry.filter((m) => m.category === 'seating' && !exclude.has(m.node.id))
    seating.push(...clusterSeating(named, 'name', opts))

    const taken = new Set(seating.flatMap((c) => c.memberIds))
    for (const bank of detectRepeatedBanks(withGeometry, taken)) {
      const usable = bank.filter((m) => !exclude.has(m.node.id))
      if (usable.length < MIN_REPEATS) continue
      seating.push(...clusterSeating(usable, 'repetition', opts))
    }
  }
  const inSeating = new Set(seating.flatMap((c) => c.memberIds))

  const unnamed: NodeMetrics[] = []
  for (const m of withGeometry) {
    if (exclude.has(m.node.id)) continue
    if (opts.dropTiny && !inSeating.has(m.node.id) && m.area < opts.tinyArea) {
      exclude.set(m.node.id, `only ${m.area.toFixed(2)} m² of surface`)
      continue
    }
    if (opts.guessPlaneTypes && m.category) {
      const t = PLANE_TYPE_FOR[m.category]
      if (t !== undefined) planeTypes.set(m.node.id, t)
    } else if (opts.guessPlaneTypes && !inSeating.has(m.node.id)) {
      unnamed.push(m)
    }
  }

  // Where the name says nothing, the shape. Only the clear cases: an object that is all
  // wall, or all level with a room's height under it and no standing room over it. A mix
  // of the two is a one-piece model that `split.ts` did not take apart, and guessing one
  // type for all of it would be wrong for most of it.
  let fromShape = 0
  if (unnamed.length > 0) {
    let index: LevelIndex | null = null
    /** The level and gently sloping triangles of a node, in venue metres. */
    const levelTris = (n: ImportedNode): number[][] => {
      const p = applyTransform(n.positions, transform)
      const out: number[][] = []
      for (let i = 0; i + 8 < p.length; i += 9) {
        const t = Array.from(p.subarray(i, i + 9))
        const nx = (t[4] - t[1]) * (t[8] - t[2]) - (t[5] - t[2]) * (t[7] - t[1])
        const ny = (t[5] - t[2]) * (t[6] - t[0]) - (t[3] - t[0]) * (t[8] - t[2])
        const nz = (t[3] - t[0]) * (t[7] - t[1]) - (t[4] - t[1]) * (t[6] - t[0])
        const l = Math.hypot(nx, ny, nz)
        if (l > 0 && Math.abs(nz) / l >= STEEP) out.push(t)
      }
      return out
    }
    for (const m of unnamed) {
      const level = m.area - m.steepArea
      if (m.steepArea >= SHAPE_SHARE * m.area) {
        planeTypes.set(m.node.id, PlaneType.Surface)
        fromShape++
      } else if (level >= SHAPE_SHARE * m.area) {
        // Everything left in, not just the unnamed: a ceiling is told by the room under it,
        // and that room's floor may well be called FLOOR.
        index ??= new LevelIndex(withGeometry.filter((o) => !exclude.has(o.node.id)).flatMap((o) => levelTris(o.node)))
        if (levelKind(levelTris(m.node), index) === 'ceiling') {
          planeTypes.set(m.node.id, PlaneType.Surface)
          fromShape++
        }
      }
    }
  }

  const summary: PrepareSummary = {
    clutterExcluded: 0,
    tinyExcluded: 0,
    planeTypesSet: planeTypes.size,
    planeTypesFromShape: fromShape,
    seatingAreas: seating.length,
    seatingObjects: seating.reduce((n, c) => n + c.objectCount, 0),
    rakes: seating.filter((c) => c.found === 'shape').length,
  }
  for (const reason of exclude.values()) {
    if (reason.startsWith('named')) summary.clutterExcluded++
    else summary.tinyExcluded++
  }

  if (summary.clutterExcluded > 0) {
    notes.push(`Left out ${plural(summary.clutterExcluded, 'object')} named as drawing furniture, rigging, services or contents.`)
  }
  if (summary.tinyExcluded > 0) {
    notes.push(`Left out ${plural(summary.tinyExcluded, 'object')} with under ${opts.tinyArea} m² of surface.`)
  }
  const fromName = summary.planeTypesSet - summary.planeTypesFromShape
  if (fromName > 0) {
    notes.push(`Set a plane type on ${plural(fromName, 'object')} from its name.`)
  }
  if (summary.planeTypesFromShape > 0) {
    notes.push(
      `Made ${plural(summary.planeTypesFromShape, 'unnamed object')} a surface from its shape: all wall, or a ceiling with the room under it.`,
    )
  }
  if (summary.rakes > 0) {
    notes.push(
      `Fitted an audience plane to each of ${plural(summary.rakes, 'stepped rake')} found by shape, risers and all.`,
    )
  }
  const gathered = seating.filter((c) => c.found !== 'shape')
  if (gathered.length > 0) {
    notes.push(
      `Flattened ${plural(gathered.reduce((n, c) => n + c.objectCount, 0), 'object')} into ${plural(gathered.length, 'audience area')}.`,
    )
  }

  // A floor modelled under seating that has just been flattened is a SECOND listening plane
  // half a metre below the first. Reported rather than acted on: which of the two a designer
  // wants is a judgement about the venue — the seat pans or the raked floor they stand on —
  // and quietly dropping the floor of a room with no seating flattened would be worse.
  // Not for a rake cut by shape: its floor is a different set of triangles from the same
  // model, beside the rake rather than under it, and a bounding box would say otherwise.
  if (gathered.length > 0) {
    const seatBoxes = gathered.map((c) => {
      const ms = c.memberIds.map((id) => withGeometry.find((m) => m.node.id === id)!).filter(Boolean)
      return planBox(ms)
    })
    const floors = withGeometry.filter(
      (m) => m.category === 'floor' && !exclude.has(m.node.id) && seatBoxes.some((b) => overlaps(b, planBox([m]))),
    )
    if (floors.length > 0) {
      const many = floors.length > 1
      notes.push(
        `${floors.map((f) => `"${f.node.name}"`).join(', ')} ${many ? 'lie' : 'lies'} under flattened seating. ` +
          `${many ? 'They are' : 'It is'} still included, as a second listening plane below the seats — ` +
          `turn ${many ? 'them' : 'it'} off if you want one plane.`,
      )
    }
  }

  return { exclude, planeTypes, seating, summary, notes }
}

interface Box {
  x0: number
  y0: number
  x1: number
  y1: number
}

function planBox(ms: NodeMetrics[]): Box {
  const b: Box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity }
  for (const m of ms) {
    b.x0 = Math.min(b.x0, m.centre.x - m.plan[0] / 2)
    b.x1 = Math.max(b.x1, m.centre.x + m.plan[0] / 2)
    b.y0 = Math.min(b.y0, m.centre.y - m.plan[1] / 2)
    b.y1 = Math.max(b.y1, m.centre.y + m.plan[1] / 2)
  }
  return b
}

/** Plan-view overlap, with a margin so two boxes merely touching do not count. */
function overlaps(a: Box, b: Box): boolean {
  const m = 0.5
  return a.x0 < b.x1 - m && b.x0 < a.x1 - m && a.y0 < b.y1 - m && b.y0 < a.y1 - m
}
