import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { parseDbacv } from './read.ts'
import { g17, writeDbacv } from './write.ts'
import { PlaneType, Shape, argbToCss, cssToArgb } from './types.ts'

// Vitest runs in node here, so supply the browser's DOMParser explicitly.
const parser = new (new JSDOM().window.DOMParser)()
const FIXTURE = new URL('../../../test/fixtures/theatre.dbacv', import.meta.url)
const xml = readFileSync(FIXTURE, 'utf8')

describe('g17 — printf("%.17g") equivalence', () => {
  // Every one of these is lifted verbatim from the ArrayCalc fixture. If g17 reproduces
  // them we are formatting numbers the way ArrayCalc does.
  const cases: [number, string][] = [
    [0, '0'],
    [1, '1'],
    [7, '7'],
    [1.2, '1.2'],
    [1.7, '1.7'],
    [0.01, '0.01'],
    [13.06, '13.06'],
    [5.405, '5.4050000000000002'],
    [3.2, '3.2000000000000002'],
    [9.6, '9.5999999999999996'],
    [0.4, '0.40000000000000002'],
    [-72.7, '-72.700000000000003'],
    [2.160000000000001, '2.160000000000001'],
    [1.4115441436226934, '1.4115441436226934'],
    [12.978861061695445, '12.978861061695445'],
    [351.66496511560081, '351.66496511560081'],
    [0.027708879191155944, '0.027708879191155944'],
    [0.60000000000000053, '0.60000000000000053'],
    [-8.8817841970012523e-16, '-8.8817841970012523e-16'],
    // The decade-boundary trap. This double is just under 0.1, so the exponent that
    // decides the fixed-notation digit count must be taken AFTER rounding to 17
    // significant digits (-2), not from a low-precision probe that rounds it up to
    // 1.0e-01 (-1). Getting it wrong costs one fraction digit and yields
    // 0.09999999999999998. The Python port in vectorworks/ had exactly this bug.
    [0.099999999999999978, '0.099999999999999978'],
    // Negative zero prints as "0". Strict %.17g would say "-0", but no ArrayCalc export
    // has ever contained one and our canonical-quad atan2 produces them freely.
    [-0, '0'],
  ]
  for (const [v, want] of cases) {
    it(`${want}`, () => expect(g17(v)).toBe(want))
  }

  it('every finite double it prints parses back to itself', () => {
    for (let i = 0; i < 5000; i++) {
      const v = (Math.random() - 0.5) * 10 ** (Math.floor(Math.random() * 20) - 10)
      expect(Number(g17(v))).toBe(v)
    }
  })
})

