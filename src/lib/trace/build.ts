/**
 * Traced regions -> the same ImportedScene every other importer produces.
 *
 * This is the join between the tracer and everything that already works. Once a trace is
 * an ImportedScene it goes through weld, coplanar regions, outline recovery and the quad
 * canonicalisation untouched, so a plan traced by hand and a glTF from Vectorworks reach
 * ArrayCalc by exactly the same road — and the 150-odd tests that guard that road cover
 * both.
 *
 * The scene is declared as metres, Z up, because calibration has already been applied.
 * That leaves the Placement panel's heading, offset and mirror still useful for aiming the
 * room down +X, which is what they are for.
 */

import earcut from 'earcut'
import type { ImportedNode, ImportedScene } from '../import/types.ts'
import { type Pt2 } from '../geom/polygon.ts'
import { signedArea2 } from '../geom/vec.ts'
import { type Calibration, type Px, type TraceDocument, type TraceRegion } from './types.ts'
import { pxToVenue } from './calibrate.ts'
import { type PlanPoint, fitHeightPlane, heightAt } from './heights.ts'

/** Below this, a "region" is a stray double-click rather than a surface. */
const MIN_AREA_M2 = 1e-4

/** How far out of plane a fit may pull a vertex before the user is told, in metres. */
const RESIDUAL_WARN_M = 0.02

export interface RegionGeometry {
  /** World-space triangle soup in metres, 9 numbers per triangle. */
  positions: Float64Array
  areaM2: number
  /** Largest vertical correction a plane fit applied, in metres. Zero in free mode. */
  maxResidual: number
  warnings: string[]
}

/** Venue-space plan coordinates and heights for one region, holes included. */
function regionPoints(region: TraceRegion, cal: Calibration): {
  outer: PlanPoint[]
  holes: PlanPoint[][]
} {
  const outer = region.vertices.map((v) => {
    const { x, y } = pxToVenue(v.p, cal)
    return { x, y, z: v.z }
  })
  const holes = region.holes.map((h) =>
    h.map((p) => {
      const { x, y } = pxToVenue(p, cal)
      return { x, y, z: 0 }
    }),
  )
  return { outer, holes }
}

/**
 * Turn one region into triangles.
 *
 * Winding is forced counter-clockwise in venue XY so every surface's normal points UP.
 * Without that, whether a floor faces the ceiling depends on which way round the user
 * happened to click, and nothing downstream would ever tell them.
 */
export function regionGeometry(region: TraceRegion, cal: Calibration): RegionGeometry {
  const warnings: string[] = []
  const { outer, holes } = regionPoints(region, cal)
  if (outer.length < 3) {
    return { positions: new Float64Array(0), areaM2: 0, maxResidual: 0, warnings }
  }

  // Tested before the area check, not after: a symmetric bow tie has two halves of equal
  // and opposite area, so its shoelace total is zero and "encloses no area" would be the
  // only thing the user was told about an outline that is really just crossed.
  if (selfIntersects(outer.map((p) => [p.x, p.y] as Pt2))) {
    warnings.push(
      `"${region.name}" crosses itself. Its triangulation will be wrong — move the crossing ` +
        'vertices apart, or split it into two regions.',
    )
  }

  const area2 = signedArea2(outer.map((p) => [p.x, p.y] as Pt2))
  const areaM2 = Math.abs(area2) / 2
  if (areaM2 < MIN_AREA_M2) {
    warnings.push(`"${region.name}" encloses no area and was skipped.`)
    return { positions: new Float64Array(0), areaM2, maxResidual: 0, warnings }
  }

  const ring = area2 < 0 ? [...outer].reverse() : outer

  // Holes always take the fitted plane: a hole is a gap in a surface, not a surface, so it
  // has no heights of its own to honour.
  const fit = fitHeightPlane(ring)
  const holeZ = (p: { x: number; y: number }) => heightAt(fit, p.x, p.y)

  let maxResidual = 0
  let zOf: (p: PlanPoint) => number
  if (region.heightMode === 'plane') {
    maxResidual = fit.maxResidual
    zOf = (p) => heightAt(fit, p.x, p.y)
    if (fit.maxResidual > RESIDUAL_WARN_M) {
      warnings.push(
        `"${region.name}": the typed heights are not coplanar, so fitting one flat plane ` +
          `moved a corner by ${(fit.maxResidual * 1000).toFixed(0)} mm. Switch it to "follow ` +
          'heights exactly" if the surface really is stepped.',
      )
    }
  } else {
    zOf = (p) => p.z
    if (fit.maxResidual > RESIDUAL_WARN_M) {
      warnings.push(
        `"${region.name}" follows its heights exactly and is not flat (up to ` +
          `${(fit.maxResidual * 1000).toFixed(0)} mm out of plane), so it will come out as ` +
          'several ArrayCalc objects rather than one.',
      )
    }
  }

  const flat: number[] = []
  const zs: number[] = []
  for (const p of ring) {
    flat.push(p.x, p.y)
    zs.push(zOf(p))
  }
  const holeIndices: number[] = []
  for (const h of holes) {
    if (h.length < 3) continue
    holeIndices.push(flat.length / 2)
    for (const p of h) {
      flat.push(p.x, p.y)
      zs.push(holeZ(p))
    }
  }

  const tris = earcut(flat, holeIndices, 2)
  if (tris.length === 0) {
    warnings.push(`"${region.name}" could not be triangulated and was skipped.`)
    return { positions: new Float64Array(0), areaM2, maxResidual, warnings }
  }

  const positions = new Float64Array(tris.length * 3)
  for (let i = 0; i < tris.length; i++) {
    const v = tris[i]
    positions[i * 3] = flat[v * 2]
    positions[i * 3 + 1] = flat[v * 2 + 1]
    positions[i * 3 + 2] = zs[v]
  }

  return { positions, areaM2, maxResidual, warnings }
}

