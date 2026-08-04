/**
 * Fewer triangles for the same shape.
 *
 * The one part of preparation that changes geometry, and the only reason it is allowed to
 * is that it changes no SHAPE. A CAD export tessellates a flat wall into two hundred
 * triangles because that is what the modeller's mesher produced; every one of them is
 * uploaded to the GPU, projected once per vertex on every marquee drag, and welded and
 * flood-filled again on every conversion. Merging them back into the flat region they
 * already form and re-cutting that region from its own boundary gives the same surface with
 * a fraction of the triangles.
 *
 * This is `planarize` run early and written back, and that is the point: it is not a
 * decimator. There is no error metric to tune and no vertex budget to hit. A region is
 * either flat within the tolerances the conversion is going to use anyway — in which case
 * its interior tessellation carries no information and goes — or it is not, in which case
 * nothing is touched. The outline is preserved exactly; only the cutting-up inside it
 * changes.
 *
 * ## What it deliberately refuses to do
 *
 * - **A region that is only NEARLY flat is left alone.** This is the subtle one, and it cost
 *   a wrong answer to find. `findCoplanarRegions` deliberately tolerates gentle curvature —
 *   a triangle may sit up to `offsetTolerance` (20 mm) off the region plane and still
 *   belong to it — so a "region" can be a shallow dome or a stepped rake read as one
 *   surface. Its own small triangles are each very nearly flat; a re-cut joining ring
 *   points ten metres apart is not, and its triangles come out at angles to each other that
 *   the NEXT flood fill then splits along. The demo venue's stepped balcony went from 11
 *   regions to 14 that way: fewer triangles, a different room. So flatness is re-measured
 *   here, against a tolerance a thousand times tighter, and only a genuinely flat region is
 *   re-cut.
 * - **A region with a hole is left alone.** Triangulating from the outer ring alone would
 *   fill the opening: a wall with a doorway would come back solid. Same class of fault as
 *   the centroid fan in `polygon.ts` — plausible on screen, wrong on site.
 * - **A ring that will not triangulate cleanly is left alone.** `triangulateRing` falls back
 *   to a centroid fan for a ring too warped to project; a fan across a concave outline lays
 *   surface over empty space, so the fallback is refused here and the original triangles are
 *   kept instead.
 * - **Small objects are left alone.** Below the threshold there is nothing to win and every
 *   pass over the geometry costs something.
 *
 * ## Units
 *
 * `ImportedNode.positions` are SOURCE coordinates, and must stay that way — the transform is
 * applied later, once, in `geom/transform.ts`. So the tolerances, which are stated in
 * metres like every other tolerance in the app, are divided into source units here rather
 * than the geometry being multiplied into metres. The alternative — transform, simplify,
 * transform back — is a second copy of `applyTransform` and its inverse, which is exactly
 * what the origin-picker rule in CLAUDE.md exists to prevent.
 *
 * That scale comes from the unit setting in force at import, which for a format that does
 * not state its units is a guess. A wrong guess makes the tolerances wrong by the same
 * factor; re-running preparation after fixing the units re-reads the file.
 */

import type { ImportedNode, ImportedScene } from '../import/types.ts'
import { type PlanarizeOptions, type Region, DEFAULT_PLANARIZE, findCoplanarRegions, weld } from '../geom/planarize.ts'
import { boundaryLoops, triangulateRing } from '../geom/polygon.ts'
import type { TransformOptions } from '../geom/transform.ts'
import { type Vec3, cross, dot, len, sub } from '../geom/vec.ts'

export interface SimplifyOptions {
  /**
   * Only objects with more triangles than this are touched.
   *
   * 500 is comfortably above a hand-drawn room surface and comfortably below anything a
   * mesher produced. Below it the pass would cost more than it saves.
   */
  minTriangles: number
  /** Metres. The same tolerances the conversion uses, so nothing is lost that it would keep. */
  planarize: Pick<PlanarizeOptions, 'weldTolerance' | 'angleTolerance' | 'offsetTolerance'>
  /**
   * Metres. How far a region's vertices may sit off its own plane and still be re-cut.
   *
   * Far tighter than `offsetTolerance`, and not the same question. That one asks what may
   * be MERGED into a surface; this one asks what may be REDRAWN as one, which is only
   * something already flat. See the note above about the stepped balcony.
   */
  flatTolerance: number
}

