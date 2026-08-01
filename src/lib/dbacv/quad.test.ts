import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { canonicalQuad, quadToTriangles } from './quad.ts'
import { parseDbacv } from './read.ts'
import { type Vec3, Shape } from './types.ts'

const parser = new (new JSDOM().window.DOMParser)()

const v = (x: number, y: number, z = 0): Vec3 => ({ x, y, z })

/** Where a canonical quad's points actually land, applying its Z rotation. */
function world(q: { origin: Vec3; rotationZ: number; points: Vec3[] }): Vec3[] {
  const r = (q.rotationZ * Math.PI) / 180
  const c = Math.cos(r)
  const s = Math.sin(r)
  return q.points.map((p) => ({
    x: p.x * c - p.y * s + q.origin.x,
    y: p.x * s + p.y * c + q.origin.y,
    z: p.z + q.origin.z,
  }))
}

function sameSet(a: Vec3[], b: Vec3[], tol = 1e-6): boolean {
  if (a.length !== b.length) return false
  const rest = [...b]
  for (const p of a) {
    const i = rest.findIndex(
      (q) => Math.abs(p.x - q.x) < tol && Math.abs(p.y - q.y) < tol && Math.abs(p.z - q.z) < tol,
    )
    if (i === -1) return false
    rest.splice(i, 1)
  }
  return true
}

describe('canonicalQuad — the shape ArrayCalc actually accepts', () => {
  it('emits the near edge at local x=0, which is the whole point', () => {
    const q = canonicalQuad([v(0, 16), v(4, 16), v(4, 19), v(0, 19)])!
    expect(q).not.toBeNull()
    // This is the invariant ArrayCalc enforces. Writing the centroid here instead makes
    // ArrayCalc silently collapse the plane to zero depth.
    expect(q.points[0].x).toBe(0)
    expect(q.points[3].x).toBe(0)
    expect(q.points[1].x).toBeCloseTo(q.points[2].x)
    expect(q.points[1].x).toBeGreaterThan(0)
  })

  it('keeps the quad exactly where it was', () => {
    const src = [v(0, 16), v(4, 16), v(4, 19), v(0, 19)]
    expect(sameSet(world(canonicalQuad(src)!), src)).toBe(true)
  })

  it('is symmetric about the local X axis, both edges', () => {
    const q = canonicalQuad([v(0, 16), v(4, 16), v(4, 19), v(0, 19)])!
    expect(q.points[0].y).toBeCloseTo(-q.points[3].y)
    expect(q.points[1].y).toBeCloseTo(-q.points[2].y)
    expect(q.points[0].y).toBeGreaterThan(0)
  })

  it('accepts any winding and any starting corner', () => {
    const corners = [v(0, 16), v(4, 16), v(4, 19), v(0, 19)]
    for (let r = 0; r < 4; r++) {
      const rotated = [...corners.slice(r), ...corners.slice(0, r)]
      for (const ring of [rotated, [...rotated].reverse()]) {
        const q = canonicalQuad(ring)
        expect(q).not.toBeNull()
        expect(sameSet(world(q!), corners)).toBe(true)
      }
    }
  })

  it('handles a rotated rectangle by putting the angle in rotationZ', () => {
    const a = Math.PI / 6
    const src = [v(0, 0), v(4, 0), v(4, 3), v(0, 3)].map((p) =>
      v(p.x * Math.cos(a) - p.y * Math.sin(a), p.x * Math.sin(a) + p.y * Math.cos(a)),
    )
    const q = canonicalQuad(src)!
    expect(q).not.toBeNull()
    expect(sameSet(world(q), src)).toBe(true)
  })

  it('expresses a rake as a height on the far edge', () => {
    // Near edge level at z=0, far edge level at z=0.6 — how seating rakes.
    const src = [v(0, 16, 0), v(4, 16, 0.6), v(4, 19, 0.6), v(0, 19, 0)]
    const q = canonicalQuad(src)!
    expect(q).not.toBeNull()
    expect(q.points[0].z).toBe(0)
    expect(q.points[3].z).toBe(0)
    expect(q.points[1].z).toBeCloseTo(0.6)
    expect(q.points[2].z).toBeCloseTo(0.6)
    expect(sameSet(world(q), src)).toBe(true)
  })

  it('accepts a symmetric trapezoid, which the reference venue contains', () => {
    const src = [v(0, -5.065), v(1.5, -4.877), v(1.5, 4.877), v(0, 5.065)]
    const q = canonicalQuad(src)!
    expect(q).not.toBeNull()
    expect(sameSet(world(q), src)).toBe(true)
  })

  it('REJECTS a sheared parallelogram', () => {
    expect(canonicalQuad([v(0, 0), v(4, 0), v(5, 3), v(1, 3)])).toBeNull()
  })

  it('REJECTS an asymmetric trapezoid', () => {
    expect(canonicalQuad([v(0, 0), v(4, 0), v(4, 3), v(0, 1)])).toBeNull()
  })

  it('REJECTS a quad with no level edge at all', () => {
    expect(canonicalQuad([v(0, 0, 0), v(4, 0, 0.3), v(4, 3, 0.9), v(0, 3, 0.4)])).toBeNull()
  })

  it('REJECTS a quad with no area', () => {
    expect(canonicalQuad([v(0, 16), v(0, 16), v(0, 19), v(0, 19)])).toBeNull()
  })

  it('accepts a VERTICAL plane as depth 0 with a rise', () => {
    // This is how the reference venue stores every rail front, and rejecting it was a
    // real bug: it cost two triangles for every wall.
    const src = [v(0, 5, 0), v(0, 5, -0.83), v(0, -5, -0.83), v(0, -5, 0)]
    const q = canonicalQuad(src)!
    expect(q).not.toBeNull()
    expect(Math.abs(q.points[1].x)).toBeLessThan(1e-9)
    expect(Math.abs(q.points[1].z)).toBeCloseTo(0.83)
    expect(sameSet(world(q), src)).toBe(true)
  })

  it('accepts all four walls of a box', () => {
    const walls = [
      [v(0, 0, 0), v(4, 0, 0), v(4, 0, 2), v(0, 0, 2)],
      [v(4, 0, 0), v(4, 3, 0), v(4, 3, 2), v(4, 0, 2)],
      [v(4, 3, 0), v(0, 3, 0), v(0, 3, 2), v(4, 3, 2)],
      [v(0, 3, 0), v(0, 0, 0), v(0, 0, 2), v(0, 3, 2)],
    ]
    for (const w of walls) {
      const q = canonicalQuad(w)
      expect(q, `wall ${JSON.stringify(w)}`).not.toBeNull()
      expect(sameSet(world(q!), w)).toBe(true)
    }
  })

  it('falls back to two triangles that cover the original quad', () => {
    const src = [v(0, 0), v(4, 0), v(5, 3), v(1, 3)]
    expect(canonicalQuad(src)).toBeNull()
    const [a, b] = quadToTriangles(src)
    expect(a).toHaveLength(3)
    expect(b).toHaveLength(3)
    const covered = new Set([...a, ...b].map((p) => `${p.x},${p.y},${p.z}`))
    for (const p of src) expect(covered.has(`${p.x},${p.y},${p.z}`)).toBe(true)
  })
})

