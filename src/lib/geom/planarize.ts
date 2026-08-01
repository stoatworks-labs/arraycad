/**
 * Triangle soup -> coplanar regions.
 *
 * This is the module that makes the whole tool possible. A CAD export of a theatre is
 * tens of thousands of triangles; an ArrayCalc venue is a few dozen planes. Nothing else
 * closes that gap. Feeding raw triangles to ArrayCalc as individual RoomObjects produces
 * a file it cannot usefully work with, so region merging is not an optimisation — it is
 * the conversion.
 *
 * The method: weld vertices, build edge adjacency, then flood-fill across shared edges
 * while the triangle stays close to the region's own accumulated plane.
 */

import {
  type Plane,
  type Vec3,
  add,
  cross,
  dot,
  len,
  normalize,
  scale,
  sub,
  triArea,
  v3,
} from './vec.ts'

export interface PlanarizeOptions {
  /** Metres. Vertices closer than this fuse, closing the cracks CAD exports are full of. */
  weldTolerance: number
  /** Degrees. How far a triangle's normal may sit from the region's before it splits off. */
  angleTolerance: number
  /** Metres. How far a triangle may sit off the region's plane. Absorbs gentle curvature. */
  offsetTolerance: number
  /** Regions smaller than this (m^2) are dropped as noise — fixings, trim, stray facets. */
  minArea: number
}

export const DEFAULT_PLANARIZE: PlanarizeOptions = {
  weldTolerance: 0.001,
  angleTolerance: 5,
  offsetTolerance: 0.02,
  minArea: 0.05,
}

export interface Region {
  /** Indices into the welded vertex array, 3 per triangle. */
  indices: number[]
  plane: Plane
  area: number
}

export interface WeldedMesh {
  vertices: Vec3[]
  /** 3 indices per triangle. */
  indices: number[]
}

/**
 * Fuse coincident vertices onto a grid of `tol`.
 *
 * Probing the 8 neighbouring cells as well as the home cell matters: two vertices 0.1 mm
 * apart still land in different cells whenever they straddle a cell boundary, and a pure
 * hash-the-quantised-key weld then leaves exactly the hairline cracks it was meant to
 * close — cracks that later split one ceiling into forty regions.
 */
export function weld(positions: Float64Array, tol: number): WeldedMesh {
  const vertices: Vec3[] = []
  const indices: number[] = []
  const grid = new Map<string, number[]>()
  const inv = 1 / Math.max(tol, 1e-9)
  const key = (i: number, j: number, k: number) => `${i},${j},${k}`

  const put = (x: number, y: number, z: number): number => {
    const gi = Math.round(x * inv)
    const gj = Math.round(y * inv)
    const gk = Math.round(z * inv)
    for (let di = -1; di <= 1; di++) {
      for (let dj = -1; dj <= 1; dj++) {
        for (let dk = -1; dk <= 1; dk++) {
          const bucket = grid.get(key(gi + di, gj + dj, gk + dk))
          if (!bucket) continue
          for (const vi of bucket) {
            const v = vertices[vi]
            if (
              Math.abs(v.x - x) <= tol &&
              Math.abs(v.y - y) <= tol &&
              Math.abs(v.z - z) <= tol
            ) {
              return vi
            }
          }
        }
      }
    }
    const idx = vertices.length
    vertices.push(v3(x, y, z))
    const home = key(gi, gj, gk)
    const bucket = grid.get(home)
    if (bucket) bucket.push(idx)
    else grid.set(home, [idx])
    return idx
  }

  for (let i = 0; i + 8 < positions.length; i += 9) {
    const a = put(positions[i], positions[i + 1], positions[i + 2])
    const b = put(positions[i + 3], positions[i + 4], positions[i + 5])
    const c = put(positions[i + 6], positions[i + 7], positions[i + 8])
    // A triangle whose corners welded together has no area and no normal. Drop it here,
    // or it poisons the region normal it gets flood-filled into.
    if (a === b || b === c || a === c) continue
    indices.push(a, b, c)
  }

  return { vertices, indices }
}

/** Undirected edge key. */
const ekey = (a: number, b: number) => (a < b ? `${a}_${b}` : `${b}_${a}`)

/**
 * Group triangles into coplanar regions by flood fill.
 *
 * A candidate joins the region when its normal is within `angleTolerance` of the region's
 * running area-weighted normal AND all three of its corners sit within `offsetTolerance`
 * of the region plane. Testing against the region rather than against the neighbouring
 * triangle is what stops a gently curved surface from being walked all the way around a
 * cylinder one tolerable step at a time.
 */
