/**
 * Rationalisation on synthetic venues where the answer is known by construction.
 *
 * The whole feature is a claim that scattered surfaces stand for one surface, so the tests
 * are mostly about the claims it must REFUSE to make: two blocks must not merge, a hole
 * must not fill in, a stepped rake must report its steps, and a seat solid must not drag
 * the audience plane down inside itself.
 */

import { describe, expect, it } from 'vitest'
import type { ImportedNode } from '../import/types.ts'
import {
  DEFAULT_RATIONALISE,
  type RationaliseOptions,
  alphaComponents,
  fitPlane,
  rationalise,
  smallestEigenvector,
} from './rationalise.ts'
import { signedArea2 } from './vec.ts'

let nodeSeq = 0
const node = (positions: number[], name = 'seats'): ImportedNode => ({
  id: `n${++nodeSeq}`,
  name,
  tags: [],
  positions: Float64Array.from(positions),
  children: [],
})

/** A level square pan, wound so its normal points up. */
function pan(x: number, y: number, size: number, z: number, out: number[]): void {
  const s = size
  out.push(x, y, z, x + s, y, z, x + s, y + s, z)
  out.push(x, y, z, x + s, y + s, z, x, y + s, z)
}

/** A seat as a solid box: an upward pan on top, a downward one beneath, four walls. */
function seatBox(x: number, y: number, size: number, top: number, out: number[]): void {
  pan(x, y, size, top, out)
  // Underside, wound the other way so its normal points down.
  out.push(x, y, 0, x + size, y + size, 0, x + size, y, 0)
  out.push(x, y, 0, x, y + size, 0, x + size, y + size, 0)
  // One vertical side is enough to prove the filter rejects walls.
  out.push(x, y, 0, x + size, y, 0, x + size, y, top)
  out.push(x, y, 0, x + size, y, top, x, y, top)
}

/** `rows` x `cols` pans on `pitch` centres, each `size` across, all at height z. */
function block(
  rows: number,
  cols: number,
  pitch: number,
  size: number,
  z: number,
  ox = 0,
  oy = 0,
): number[] {
  const out: number[] = []
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) pan(ox + c * pitch, oy + r * pitch, size, z, out)
  }
  return out
}

const opts = (patch: Partial<RationaliseOptions> = {}): RationaliseOptions => ({
  ...DEFAULT_RATIONALISE,
  ...patch,
})

const areaOf = (ring: [number, number][]) => Math.abs(signedArea2(ring)) / 2

describe('capture and the plane fit', () => {
  it('reduces a field of separate pans to ONE area', () => {
    // 10 x 10 pans, 0.4 m across on a 0.5 m pitch: 100 separate surfaces that the coplanar
    // flood fill would correctly report as 100 regions, because none of them touch.
    const r = rationalise([node(block(10, 10, 0.5, 0.4, 0))], 'Stalls', opts({ gapMetres: 0.6 }))

    expect(r.outlines).toHaveLength(1)
    expect(r.stats.componentsOut).toBe(1)
    expect(r.stats.trianglesKept).toBe(200)
    // The pans total 100 * 0.16 = 16 m^2; the area they STAND FOR is the 4.9 x 4.9 m block.
    expect(r.stats.areaCaptured).toBeCloseTo(16, 6)
    expect(r.stats.areaEmitted).toBeGreaterThan(20)
    expect(r.stats.areaEmitted).toBeLessThan(24.1)
  })

  it('keeps two blocks apart when nothing bridges them', () => {
    // Two blocks with an 8 m gangway. Merging them would put a listening plane across the
    // gangway — plausible on screen, wrong on site.
    const a = block(6, 6, 0.5, 0.4, 0)
    const b = block(6, 6, 0.5, 0.4, 0, 11, 0)
    const r = rationalise([node([...a, ...b])], 'Stalls', opts({ gapMetres: 0.9 }))

    expect(r.stats.componentsOut).toBe(2)
    expect(r.warnings.join(' ')).toMatch(/2 separate areas/)
  })

  it('merges those same two blocks when the gap is raised past the gangway', () => {
    const a = block(6, 6, 0.5, 0.4, 0)
    const b = block(6, 6, 0.5, 0.4, 0, 11, 0)
    const r = rationalise([node([...a, ...b])], 'Stalls', opts({ gapMetres: 9 }))

    expect(r.stats.componentsOut).toBe(1)
  })

  it('fits an INCLINED plane through a stepped rake, and reports the step', () => {
    // Each row's pan is separately horizontal, which is how an auditorium is modelled. An
    // area-weighted average of the triangle normals would therefore point straight up and
    // describe a flat floor; least squares through the points finds the real rake.
    const out: number[] = []
    for (let row = 0; row < 10; row++) {
      for (let c = 0; c < 6; c++) pan(row * 1.0, c * 0.5, 0.4, row * 0.15, out)
    }
    const r = rationalise([node(out)], 'Rake', opts({ gapMetres: 1.2 }))
    const n = r.outlines[0].basis.n

    // z = 0.15x  =>  normal along (-0.15, 0, 1) normalised. Tilted, and tilted the right way.
    expect(n.z).toBeGreaterThan(0)
    expect(n.x).toBeLessThan(-0.1)
    expect(Math.abs(n.y)).toBeLessThan(1e-9)
    expect(r.stats.maxResidual).toBeGreaterThan(0)
    expect(r.stats.maxResidual).toBeLessThan(0.15)
  })

  it('warns when the captured surfaces are nowhere near one plane', () => {
    // Two tiers 3 m apart is not a rake, and flattening them into one plane is a real loss.
    const lower = block(5, 5, 0.5, 0.4, 0)
    const upper = block(5, 5, 0.5, 0.4, 3)
    const r = rationalise([node([...lower, ...upper])], 'Tiers', opts({ gapMetres: 0.9 }))

    expect(r.stats.maxResidual).toBeGreaterThan(0.25)
    expect(r.warnings.join(' ')).toMatch(/off the single plane/)
  })
})

