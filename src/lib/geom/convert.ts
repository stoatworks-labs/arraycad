/**
 * The conversion pipeline: imported nodes -> ArrayCalc RoomObjects.
 *
 *   transform -> weld -> coplanar regions -> boundary -> simplify -> faces -> RoomObjects
 *
 * Each imported node becomes one ArrayCalc group holding the planes recovered from it, so
 * the CAD object tree survives into the venue file and the user's pruning decisions map
 * onto names they recognise.
 */

import {
  type RoomObject,
  type Vec3,
  DEFAULT_LISTENER_HEIGHT,
  PlaneType,
  Shape,
  cssToArgb,
} from '../dbacv/types.ts'
import { canonicalQuad, quadToTriangles } from '../dbacv/quad.ts'
import type { ImportedNode } from '../import/types.ts'
import { type PlanarizeOptions, DEFAULT_PLANARIZE, findCoplanarRegions, weld } from './planarize.ts'
import {
  type Pt2,
  boundaryLoops,
  dropCollinear,
  levelAlignedRect,
  minAreaRect,
  simplifyClosed,
  toFaces,
} from './polygon.ts'
import { type TransformOptions, applyTransform } from './transform.ts'
import { planeBasis, toPlane2D } from './vec.ts'

/** How a region's outline is turned into ArrayCalc geometry. */
export type FitMode =
  /** Keep the outline. Faithful, but faces that are not symmetric trapezoids split in two. */
  | 'exact'
  /** Replace the outline with a level-aligned bounding rectangle. One quad per region. */
  | 'rect'

export interface ConvertOptions {
  transform: TransformOptions
  planarize: PlanarizeOptions
  /** Metres. Douglas-Peucker tolerance on the recovered outline. */
  simplifyTolerance: number
  fit: FitMode
  /** Cap on RoomObjects emitted per node, largest regions first. 0 means no cap. */
  maxObjectsPerNode: number
}

export const DEFAULT_CONVERT: ConvertOptions = {
  transform: { unitsPerMetre: 1, upAxis: 'z', headingDeg: 0, offset: { x: 0, y: 0, z: 0 }, flipX: false },
  planarize: DEFAULT_PLANARIZE,
  simplifyTolerance: 0.05,
  fit: 'exact',
  maxObjectsPerNode: 0,
}

/** ArrayCalc's own palette, sampled from the fixture, so exports look native. */
export const PLANE_COLOURS: Record<number, string> = {
  [PlaneType.None]: '#ffffff',
  [PlaneType.Listening]: '#e8dcda',
  [PlaneType.Surface]: '#a1e0aa',
  [PlaneType.Type3]: '#cccccc',
  [PlaneType.Stage]: '#c8b4e0',
  [PlaneType.PositioningArea]: '#00c0ae',
}

let seq = 0
const nextId = () => `gen${++seq}`

function baseObject(name: string, planeType: PlaneType, orderIndex: number): RoomObject {
  return {
    id: nextId(),
    name,
    shape: Shape.Quad,
    planeType,
    listenerHeight: DEFAULT_LISTENER_HEIGHT[planeType] ?? 1.2,
    enabled: true,
    locked: false,
    transparent: false,
    color: cssToArgb(PLANE_COLOURS[planeType] ?? '#cccccc'),
    // The fixture uses this same orange for PrintColor on every single object.
    printColor: 4294945280,
    orderIndex,
    origin: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    scaling: { x: 1, y: 1, z: 1 },
    points: [],
    children: [],
  }
}

/** A triangle, whose local frame ArrayCalc leaves entirely alone. Centroid origin is fine. */
function triangleToObject(points: Vec3[], name: string, planeType: PlaneType, order: number): RoomObject {
  const o = baseObject(name, planeType, order)
  const n = points.length
  const cx = points.reduce((s, p) => s + p.x, 0) / n
  const cy = points.reduce((s, p) => s + p.y, 0) / n
  const cz = points.reduce((s, p) => s + p.z, 0) / n
  o.origin = { x: cx, y: cy, z: cz }
  o.shape = Shape.Triangle
  o.points = points.map((p) => ({ x: p.x - cx, y: p.y - cy, z: p.z - cz }))
  return o
}

/**
 * Build RoomObjects from a face's world-space points. May return TWO objects.
 *
 * A quad has to be written in ArrayCalc's canonical local frame — origin on the near
 * edge, symmetric trapezoid, rotation about Z only. See dbacv/quad.ts for what happens
 * when it is not: ArrayCalc collapses the plane to zero depth and says nothing.
 *
 * Quads that cannot be expressed that way (sheared, sideways-tilted, generally
 * quadrilateral) are split into two triangles, which ArrayCalc accepts untouched.
 */
function faceToObjects(points: Vec3[], name: string, planeType: PlaneType, order: number): RoomObject[] {
  if (points.length === 3) return [triangleToObject(points, name, planeType, order)]
  if (points.length !== 4) return []

  const canonical = canonicalQuad(points)
  if (canonical) {
    const o = baseObject(name, planeType, order)
    o.shape = Shape.Quad
    o.origin = canonical.origin
    o.rotation = { x: 0, y: 0, z: canonical.rotationZ }
    o.points = canonical.points
    return [o]
  }

  const [t1, t2] = quadToTriangles(points)
  return [
    triangleToObject(t1, `${name}a`, planeType, order),
    triangleToObject(t2, `${name}b`, planeType, order + 1),
  ]
}

export interface ConvertStats {
  trianglesIn: number
  regionsFound: number
  objectsOut: number
  regionsDropped: number
  /**
   * Faces that could not be written as an ArrayCalc quad and became two triangles each.
   *
   * Worth showing: it is the single reason an object count comes out higher than the
   * region count, and the fix is usually to switch to rectangle fit. Without it the
   * number looks arbitrary.
   */
  quadsSplit: number
}

