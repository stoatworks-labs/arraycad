/**
 * Imported nodes -> Soundvision surfaces.
 *
 * Shares the whole reduction with the ArrayCalc path (see `geom/outline.ts`) and differs
 * only in the last step, which is much the simpler of the two: a Soundvision surface is a
 * free polygon of three or more coplanar points, so a recovered outline goes out whole. No
 * canonical quad frame, no symmetric-trapezoid restriction, no splitting a plane into two
 * triangles just to make it expressible.
 */

import type { ImportedNode } from '../import/types.ts'
import { type OutlineOptions, nodeOutlines } from '../geom/outline.ts'
import { DEFAULT_PLANARIZE } from '../geom/planarize.ts'
import { toFaces } from '../geom/polygon.ts'
import { fromPlane2D, signedArea2 } from '../geom/vec.ts'
import type { SoundvisionFace, SoundvisionScene } from './types.ts'
import { DEFAULT_HEADER } from './types.ts'
import { type Winding, orientFace } from './write.ts'

export interface SoundvisionConvertOptions extends OutlineOptions {
  winding: Winding
}

export const DEFAULT_SOUNDVISION_CONVERT: SoundvisionConvertOptions = {
  transform: { unitsPerMetre: 1, upAxis: 'z', headingDeg: 0, offset: { x: 0, y: 0, z: 0 }, flipX: false },
  planarize: DEFAULT_PLANARIZE,
  simplifyTolerance: 0.05,
  fit: 'exact',
  maxObjectsPerNode: 0,
  winding: 'up',
}

export interface SoundvisionStats {
  trianglesIn: number
  regionsFound: number
  regionsDropped: number
  facesOut: number
  /**
   * Regions that had holes and so could not be one surface.
   *
   * Worth reporting for the same reason `quadsSplit` is on the ArrayCalc side: it is the
   * only reason the face count exceeds the region count, and the fix is rectangle fit.
   */
  regionsTriangulated: number
}

export interface SoundvisionResult {
  scene: SoundvisionScene
  stats: SoundvisionStats
  warnings: string[]
}

const emptyStats = (): SoundvisionStats => ({
  trianglesIn: 0,
  regionsFound: 0,
  regionsDropped: 0,
  facesOut: 0,
  regionsTriangulated: 0,
})

/** Convert one node's triangle soup into Soundvision faces. */
export function convertNodeToFaces(
  node: ImportedNode,
  label: string,
  opts: SoundvisionConvertOptions,
): { faces: SoundvisionFace[]; stats: SoundvisionStats; warnings: string[] } {
  const reduced = nodeOutlines(node, opts)
  const warnings = reduced.warnings
  const stats: SoundvisionStats = { ...reduced.stats, facesOut: 0, regionsTriangulated: 0 }
  const faces: SoundvisionFace[] = []

  for (const { basis, outer, holes } of reduced.outlines) {
    if (holes.length === 0) {
      // The whole point of this target: one region, one surface, outline intact.
      //
      // Force the ring counter-clockwise in the plane's own frame first, so the face normal
      // is the region normal rather than its opposite. (u, v, n) is right-handed, so a
      // positive signed area in (u, v) means the polygon winds around +n. Without this a
      // wall inherits whatever winding the source mesh happened to have, and `orientFace`
      // cannot rescue a vertical face the way it can a floor.
      const ring = signedArea2(outer) < 0 ? [...outer].reverse() : outer
      faces.push({ label, points: ring.map(([x, y]) => fromPlane2D(x, y, basis)) })
      continue
    }

    // A Soundvision surface is a single ring, so a region with a hole in it cannot be one
    // surface. Triangulating preserves the hole; discarding it would silently fill in a
    // stage pit or a lighting void.
    stats.regionsTriangulated++
    for (const face of toFaces(outer, holes, basis)) {
      faces.push({ label, points: face.points })
    }
  }

  for (const face of faces) face.points = orientFace(face.points, opts.winding)
  stats.facesOut = faces.length
  return { faces, stats, warnings }
}

/**
 * Convert a whole selection into a scene ready to write.
 *
 * `planeType` is deliberately absent. The 3D room data format carries geometry and a label
 * and nothing else — audience listening levels are set inside Soundvision after import,
 * which its own documentation is explicit about. The label is therefore the only handle the
 * user gets for finding a surface again, so it is the node name they already recognise.
 */
export function convertNodesToSoundvision(
  nodes: { node: ImportedNode; include: boolean; name: string }[],
  opts: SoundvisionConvertOptions = DEFAULT_SOUNDVISION_CONVERT,
): SoundvisionResult {
  const faces: SoundvisionFace[] = []
  const warnings: string[] = []
  const stats = emptyStats()

  for (const entry of nodes) {
    if (!entry.include) continue
    // The stock plug-ins label every face "<layer name> face", so match that: an export
    // that reads the way a Vectorworks one does is one less thing for a user to question.
    const r = convertNodeToFaces(entry.node, `${entry.name} face`, opts)
    stats.trianglesIn += r.stats.trianglesIn
    stats.regionsFound += r.stats.regionsFound
    stats.regionsDropped += r.stats.regionsDropped
    stats.facesOut += r.stats.facesOut
    stats.regionsTriangulated += r.stats.regionsTriangulated
    warnings.push(...r.warnings)
    faces.push(...r.faces)
  }

  if (faces.length > 0) {
    warnings.push(
      'Soundvision 3D room data carries geometry only. Audience listening levels, and which ' +
        'surfaces are enabled for mapping, still have to be set in Soundvision after importing.',
    )
  }

  return { scene: { header: [...DEFAULT_HEADER], faces }, stats, warnings }
}