export const DEFAULT_SIMPLIFY: SimplifyOptions = {
  minTriangles: 500,
  planarize: {
    weldTolerance: DEFAULT_PLANARIZE.weldTolerance,
    angleTolerance: DEFAULT_PLANARIZE.angleTolerance,
    offsetTolerance: DEFAULT_PLANARIZE.offsetTolerance,
  },
  // The weld tolerance: geometry closer together than this is already treated as the same
  // point everywhere else in the app, so a region flat to within it is flat.
  flatTolerance: DEFAULT_PLANARIZE.weldTolerance,
}

export interface SimplifyStats {
  /** Objects big enough to be worth trying. */
  nodesConsidered: number
  /** Objects that actually came back smaller. */
  nodesSimplified: number
  trianglesIn: number
  trianglesOut: number
  /** Regions kept as they were: holes, or an outline too warped to re-cut. */
  regionsRefused: number
}

const EMPTY: SimplifyStats = {
  nodesConsidered: 0,
  nodesSimplified: 0,
  trianglesIn: 0,
  trianglesOut: 0,
  regionsRefused: 0,
}

/**
 * Drop ring vertices that lie ON the line between their neighbours.
 *
 * The edge of a meshed wall carries a vertex everywhere anything else touched it, and a
 * straight edge with forty vertices on it re-cuts into forty triangles instead of one. A
 * point within `tol` of the chord through its neighbours is not describing the shape, so
 * removing it does not change the shape.
 *
 * NOT Douglas-Peucker. This only removes points that were already redundant; shaving a
 * genuine corner off an outline is a decision, it belongs to the user's `simplifyTolerance`
 * setting, and it happens later where it can be seen and turned off.
 *
 * A dropped vertex may still be a corner of the region NEXT DOOR, which leaves a T-junction
 * between them. That is deliberate and harmless here: the point lay on the edge to within
 * the weld tolerance, so the two surfaces still meet along exactly the same line, and the
 * two regions are on different planes anyway and were never going to merge.
 */
export function dropCollinear3(ring: Vec3[], tol: number): Vec3[] {
  if (ring.length < 4) return ring
  const out: Vec3[] = []
  let anchor = ring[ring.length - 1]
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i]
    const next = ring[(i + 1) % ring.length]
    const e = sub(next, anchor)
    const l = len(e)
    // Perpendicular distance from p to the line anchor->next, as the area of the
    // parallelogram over its base.
    const d = l > 0 ? len(cross(sub(p, anchor), e)) / l : len(sub(p, anchor))
    if (d > tol) {
      out.push(p)
      anchor = p
    }
  }
  // Everything collinear: a ring with no area, which triangulates to nothing anyway.
  return out.length >= 3 ? out : ring
}

/**
 * Degrees. How far a re-cut triangle's normal may sit from the region it came from.
 *
 * Deliberately far tighter than the merge angle, and it is the guard that actually holds
 * this pass together. A triangulator turns a concave outline into whatever it has to,
 * including very thin slivers, and a sliver a millimetre wide across a region that is flat
 * only to a tenth of a millimetre comes out at a wild angle: the non-planarity that was
 * spread harmlessly over four hundred small triangles is concentrated into two. The next
 * flood fill then splits along it and the venue quietly gains objects.
 *
 * Rather than trying to predict that from the input, the output is measured. Anything that
 * does not come back flat is thrown away and the original triangles are kept.
 */
const RECUT_MAX_TILT_DEG = 1