export interface ConvertResult {
  objects: RoomObject[]
  stats: ConvertStats
  warnings: string[]
}

/** Convert a single imported node's triangle soup into RoomObjects. */
export function convertNode(
  node: ImportedNode,
  planeType: PlaneType,
  opts: ConvertOptions,
): { objects: RoomObject[]; stats: ConvertStats; warnings: string[] } {
  const warnings: string[] = []
  const stats: ConvertStats = { trianglesIn: 0, regionsFound: 0, objectsOut: 0, regionsDropped: 0, quadsSplit: 0 }

  const positions = applyTransform(node.positions, opts.transform)
  stats.trianglesIn = positions.length / 9
  if (stats.trianglesIn === 0) return { objects: [], stats, warnings }

  const mesh = weld(positions, opts.planarize.weldTolerance)
  let regions = findCoplanarRegions(mesh, opts.planarize)
  stats.regionsFound = regions.length

  if (opts.maxObjectsPerNode > 0 && regions.length > opts.maxObjectsPerNode) {
    stats.regionsDropped = regions.length - opts.maxObjectsPerNode
    // findCoplanarRegions already sorted largest-first, so this keeps the biggest surfaces.
    regions = regions.slice(0, opts.maxObjectsPerNode)
  }

  const objects: RoomObject[] = []
  let order = 1

  // A Positioning area MUST be a rectangle. ArrayCalc says so itself: importing a
  // non-rectangular one raises "Positioning areas need to be rectangles… click Ok to
  // transform the plane or Cancel to change the plane type to 'Listening'". Both answers
  // damage the venue, so never emit one that would trigger it.
  const mustBeRectangular = planeType === PlaneType.PositioningArea
  if (mustBeRectangular && opts.fit !== 'rect') {
    warnings.push(
      `"${node.name}" is a Positioning area, which ArrayCalc requires to be rectangular, ` +
        'so it was squared off regardless of the fit setting.',
    )
  }

  for (const region of regions) {
    const loops = boundaryLoops(region, mesh)
    if (loops.length === 0) {
      warnings.push(`"${node.name}": a region had no closed outline and was skipped.`)
      continue
    }

    const basis = planeBasis(region.plane)
    const to2 = (loop: number[]): Pt2[] => loop.map((i) => toPlane2D(mesh.vertices[i], basis))

    let outer = simplifyClosed(dropCollinear(to2(loops[0]), opts.simplifyTolerance), opts.simplifyTolerance)
    let holes: Pt2[][] = []

    if (opts.fit === 'rect' || mustBeRectangular) {
      // Prefer a rectangle aligned to the plane's level direction: it is guaranteed to be
      // writable as a single ArrayCalc quad, whereas the tightest rectangle on a tilted
      // plane is usually diagonal and has to be split into two triangles. Falls back to
      // the min-area rectangle on a horizontal plane, where every direction is level.
      const levelled = levelAlignedRect(
        loops[0].map((i) => mesh.vertices[i]),
        region.plane.normal,
      )
      outer = levelled ? levelled.map((p) => toPlane2D(p, basis)) : minAreaRect(outer)
      // A rectangle has no interior to preserve, so holes go with it. Deliberate: 'rect'
      // is the "give me the coverage area, not the joinery" mode.
      if (loops.length > 1) {
        warnings.push(`"${node.name}": ${loops.length - 1} hole(s) discarded by rectangle fit.`)
      }
    } else {
      holes = loops
        .slice(1)
        .map((l) => simplifyClosed(dropCollinear(to2(l), opts.simplifyTolerance), opts.simplifyTolerance))
        .filter((h) => h.length >= 3)
    }

    if (outer.length < 3) continue

    for (const face of toFaces(outer, holes, basis)) {
      const made = faceToObjects(face.points, `${node.name} ${order}`, planeType, order)
      if (face.points.length === 4 && made.length === 2) stats.quadsSplit++
      for (const obj of made) {
        objects.push(obj)
        order++
      }
    }
  }

  stats.objectsOut = objects.length
  return { objects, stats, warnings }
}

/**
 * Convert a whole selection. Each node with geometry becomes a group; a node that yields a
 * single object is emitted loose, since a group of one is just noise in ArrayCalc's list.
 */
export function convertNodes(
  nodes: { node: ImportedNode; planeType: PlaneType; include: boolean; name: string }[],
  opts: ConvertOptions,
): ConvertResult {
  const objects: RoomObject[] = []
  const warnings: string[] = []
  const stats: ConvertStats = { trianglesIn: 0, regionsFound: 0, objectsOut: 0, regionsDropped: 0, quadsSplit: 0 }
  let groupOrder = 101

  for (const entry of nodes) {
    if (!entry.include) continue
    const r = convertNode(entry.node, entry.planeType, opts)
    stats.trianglesIn += r.stats.trianglesIn
    stats.regionsFound += r.stats.regionsFound
    stats.objectsOut += r.stats.objectsOut
    stats.regionsDropped += r.stats.regionsDropped
    stats.quadsSplit += r.stats.quadsSplit
    warnings.push(...r.warnings)

    if (r.objects.length === 0) continue
    if (r.objects.length === 1) {
      r.objects[0].name = entry.name
      objects.push(r.objects[0])
      continue
    }

    const group = baseObject(entry.name, PlaneType.None, groupOrder++)
    group.shape = Shape.Group
    group.color = cssToArgb('#ffffff')
    group.children = r.objects
    objects.push(group)
  }

  return { objects, stats, warnings }
}