describe('parse', () => {
  const venue = parseDbacv(xml, parser)

  it('reads the project header', () => {
    expect(venue.appVersion).toBe('12.8.2')
    expect(venue.venueVersion).toBe('9')
    expect(venue.projectName).toBe('Untitled')
    expect(venue.date).toBe('01.08.2026')
    expect(venue.author).toBe('allansargeant')
  })

  it('finds 112 room objects across the whole tree', () => {
    let n = 0
    const walk = (os: typeof venue.objects) => {
      for (const o of os) {
        n++
        walk(o.children)
      }
    }
    walk(venue.objects)
    expect(n).toBe(112)
  })

  it('nests group children rather than flattening them', () => {
    const groups = venue.objects.filter((o) => o.shape === Shape.Group)
    expect(groups).toHaveLength(12)
    expect(groups.every((g) => g.children.length > 0)).toBe(true)
    // 12 top-level non-group objects + 12 groups... in fact 5 loose objects and 12 groups.
    expect(venue.objects.filter((o) => o.shape !== Shape.Group)).toHaveLength(5)
  })

  it('reads a quad', () => {
    const ss = venue.objects[0]
    expect(ss.name).toBe('SOUNDSCAPE')
    expect(ss.shape).toBe(Shape.Quad)
    expect(ss.planeType).toBe(PlaneType.PositioningArea)
    expect(ss.points).toHaveLength(4)
    expect(ss.origin).toEqual({ x: -9.6, y: 0, z: 1.6 })
    expect(ss.points[1]).toEqual({ x: 9.6, y: 5.405, z: 0 })
  })

  it('reads a box as 8 points', () => {
    const bridge = venue.objects.find((o) => o.name === 'BRIDGE 1')!
    expect(bridge.shape).toBe(Shape.Box)
    expect(bridge.points).toHaveLength(8)
    expect(bridge.points[4].z).toBeCloseTo(2.16)
  })

  it('reads an arc segment from attributes, with no points', () => {
    const tier = venue.objects
      .flatMap((o) => o.children)
      .find((o) => o.name === 'TIER 3 - LEFT 4')!
    expect(tier.shape).toBe(Shape.Arc)
    expect(tier.points).toHaveLength(0)
    expect(tier.arc).toBeDefined()
    expect(tier.arc!.innerRadiusA).toBeCloseTo(12.978861061695445)
    expect(tier.arc!.spanAngle).toBeCloseTo(12.645475559470924)
    expect(tier.rotation.z).toBeCloseTo(-72.7)
  })

  it('reads a triangle', () => {
    const tri = venue.objects.flatMap((o) => o.children).find((o) => o.name === 'TIER 3 - LEFT 2')!
    expect(tri.shape).toBe(Shape.Triangle)
    expect(tri.points).toHaveLength(3)
  })

  it('keeps a non-numeric ListenerHeight verbatim instead of writing NaN into the model', () => {
    const g = venue.objects.find((o) => o.listenerHeightRaw !== undefined)!
    expect(g.listenerHeightRaw).toBe('nan')
    expect(Number.isFinite(g.listenerHeight)).toBe(true)
  })
})

describe('round trip', () => {
  it('re-emits the fixture byte for byte', () => {
    const out = writeDbacv(parseDbacv(xml, parser))
    // Narrow the failure before dumping 75 kB of diff.
    const a = xml.split('\n')
    const b = out.split('\n')
    expect(b.length).toBe(a.length)
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) throw new Error(`line ${i + 1}\n  want: ${a[i]}\n  got:  ${b[i]}`)
    }
    expect(out).toBe(xml)
  })

  it('survives a second trip', () => {
    const once = writeDbacv(parseDbacv(xml, parser))
    const twice = writeDbacv(parseDbacv(once, parser))
    expect(twice).toBe(once)
  })

  it('renumbers ParentVenueObjectId when an object is pruned', () => {
    const venue = parseDbacv(xml, parser)
    // Drop the second top-level object (MIX POSITION, index 2). Everything after it
    // shifts down by one, so the parent ids of every group child must shift too.
    venue.objects.splice(1, 1)
    const out = writeDbacv(venue)
    const reparsed = parseDbacv(out, parser)

    const groupIdx = out.split('\n').findIndex((l) => l.includes('ObjectGroup="true"'))
    expect(groupIdx).toBeGreaterThan(-1)
    // The first group was document index 6; with one object removed it is now 5, and its
    // children must say ParentVenueObjectId="5".
    expect(out).toContain('ParentVenueObjectId="5"')
    expect(out).not.toContain('ParentVenueObjectId="6"')
    expect(reparsed.objects).toHaveLength(venue.objects.length)
  })
})

describe('colour packing', () => {
  it('round trips ARGB', () => {
    // 4278239406 == 0xFF00C0AE, the teal ArrayCalc gives the Soundscape plane.
    expect(argbToCss(4278239406)).toBe('#00c0ae')
    expect(cssToArgb('#00c0ae')).toBe(4278239406)
  })
  it('stays unsigned', () => {
    expect(cssToArgb('#ffffff')).toBe(4294967295)
    expect(cssToArgb('#ffffff')).toBeGreaterThan(0)
  })
})