/**
 * Regions that touch another region nearly parallel to themselves.
 *
 * These are the ones that must not be re-cut, and finding out why cost the demo venue's
 * balcony. It is a fan of raked seating tiers, each one two or three degrees off the next
 * and every one of them a separate region — separate only because the flood fill's running
 * plane drifts out of tolerance as it walks along. Which triangle ends up in which region
 * is then decided by the tessellation itself, so re-cutting one tier into three large
 * triangles changes the answer for its NEIGHBOURS: eleven tiers came back as thirteen
 * regions with the areas shuffled between them.
 *
 * There is no per-region guard against that, because the region that changes is not the
 * region that was re-cut. The only safe rule is to leave the whole neighbourhood alone —
 * which costs nothing on the surfaces this pass is actually for. A meshed wall, a ceiling
 * or a floor meets its neighbours at a corner, not at three degrees.
 *
 * The band is twice the merge angle: a margin, because the question is not "would these
 * merge" but "is the boundary between them close enough to the tolerance for the answer to
 * depend on how finely they are cut".
 */
function nearlyParallelNeighbours(
  regions: Region[],
  flat: (r: Region) => boolean,
  angleToleranceDeg: number,
): Set<Region> {
  const out = new Set<Region>()
  const cosBand = Math.cos((Math.min(angleToleranceDeg * 2, 89) * Math.PI) / 180)

  const owner = new Map<string, Region>()
  for (const region of regions) {
    for (let i = 0; i < region.indices.length; i += 3) {
      const [a, b, c] = [region.indices[i], region.indices[i + 1], region.indices[i + 2]]
      for (const [p, q] of [
        [a, b],
        [b, c],
        [c, a],
      ]) {
        const k = p < q ? `${p}_${q}` : `${q}_${p}`
        const other = owner.get(k)
        if (other === undefined) {
          owner.set(k, region)
          continue
        }
        if (other === region) continue
        if (Math.abs(dot(other.plane.normal, region.plane.normal)) <= cosBand) continue
        // Near-parallel neighbours are only dangerous when one of them is NOT flat. A
        // faceted vault is a dozen near-parallel regions and re-cutting it changes nothing,
        // because each facet is exactly the plane it claims to be and its triangles say the
        // same thing however few of them there are. It is the bulging neighbour whose
        // grouping depends on the tessellation, and it takes its neighbours with it.
        if (flat(region) && flat(other)) continue
        out.add(region)
        out.add(other)
      }
    }
  }
  return out
}

/** Every triangle written since `from` lies in the same plane as the region did. */
function agreesWithPlane(out: number[], from: number, normal: Vec3): boolean {
  const cosTol = Math.cos((RECUT_MAX_TILT_DEG * Math.PI) / 180)
  for (let i = from; i + 8 < out.length; i += 9) {
    const u = { x: out[i + 3] - out[i], y: out[i + 4] - out[i + 1], z: out[i + 5] - out[i + 2] }
    const v = { x: out[i + 6] - out[i], y: out[i + 7] - out[i + 1], z: out[i + 8] - out[i + 2] }
    const n = cross(u, v)
    const l = len(n)
    // A degenerate triangle has no normal to compare and no surface either; the
    // triangulator emits them on a ring with repeated points and they are harmless.
    if (l <= 0) continue
    // abs(): the triangulator's winding follows the ring, which may run either way round.
    if (Math.abs(dot(n, normal)) / l < cosTol) return false
  }
  return true
}

/**
 * Re-cut one node's triangles from the flat regions they form.
 *
 * Returns the original array when there is nothing to win, so an unchanged node keeps its
 * identity and the viewport does not rebuild geometry it already has.
 */