describe('the face filter', () => {
  it('reduces seat SOLIDS to their pans, not to their middles', () => {
    // Each seat is a box 0.45 m tall. The audience plane is the top, not the centroid of a
    // box, and certainly not dragged down by the underside.
    const out: number[] = []
    for (let r = 0; r < 5; r++) for (let c = 0; c < 5; c++) seatBox(r * 0.5, c * 0.5, 0.4, 0.45, out)

    const up = rationalise([node(out)], 'Seats', opts({ faces: 'upward', gapMetres: 0.6 }))
    expect(up.outlines).toHaveLength(1)
    expect(up.outlines[0].basis.origin.z).toBeCloseTo(0.45, 6)
    expect(up.stats.maxResidual).toBeCloseTo(0, 6)

    // 'all' takes the undersides and the walls too, so the fitted plane is no longer the
    // seating surface — which is exactly why 'upward' is the default.
    const all = rationalise([node(out)], 'Seats', opts({ faces: 'all', gapMetres: 0.6 }))
    expect(all.outlines[0].basis.origin.z).toBeLessThan(0.4)
  })

  it('captures nothing from a wall, and says so rather than inventing a plane', () => {
    // A single vertical quad. Upward capture must come back empty with an explanation.
    const wall = [0, 0, 0, 5, 0, 0, 5, 0, 3, 0, 0, 0, 5, 0, 3, 0, 0, 3]
    const r = rationalise([node(wall)], 'Wall', opts({ faces: 'upward' }))

    expect(r.outlines).toHaveLength(0)
    expect(r.warnings.join(' ')).toMatch(/nothing captured/)
    expect(r.warnings.join(' ')).toMatch(/all faces/)
  })
})

describe('outline modes', () => {
  it('concave keeps a horseshoe open where hull fills it in', () => {
    // Seats round three sides of a void — a balcony wrapping a stage. The convex hull
    // swallows the stage; the alpha shape must not.
    const out: number[] = []
    for (let r = 0; r < 12; r++) {
      for (let c = 0; c < 12; c++) {
        const inner = r >= 3 && r <= 8 && c >= 3 && c <= 8
        if (!inner) pan(r * 0.5, c * 0.5, 0.4, 0, out)
      }
    }
    const n = node(out)
    const concave = rationalise([n], 'Balcony', opts({ mode: 'concave', gapMetres: 0.6 }))
    const hull = rationalise([n], 'Balcony', opts({ mode: 'hull' }))

    expect(concave.stats.areaEmitted).toBeLessThan(hull.stats.areaEmitted * 0.85)
    // The void comes back as a hole in the outer ring, recovered by boundaryLoops.
    expect(concave.outlines[0].holes.length).toBeGreaterThan(0)
    expect(hull.outlines[0].holes).toHaveLength(0)
  })

  it('rect gives one four-cornered ring', () => {
    const r = rationalise([node(block(8, 8, 0.5, 0.4, 0))], 'Positioning', opts({ mode: 'rect' }))
    expect(r.outlines).toHaveLength(1)
    expect(r.outlines[0].outer).toHaveLength(4)
  })

  it('footprint takes the drawn shape and the model only supplies the height', () => {
    // Pans at z = 2.4 under a triangle the user drew. The outline must be that triangle,
    // and it must land on the fitted plane.
    const r = rationalise(
      [node(block(10, 10, 0.5, 0.4, 2.4))],
      'Drawn',
      opts({
        mode: 'footprint',
        footprint: [
          [0, 0],
          [4, 0],
          [0, 4],
        ],
      }),
    )

    expect(r.outlines).toHaveLength(1)
    expect(r.outlines[0].outer).toHaveLength(3)
    expect(areaOf(r.outlines[0].outer)).toBeCloseTo(8, 3)
    expect(r.outlines[0].basis.origin.z).toBeCloseTo(2.4, 6)
  })

  it('a drawn footprint CLIPS the capture in every mode', () => {
    // The DXF case: every seat in the house is in one layer node, so the tree cannot
    // separate the stalls from the balcony and the drawn area is the only way in.
    const stalls = block(6, 6, 0.5, 0.4, 0)
    const balcony = block(6, 6, 0.5, 0.4, 4, 20, 0)
    const both = node([...stalls, ...balcony])

    const all = rationalise([both], 'All', opts({ gapMetres: 0.9 }))
    expect(all.stats.componentsOut).toBe(2)

    const clipped = rationalise(
      [both],
      'Stalls',
      opts({
        gapMetres: 0.9,
        footprint: [
          [-1, -1],
          [5, -1],
          [5, 5],
          [-1, 5],
        ],
      }),
    )
    expect(clipped.stats.componentsOut).toBe(1)
    expect(clipped.stats.trianglesKept).toBe(72)
    expect(clipped.outlines[0].basis.origin.z).toBeCloseTo(0, 6)
  })
})

