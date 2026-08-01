/**
 * The ArrayCalc round trip, frozen as a regression test.
 *
 * Two diagnostic venues were written by this project, opened in ArrayCalc 12.8.2, saved
 * and exported. Both the sent and returned files are in test/fixtures. ArrayCalc returned
 * every single object unchanged.
 *
 * That is the strongest evidence this project has that its output is correct, and it is
 * not repeatable on demand — it needs a human with ArrayCalc. So it is pinned here. If a
 * change to the writer makes our output stop matching what ArrayCalc handed back, this
 * fails, and the answer is almost certainly that the change is wrong.
 *
 * The history is worth knowing: the FIRST round trip failed. Every quad had been written
 * with a centroid origin and ArrayCalc silently collapsed each one to zero depth. See
 * quad.ts.
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { parseDbacv } from './read.ts'
import { type RoomObject, type Vec3, Shape } from './types.ts'

const parser = new (new JSDOM().window.DOMParser)()
const read = (name: string) =>
  parseDbacv(readFileSync(new URL(`../../../test/fixtures/${name}`, import.meta.url), 'utf8'), parser)

function flatten(objects: RoomObject[], out: RoomObject[] = []): RoomObject[] {
  for (const o of objects) {
    out.push(o)
    flatten(o.children, out)
  }
  return out
}

/** World positions, applying the Z rotation. */
function world(o: RoomObject): Vec3[] {
  const r = (o.rotation.z * Math.PI) / 180
  const c = Math.cos(r)
  const s = Math.sin(r)
  return o.points.map((p) => ({
    x: p.x * c - p.y * s + o.origin.x,
    y: p.x * s + p.y * c + o.origin.y,
    z: p.z + o.origin.z,
  }))
}

describe.each([
  ['A', 'probe-A-sent.dbacv', 'arraycalc-roundtrip-A.dbacv'],
  ['B', 'probe-B-sent.dbacv', 'arraycalc-roundtrip-B.dbacv'],
])('probe %s survived ArrayCalc untouched', (_label, sentFile, backFile) => {
  const sent = read(sentFile)
  const back = read(backFile)
  const S = new Map(flatten(sent.objects).map((o) => [o.name, o]))
  const B = new Map(flatten(back.objects).map((o) => [o.name, o]))

  it('kept every object', () => {
    expect([...B.keys()].sort()).toEqual([...S.keys()].sort())
  })

  it('moved no geometry', () => {
    for (const [name, o] of S) {
      const b = B.get(name)!
      const a = world(o)
      const c = world(b)
      expect(c, `"${name}" point count`).toHaveLength(a.length)
      for (let i = 0; i < a.length; i++) {
        expect(Math.abs(a[i].x - c[i].x), `"${name}" P${i + 1}.x`).toBeLessThan(1e-6)
        expect(Math.abs(a[i].y - c[i].y), `"${name}" P${i + 1}.y`).toBeLessThan(1e-6)
        expect(Math.abs(a[i].z - c[i].z), `"${name}" P${i + 1}.z`).toBeLessThan(1e-6)
      }
    }
  })

  it('kept every shape', () => {
    for (const [name, o] of S) expect(B.get(name)!.shape, name).toBe(o.shape)
  })

  it('kept every group transform', () => {
    for (const [name, o] of S) {
      if (o.shape !== Shape.Group) continue
      const b = B.get(name)!
      expect(b.origin, `"${name}" origin`).toEqual(o.origin)
      expect(b.rotation, `"${name}" rotation`).toEqual(o.rotation)
      expect(b.scaling, `"${name}" scaling`).toEqual(o.scaling)
      expect(b.children.length, `"${name}" child count`).toBe(o.children.length)
    }
  })

  it('never writes a negative zero, and neither do we', () => {
    const raw = readFileSync(new URL(`../../../test/fixtures/${backFile}`, import.meta.url), 'utf8')
    const ours = readFileSync(new URL(`../../../test/fixtures/${sentFile}`, import.meta.url), 'utf8')
    expect(raw).not.toContain('="-0"')
    expect(ours).not.toContain('="-0"')
  })
})

describe('what the round trip settled about ArrayCalc', () => {
  const sentA = read('probe-A-sent.dbacv')
  const backA = read('arraycalc-roundtrip-A.dbacv')
  const backB = read('arraycalc-roundtrip-B.dbacv')
  const byName = (v: ReturnType<typeof read>) => new Map(flatten(v.objects).map((o) => [o.name, o]))

  it('keeps a custom ListenerHeight on PlaneType 1', () => {
    const a = byName(backA)
    const o = [...a.values()].find((x) => x.name.startsWith('A20'))!
    expect(o.planeType).toBe(1)
    expect(o.listenerHeight).toBeCloseTo(0.77, 10)
  })

  it('silently RESETS ListenerHeight on PlaneType 2', () => {
    const sent = [...byName(sentA).values()].find((x) => x.name.startsWith('A21'))!
    const got = [...byName(backA).values()].find((x) => x.name.startsWith('A21'))!
    expect(sent.listenerHeight).toBeCloseTo(1.55, 10)
    expect(got.planeType).toBe(2)
    expect(got.listenerHeight).toBe(0.01)
  })

  it('coerces PlaneType 0 to 1 on a real object', () => {
    const got = [...byName(backB).values()].find((x) => x.name.startsWith('B01'))!
    expect(got.planeType).toBe(1)
  })

  it('accepts PlaneType 3, which appears in no sample venue', () => {
    const got = [...byName(backB).values()].find((x) => x.name.startsWith('B02'))!
    expect(got.planeType).toBe(3)
    expect(got.points).toHaveLength(4)
  })

  it('preserves a quad rotated about X, which no sample venue contains', () => {
    // Untested visually: ArrayCalc kept the attribute, but whether it APPLIES the tilt
    // when drawing is unconfirmed. Until it is, canonicalQuad refuses to use X rotation
    // and splits a sideways-tilted plane into two triangles instead.
    const got = [...byName(backB).values()].find((x) => x.name.startsWith('B40'))!
    expect(got.rotation.x).toBeCloseTo(30)
  })

  it('leaves every one of our canonical quads alone', () => {
    for (const o of flatten(backA.objects).concat(flatten(backB.objects))) {
      if (o.shape !== Shape.Quad) continue
      expect(Math.abs(o.points[0].x), `"${o.name}" P1.x`).toBeLessThan(1e-9)
      expect(Math.abs(o.points[3].x), `"${o.name}" P4.x`).toBeLessThan(1e-9)
      expect(Math.abs(o.points[1].x - o.points[2].x), `"${o.name}" depth`).toBeLessThan(1e-9)
      expect(o.points[0].y, `"${o.name}" P1 on +y`).toBeGreaterThan(0)
    }
  })
})