describe('every quad in the reference venue is already canonical', () => {
  // If ArrayCalc's own output does not satisfy this, the rule is wrong.
  const xml = readFileSync(new URL('../../../test/fixtures/theatre.dbacv', import.meta.url), 'utf8')
  const venue = parseDbacv(xml, parser)

  const quads: { name: string; points: Vec3[] }[] = []
  const walk = (os: typeof venue.objects) => {
    for (const o of os) {
      if (o.shape === Shape.Quad) quads.push({ name: o.name, points: o.points })
      walk(o.children)
    }
  }
  walk(venue.objects)

  it('has 26 of them', () => expect(quads).toHaveLength(26))

  it('all put the near edge at local x = 0', () => {
    for (const q of quads) {
      expect(Math.abs(q.points[0].x)).toBeLessThan(1e-9)
      expect(Math.abs(q.points[3].x)).toBeLessThan(1e-9)
    }
  })

  it('all put the far edge at a single depth', () => {
    for (const q of quads) expect(Math.abs(q.points[1].x - q.points[2].x)).toBeLessThan(1e-9)
  })

  it('all are symmetric about the local X axis', () => {
    for (const q of quads) {
      expect(Math.abs(q.points[0].y + q.points[3].y)).toBeLessThan(1e-9)
      expect(Math.abs(q.points[1].y + q.points[2].y)).toBeLessThan(1e-9)
    }
  })

  it('all have level near and far edges', () => {
    for (const q of quads) {
      expect(Math.abs(q.points[0].z - q.points[3].z)).toBeLessThan(1e-9)
      expect(Math.abs(q.points[1].z - q.points[2].z)).toBeLessThan(1e-9)
    }
  })

  it('six of them are vertical planes stored as depth 0 with a rise', () => {
    const vertical = quads.filter((q) => Math.abs(q.points[1].x) < 1e-9)
    expect(vertical).toHaveLength(6)
    for (const q of vertical) expect(Math.abs(q.points[1].z)).toBeGreaterThan(0.1)
  })

  /**
   * The strongest available check: take each quad's own world points, feed them back
   * through canonicalQuad, and require the SAME encoding ArrayCalc wrote. If this
   * passes on all 26, the rule is not a guess.
   */
  it('re-derives ArrayCalc’s own encoding for every one of them', () => {
    const objs: typeof venue.objects = []
    const collect = (os: typeof venue.objects) => {
      for (const o of os) {
        if (o.shape === Shape.Quad) objs.push(o)
        collect(o.children)
      }
    }
    collect(venue.objects)

    for (const o of objs) {
      const r = (o.rotation.z * Math.PI) / 180
      const c = Math.cos(r)
      const s = Math.sin(r)
      const worldPts = o.points.map((p) => ({
        x: p.x * c - p.y * s + o.origin.x,
        y: p.x * s + p.y * c + o.origin.y,
        z: p.z + o.origin.z,
      }))

      const q = canonicalQuad(worldPts)
      expect(q, `no canonical form found for "${o.name}"`).not.toBeNull()
      // Same geometry, and same local encoding.
      expect(sameSet(world(q!), worldPts), `"${o.name}" moved`).toBe(true)
      expect(Math.abs(q!.points[1].x - o.points[1].x), `"${o.name}" depth`).toBeLessThan(1e-6)
      expect(Math.abs(q!.points[0].y - o.points[0].y), `"${o.name}" near width`).toBeLessThan(1e-6)
      expect(Math.abs(q!.points[1].y - o.points[1].y), `"${o.name}" far width`).toBeLessThan(1e-6)
      expect(Math.abs(q!.points[1].z - o.points[1].z), `"${o.name}" rise`).toBeLessThan(1e-6)
    }
  })
})