/**
 * The whole trace document as an ImportedScene.
 *
 * One node per visible region, keyed by the region's own id so the include/plane-type
 * decisions the user has already made survive every edit to the drawing.
 */
export function buildTraceScene(doc: TraceDocument): ImportedScene {
  const nodes: ImportedNode[] = []
  const warnings: string[] = [...doc.warnings]

  if (doc.calibration.source.kind === 'unset' && doc.regions.length > 0) {
    warnings.push(
      'This drawing has not been calibrated, so the venue is at an arbitrary 1 pixel = 1 cm. ' +
        'Measure a known dimension before exporting.',
    )
  }

  for (const region of doc.regions) {
    if (!region.visible) continue
    const g = regionGeometry(region, doc.calibration)
    warnings.push(...g.warnings)
    if (g.positions.length === 0) continue
    nodes.push({
      id: region.id,
      name: region.name,
      tags: ['traced', region.origin, region.heightMode],
      positions: g.positions,
      suggestedPlaneType: region.planeType,
      children: [],
    })
  }

  return {
    format: doc.format,
    sourceName: doc.sourceName,
    // Calibration has already turned pixels into metres, and heights were typed in metres.
    unitsPerMetre: 1,
    upAxis: 'z',
    nodes,
    warnings,
  }
}

/**
 * Does the ring cross itself?
 *
 * O(n^2), which is fine on a hand-traced outline and is capped so an auto-detected
 * boundary with thousands of corners cannot stall the UI. A crossing is worth catching:
 * earcut produces plausible-looking but wrong triangles for one, and the error only shows
 * up as a strangely shaped plane once it is in ArrayCalc.
 */
export function selfIntersects(ring: Pt2[], maxVertices = 400): boolean {
  const n = ring.length
  if (n < 4 || n > maxVertices) return false
  for (let i = 0; i < n; i++) {
    const a1 = ring[i]
    const a2 = ring[(i + 1) % n]
    for (let j = i + 1; j < n; j++) {
      // Adjacent edges share an endpoint by construction; that is not a crossing.
      if (j === i || (j + 1) % n === i || (i + 1) % n === j) continue
      if (segmentsCross(a1, a2, ring[j], ring[(j + 1) % n])) return true
    }
  }
  return false
}

function segmentsCross(a: Pt2, b: Pt2, c: Pt2, d: Pt2): boolean {
  const o = (p: Pt2, q: Pt2, r: Pt2) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]))
  const o1 = o(a, b, c)
  const o2 = o(a, b, d)
  const o3 = o(c, d, a)
  const o4 = o(c, d, b)
  return o1 !== o2 && o3 !== o4 && o1 !== 0 && o2 !== 0 && o3 !== 0 && o4 !== 0
}

/** Plan area of a region in square metres, for the UI. Ignores holes. */
export function regionAreaM2(region: TraceRegion, cal: Calibration): number {
  if (region.vertices.length < 3) return 0
  const xy = region.vertices.map((v) => {
    const { x, y } = pxToVenue(v.p, cal)
    return [x, y] as Pt2
  })
  return Math.abs(signedArea2(xy)) / 2
}

/** Perimeter in metres, for the UI. */
export function regionPerimeterM(region: TraceRegion, cal: Calibration): number {
  const pts: Px[] = region.vertices.map((v) => v.p)
  if (pts.length < 2) return 0
  let px = 0
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]
    const b = pts[(i + 1) % pts.length]
    px += Math.hypot(b[0] - a[0], b[1] - a[1])
  }
  return px / cal.pixelsPerMetre
}