export function simplifyPositions(
  positions: Float64Array,
  opts: SimplifyOptions,
  unitsPerMetre: number,
  stats: SimplifyStats,
): Float64Array {
  const triangles = positions.length / 9
  if (triangles <= opts.minTriangles) return positions
  stats.nodesConsidered++

  // Metres -> source units. A model in millimetres has unitsPerMetre 0.001, so a 1 mm weld
  // tolerance becomes 1.0 in source units, which is the same physical distance.
  const s = unitsPerMetre > 0 ? unitsPerMetre : 1
  const mesh = weld(positions, opts.planarize.weldTolerance / s)
  const regions = findCoplanarRegions(mesh, {
    weldTolerance: opts.planarize.weldTolerance / s,
    angleTolerance: opts.planarize.angleTolerance,
    offsetTolerance: opts.planarize.offsetTolerance / s,
    // Nothing may be dropped for being small. This pass re-cuts the model, it does not
    // prune it — pruning is a decision, and it belongs to `plan.ts` where the user can see
    // it and undo it.
    minArea: 0,
  })

  const out: number[] = []
  const keepOriginal = (indices: number[]) => {
    for (const i of indices) {
      const v = mesh.vertices[i]
      out.push(v.x, v.y, v.z)
    }
  }

  const flatTol = opts.flatTolerance / s

  // Flat, or merely within MERGING distance of flat? Measured over every vertex, not just
  // the boundary: re-cutting drops the interior ones, so a bump in the middle of an
  // otherwise flat region would be quietly ironed out.
  const flat = new Map<Region, boolean>()
  for (const region of regions) {
    let bulge = 0
    for (const i of region.indices) {
      const d = Math.abs(dot(sub(mesh.vertices[i], region.plane.point), region.plane.normal))
      if (d > bulge) bulge = d
    }
    flat.set(region, bulge <= flatTol)
  }

  const contested = nearlyParallelNeighbours(regions, (r) => flat.get(r) === true, opts.planarize.angleTolerance)

  for (const region of regions) {
    if (!flat.get(region) || contested.has(region)) {
      stats.regionsRefused++
      keepOriginal(region.indices)
      continue
    }

    const regionTriangles = region.indices.length / 3
    const loops = boundaryLoops(region, mesh)

    if (loops.length !== 1) {
      // No outline at all, or an outline with holes in it. Either way the region cannot be
      // rebuilt from its boundary without inventing surface.
      if (loops.length !== 0) stats.regionsRefused++
      keepOriginal(region.indices)
      continue
    }

    const ring = dropCollinear3(
      loops[0].map((i) => mesh.vertices[i]),
      opts.planarize.weldTolerance / s,
    )
    // A ring re-cut into as many triangles as it started with has saved nothing, and a
    // no-op that rewrites the geometry anyway is a change with no benefit to justify it.
    if (ring.length - 2 >= regionTriangles) {
      keepOriginal(region.indices)
      continue
    }

    const mark = out.length
    const fill = triangulateRing(ring, out)
    if (fill !== 'planar' || !agreesWithPlane(out, mark, region.plane.normal)) {
      out.length = mark
      stats.regionsRefused++
      keepOriginal(region.indices)
    }
  }

  // Zero-area triangles belong to no region — `findCoplanarRegions` will not seed one — and
  // are not carried over. They draw nothing and convert to nothing; losing them is the only
  // geometry this pass discards, and "geometry" is generous.
  if (out.length >= positions.length) return positions

  stats.nodesSimplified++
  return new Float64Array(out)
}

/**
 * Re-cut every heavy object in a scene.
 *
 * Rebuilds the node tree rather than mutating it, keeping every id, name and tag: a plan,
 * a decision and a rationalisation all refer to nodes by id, so a simplified scene has to
 * be interchangeable with the one it came from.
 */
export function simplifyScene(
  scene: ImportedScene,
  transform: TransformOptions,
  options: Partial<SimplifyOptions> = {},
): { scene: ImportedScene; stats: SimplifyStats } {
  const opts = { ...DEFAULT_SIMPLIFY, ...options }
  const stats: SimplifyStats = { ...EMPTY }

  const walk = (nodes: ImportedNode[]): ImportedNode[] =>
    nodes.map((n) => {
      stats.trianglesIn += n.positions.length / 9
      const positions = simplifyPositions(n.positions, opts, transform.unitsPerMetre, stats)
      stats.trianglesOut += positions.length / 9
      return { ...n, positions, children: walk(n.children) }
    })

  const nodes = walk(scene.nodes)
  if (stats.nodesSimplified === 0) return { scene, stats }
  return { scene: { ...scene, nodes }, stats }
}
