/**
 * Imported nodes -> MVR scene objects.
 *
 * Shares the whole reduction with the ArrayCalc and Soundvision paths (see
 * `geom/outline.ts`) and differs only in the last step. That step is the simplest of the
 * three, because glTF wants exactly what `planarize.ts` throws away on the way to a
 * parametric plane: triangles. So a recovered outline is triangulated back and written
 * whole — no canonical quad frame, no symmetric-trapezoid restriction, no reduction to a
 * rectangle.
 *
 * Triangulating an outline we just recovered from triangles is not a round trip to
 * nowhere. What comes back is the SIMPLIFIED plane — one welded, coplanar,
 * Douglas-Peucker'd surface where the source had a thousand facets — which is the whole
 * value this tool adds, and it is what a visualiser gets back.
 */

import type { ImportedNode } from '../import/types.ts'
import { PLANE_TYPES, type PlaneType } from '../dbacv/types.ts'
import { type OutlineOptions, type RegionOutline, nodeOutlines } from '../geom/outline.ts'
import { DEFAULT_PLANARIZE } from '../geom/planarize.ts'
import { toFaces, triangulateRing } from '../geom/polygon.ts'
import type { MvrWriteObject, MvrWriteScene } from './write.ts'

export type MvrConvertOptions = OutlineOptions

export const DEFAULT_MVR_CONVERT: MvrConvertOptions = {
  transform: { unitsPerMetre: 1, upAxis: 'z', headingDeg: 0, offset: { x: 0, y: 0, z: 0 }, flipX: false },
  planarize: DEFAULT_PLANARIZE,
  simplifyTolerance: 0.05,
  fit: 'exact',
  maxObjectsPerNode: 0,
}

export interface MvrStats {
  trianglesIn: number
  regionsFound: number
  regionsDropped: number
  objectsOut: number
  trianglesOut: number
}

export interface MvrResult {
  scene: MvrWriteScene
  stats: MvrStats
  warnings: string[]
}

const emptyStats = (): MvrStats => ({
  trianglesIn: 0,
  regionsFound: 0,
  regionsDropped: 0,
  objectsOut: 0,
  trianglesOut: 0,
})

/**
 * The MVR Class name for a plane type.
 *
 * The raw numeric code goes in the name because the labels are INFERRED and not verified
 * against ArrayCalc — the inspector shows the code beside the label for exactly this
 * reason (CLAUDE.md), and a label that leaves the tool unqualified is how a guess turns
 * into folklore in somebody else's file.
 */
export function classNameFor(planeType: PlaneType): string {
  const entry = PLANE_TYPES.find((p) => p.code === planeType)
  return entry ? `${entry.label} (${planeType})` : `Plane type ${planeType}`
}

/**
 * Planar outlines -> one object's triangle soup, in venue metres.
 *
 * `toFaces` first, then `triangulateRing` on each face: that pairing is what carries a
 * region's HOLES through — a stage pit or a lighting void is a second ring, and a single
 * ring triangulation would silently fill it in. `triangulateRing` is the one sanctioned
 * polygon-to-soup route in this codebase (CLAUDE.md), so it is the one used here.
 */
export function outlinesToPositions(outlines: RegionOutline[]): Float64Array {
  const out: number[] = []
  for (const { basis, outer, holes } of outlines) {
    for (const face of toFaces(outer, holes, basis)) triangulateRing(face.points, out)
  }
  return new Float64Array(out)
}

/** A rationalised area, ready to be written alongside the ordinary nodes. */
export interface AreaEntry {
  name: string
  planeType: PlaneType
  outlines: RegionOutline[]
}

/**
 * Convert a whole selection into a scene ready to write.
 *
 * One object per NODE rather than one per region, deliberately. ArrayCalc needs a venue
 * split into parametric planes and its object list reflects that; a visualiser does not,
 * and a tree of four hundred entries called `STALLS RAKE (1..400)` would be worse to work
 * with than the one entry the user pruned by. The regions still arrive as separate
 * surfaces inside the mesh.
 */
export function convertNodesToMvr(
  nodes: { node: ImportedNode; planeType: PlaneType; include: boolean; name: string }[],
  opts: MvrConvertOptions = DEFAULT_MVR_CONVERT,
  areas: AreaEntry[] = [],
  projectName = 'ArrayCAD export',
): MvrResult {
  const objects: MvrWriteObject[] = []
  const warnings: string[] = []
  const stats = emptyStats()

  for (const entry of nodes) {
    if (!entry.include) continue
    const reduced = nodeOutlines(entry.node, opts)
    stats.trianglesIn += reduced.stats.trianglesIn
    stats.regionsFound += reduced.stats.regionsFound
    stats.regionsDropped += reduced.stats.regionsDropped
    warnings.push(...reduced.warnings)

    const positions = outlinesToPositions(reduced.outlines)
    if (positions.length === 0) continue
    objects.push({ name: entry.name, positions, className: classNameFor(entry.planeType) })
  }

  // A rationalised area's triangles are already counted under the nodes it was captured
  // from, so only what it adds is new. Same accounting as the Soundvision converter.
  for (const area of areas) {
    const positions = outlinesToPositions(area.outlines)
    if (positions.length === 0) continue
    stats.regionsFound += area.outlines.length
    objects.push({ name: area.name, positions, className: classNameFor(area.planeType) })
  }

  stats.objectsOut = objects.length
  for (const o of objects) stats.trianglesOut += o.positions.length / 9

  if (objects.length > 0) {
    warnings.push(
      'MVR carries geometry and names. Materials, acoustic properties and listener heights ' +
        'are not part of the format, so the room arrives in the visualiser as plain surfaces.',
    )
  }

  return {
    scene: { projectName, layerName: projectName, objects },
    stats,
    warnings,
  }
}