export function findCoplanarRegions(
  mesh: WeldedMesh,
  opts: PlanarizeOptions = DEFAULT_PLANARIZE,
): Region[] {
  const { vertices, indices } = mesh
  const triCount = indices.length / 3
  if (triCount === 0) return []

  const edgeToTris = new Map<string, number[]>()
  for (let t = 0; t < triCount; t++) {
    const a = indices[t * 3]
    const b = indices[t * 3 + 1]
    const c = indices[t * 3 + 2]
    for (const [p, q] of [
      [a, b],
      [b, c],
      [c, a],
    ]) {
      const k = ekey(p, q)
      const list = edgeToTris.get(k)
      if (list) list.push(t)
      else edgeToTris.set(k, [t])
    }
  }

  const triNormals: Vec3[] = new Array(triCount)
  const triAreas = new Float64Array(triCount)
  const triCentroids: Vec3[] = new Array(triCount)
  for (let t = 0; t < triCount; t++) {
    const a = vertices[indices[t * 3]]
    const b = vertices[indices[t * 3 + 1]]
    const c = vertices[indices[t * 3 + 2]]
    const n = cross(sub(b, a), sub(c, a))
    triAreas[t] = 0.5 * len(n)
    triNormals[t] = normalize(n)
    triCentroids[t] = scale(add(add(a, b), c), 1 / 3)
  }

  const cosTol = Math.cos((opts.angleTolerance * Math.PI) / 180)
  const visited = new Uint8Array(triCount)
  const regions: Region[] = []

  for (let seed = 0; seed < triCount; seed++) {
    if (visited[seed] || triAreas[seed] <= 0) continue

    visited[seed] = 1
    let accumNormal = scale(triNormals[seed], triAreas[seed])
    let accumCentroid = scale(triCentroids[seed], triAreas[seed])
    let accumArea = triAreas[seed]
    const tris = [seed]
    const queue = [seed]

    while (queue.length) {
      const t = queue.pop()!
      const a = indices[t * 3]
      const b = indices[t * 3 + 1]
      const c = indices[t * 3 + 2]

      for (const [p, q] of [
        [a, b],
        [b, c],
        [c, a],
      ]) {
        for (const nb of edgeToTris.get(ekey(p, q)) ?? []) {
          if (visited[nb] || triAreas[nb] <= 0) continue

          const rn = normalize(accumNormal)
          const rc = scale(accumCentroid, 1 / accumArea)
          // abs(): a CAD export routinely has neighbouring facets wound opposite ways.
          // They are still the same physical surface and must merge, so compare the line
          // the normal lies along, not its direction.
          if (Math.abs(dot(triNormals[nb], rn)) < cosTol) continue

          let offsetOk = true
          for (let k = 0; k < 3; k++) {
            const v = vertices[indices[nb * 3 + k]]
            if (Math.abs(dot(sub(v, rc), rn)) > opts.offsetTolerance) {
              offsetOk = false
              break
            }
          }
          if (!offsetOk) continue

          visited[nb] = 1
          tris.push(nb)
          queue.push(nb)
          // Keep the accumulation consistently oriented, otherwise opposite-wound facets
          // cancel and the region normal collapses towards zero.
          const orient = dot(triNormals[nb], rn) < 0 ? -1 : 1
          accumNormal = add(accumNormal, scale(triNormals[nb], triAreas[nb] * orient))
          accumCentroid = add(accumCentroid, scale(triCentroids[nb], triAreas[nb]))
          accumArea += triAreas[nb]
        }
      }
    }

    if (accumArea < opts.minArea) continue

    const normal = normalize(accumNormal)
    const point = scale(accumCentroid, 1 / accumArea)
    const regionIndices: number[] = []
    for (const t of tris) {
      const a = indices[t * 3]
      const b = indices[t * 3 + 1]
      const c = indices[t * 3 + 2]
      // Re-wind every triangle to agree with the region normal so downstream boundary
      // extraction can rely on consistent winding.
      if (dot(triNormals[t], normal) < 0) regionIndices.push(a, c, b)
      else regionIndices.push(a, b, c)
    }

    let area = 0
    for (let i = 0; i < regionIndices.length; i += 3) {
      area += triArea(
        vertices[regionIndices[i]],
        vertices[regionIndices[i + 1]],
        vertices[regionIndices[i + 2]],
      )
    }

    regions.push({ indices: regionIndices, plane: { normal, point }, area })
  }

  return regions.sort((a, b) => b.area - a.area)
}