describe('the parts, on their own', () => {
  it('smallestEigenvector finds the thin direction of a flat slab', () => {
    // Spread 100 in x and y, 1 in z: the normal is z, and it is returned pointing up.
    const n = smallestEigenvector([
      [100, 0, 0],
      [0, 100, 0],
      [0, 0, 1],
    ])
    expect(Math.abs(n.z)).toBeCloseTo(1, 9)
    expect(n.z).toBeGreaterThan(0)
  })

  it('fitPlane recovers a known tilt exactly', () => {
    // Points exactly on z = 0.2x + 0.1y + 1. Residual must be zero, not merely small.
    const samples = []
    for (let x = 0; x < 4; x++) {
      for (let y = 0; y < 4; y++) {
        const at = (px: number, py: number) => ({ x: px, y: py, z: 0.2 * px + 0.1 * py + 1 })
        samples.push({ a: at(x, y), b: at(x + 1, y), c: at(x, y + 1), area: 0.5 })
      }
    }
    const fit = fitPlane(samples)
    expect(fit.maxResidual).toBeLessThan(1e-9)
    expect(fit.normal.x / fit.normal.z).toBeCloseTo(-0.2, 9)
    expect(fit.normal.y / fit.normal.z).toBeCloseTo(-0.1, 9)
  })

  it('fitPlane does not care which way the exporter split the quads', () => {
    // The same surface, meshed both ways. Accumulating triangle CORNERS would weight the
    // shared diagonal's two vertices twice and tilt the answer, so the same room out of
    // two CAD packages would fit two different planes. Integrating over the triangles
    // cannot do that, and this is the test that says so.
    const at = (x: number, y: number) => ({ x, y, z: 0.2 * x + 0.1 * y + 1 })
    const forward = []
    const backward = []
    for (let x = 0; x < 6; x++) {
      for (let y = 0; y < 6; y++) {
        forward.push(
          { a: at(x, y), b: at(x + 1, y), c: at(x + 1, y + 1), area: 0.5 },
          { a: at(x, y), b: at(x + 1, y + 1), c: at(x, y + 1), area: 0.5 },
        )
        backward.push(
          { a: at(x, y), b: at(x + 1, y), c: at(x, y + 1), area: 0.5 },
          { a: at(x + 1, y), b: at(x + 1, y + 1), c: at(x, y + 1), area: 0.5 },
        )
      }
    }
    const f = fitPlane(forward)
    const b = fitPlane(backward)
    expect(f.normal.x).toBeCloseTo(b.normal.x, 12)
    expect(f.normal.y).toBeCloseTo(b.normal.y, 12)
    expect(f.normal.z).toBeCloseTo(b.normal.z, 12)
  })

  it('alphaComponents splits on the gap and not on the point count', () => {
    const pts: [number, number][] = []
    for (let i = 0; i < 5; i++) for (let j = 0; j < 5; j++) pts.push([i, j])
    for (let i = 0; i < 5; i++) for (let j = 0; j < 5; j++) pts.push([i + 20, j])

    expect(alphaComponents(pts, 1.5)).toHaveLength(2)
    expect(alphaComponents(pts, 30)).toHaveLength(1)
  })
})

describe('degenerate input must not throw or hang', () => {
  it('survives an empty selection', () => {
    const r = rationalise([], 'Nothing', opts())
    expect(r.outlines).toHaveLength(0)
    expect(r.warnings.length).toBeGreaterThan(0)
  })

  it('survives a node with no geometry', () => {
    expect(() => rationalise([node([])], 'Empty', opts())).not.toThrow()
  })

  it('survives collinear points', () => {
    const out: number[] = []
    for (let i = 0; i < 10; i++) out.push(i, 0, 0, i + 0.5, 0, 0, i + 1, 0, 0)
    const r = rationalise([node(out)], 'Line', opts())
    expect(r.outlines).toHaveLength(0)
  })

  it('drops an area under the minimum rather than emitting a sliver', () => {
    const r = rationalise([node(block(1, 1, 0.5, 0.1, 0))], 'Speck', opts({ minArea: 0.5 }))
    expect(r.outlines).toHaveLength(0)
    expect(r.warnings.join(' ')).toMatch(/smaller than/)
  })
})
