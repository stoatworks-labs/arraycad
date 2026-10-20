/**
 * Real venues' own published drawings, against what the venues publish about themselves.
 *
 * Every other test here runs on synthetic geometry whose answer is known by construction.
 * This one runs on the drawings theatres put up for visiting companies — AutoCAD 2000 to
 * 2018, with their stray entities, padded blocks and units that are sometimes wrong — and
 * checks each against the venue's own specification: a published dimension has to appear
 * as a drawn length at the drawing's scale.
 *
 * LOCAL ONLY. The drawings are not in the repository (none carries a licence to
 * redistribute it): `python3 scripts/fetch_real_venues.py` downloads them, and without
 * them every test here is skipped, which is what CI does. The list, the sources, the
 * checksums and the published figures are `test/real-venues/venues.json`.
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { importDwg } from './import/dwg.ts'
import { type ImportedScene, ImportError, flattenNodes } from './import/types.ts'
import { flatPlanReport } from './trace/cad.ts'
import { DEFAULT_PREPARE_SETTINGS, applyPlan, prepareScene, seedDecisions, settingsForScene } from '../state.ts'

interface Drawing {
  what: string
  unitsPerMetre: number
  dimensions?: { source: string; metres: number[]; within: number }
  seatsAgree?: boolean
  seatsSuggest?: number
  tooSmallAsStated?: { source: string; metres: number }
  slow?: boolean
}
interface Venue {
  id: string
  name: string
  files: { name: string; url: string; sha256: string }[]
  drawings: Record<string, Drawing>
}

const ROOT = process.env.ARRAYCAD_REAL_VENUES ?? join(homedir(), '.cache', 'arraycad-real-venues')
const manifest = JSON.parse(
  readFileSync(new URL('../../test/real-venues/venues.json', import.meta.url), 'utf8'),
) as { venues: Venue[] }

async function load(path: string, name: string): Promise<ImportedScene> {
  const bytes = readFileSync(path)
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  try {
    return await importDwg(buffer, name)
  } catch (e) {
    // A plan whose lines never close comes back for the tracer, not as a failure.
    if (e instanceof ImportError && e.traceable) return e.traceable
    throw e
  }
}

/** Every straight piece of line work, in metres at `perMetre`, sorted. */
function drawnLengths(scene: ImportedScene, perMetre: number): number[] {
  const out: number[] = []
  for (const l of scene.linework ?? []) {
    for (let p = 0; p + 1 < l.starts.length; p++) {
      const a = l.starts[p]
      const b = l.starts[p + 1]
      const piece = (i: number, j: number) =>
        Math.hypot(l.points[j * 3] - l.points[i * 3], l.points[j * 3 + 1] - l.points[i * 3 + 1]) * perMetre
      for (let i = a; i + 1 < b; i++) out.push(piece(i, i + 1))
      if (l.closed[p] && b - a > 2) out.push(piece(b - 1, a))
    }
  }
  return out.sort((x, y) => x - y)
}

const nearest = (sorted: number[], t: number) => {
  let lo = 0
  let hi = sorted.length - 1
  while (lo < hi) {
    const m = (lo + hi) >> 1
    if (sorted[m] < t) lo = m + 1
    else hi = m
  }
  return [sorted[lo], sorted[lo - 1]].filter((x) => x !== undefined).reduce((b, x) => (Math.abs(x - t) < Math.abs(b - t) ? x : b))
}

for (const venue of manifest.venues) {
  describe.skipIf(!existsSync(join(ROOT, venue.id)))(venue.name, () => {
    for (const [file, d] of Object.entries(venue.drawings)) {
      const path = join(ROOT, venue.id, file)
      describe.skipIf(!existsSync(path))(`${file}: ${d.what}`, () => {
        // Imported once per drawing and shared: the Grand Theater's seating plan alone is
        // 1.5 million paths and takes ten seconds to read.
        let scene: ImportedScene
        const scenePromise = existsSync(path) ? load(path, file) : null
        const ready = async () => (scene ??= await scenePromise!)
        const timeout = d.slow ? 180_000 : 60_000

        it('imports, at the units it states', async () => {
          const s = await ready()
          expect(s.unitsPerMetre).toBe(d.unitsPerMetre)
          expect(s.linework?.length ?? 0).toBeGreaterThan(0)
        }, timeout)

        it('is recognised as a flat plan, and not split as a model', async () => {
          const s = await ready()
          const settings = settingsForScene(s)
          if (s.nodes.length > 0) {
            const prepared = prepareScene(s, settings.transform, DEFAULT_PREPARE_SETTINGS)
            expect(prepared.split?.nodesSplit ?? 0).toBe(0)
            const decisions = applyPlan(seedDecisions(prepared.scene), prepared.plan)
            const included = new Set(Object.entries(decisions).filter(([, x]) => x.include).map(([id]) => id))
            const report = flatPlanReport(prepared.scene, settings.transform, {
              included,
              planExcluded: new Set(prepared.plan.exclude.keys()),
              dropClutter: true,
            })
            expect(report?.flat).toBe(true)
          } else {
            expect(flattenNodes(s.nodes)).toEqual([])
          }
        }, timeout)

        if (d.dimensions) {
          const dims = d.dimensions
          it(`draws the published dimensions at its scale (${dims.source})`, async () => {
            const lengths = drawnLengths(await ready(), d.unitsPerMetre)
            for (const m of dims.metres) {
              expect(Math.abs(nearest(lengths, m) - m) / m, `${m} m`).toBeLessThanOrEqual(dims.within)
            }
          }, timeout)
        }

        if (d.seatsAgree) {
          it('has seats that agree with its units', async () => {
            expect((await ready()).unitsDoubt).toBeUndefined()
          }, timeout)
        }

        if (d.seatsSuggest !== undefined) {
          const suggested = d.seatsSuggest
          it(`is doubted by its own seats, which say ${suggested} m per unit`, async () => {
            const doubt = (await ready()).unitsDoubt
            expect(doubt?.suggested).toBeCloseTo(suggested, 12)
            expect(doubt?.pitchM).toBeGreaterThan(0.42)
            expect(doubt?.pitchM).toBeLessThan(0.6)
          }, timeout)
        } else {
          it('raises no doubt about its units', async () => {
            expect((await ready()).unitsDoubt).toBeUndefined()
          }, timeout)
        }

        if (d.tooSmallAsStated) {
          const small = d.tooSmallAsStated
          it(`could not hold its published stage at the units it states (${small.source})`, async () => {
            const s = await ready()
            const longest = drawnLengths(s, d.unitsPerMetre).at(-1)!
            expect(longest).toBeLessThan(small.metres)
            // At the units its seats suggest, it can.
            expect(longest * ((d.seatsSuggest ?? d.unitsPerMetre) / d.unitsPerMetre)).toBeGreaterThan(small.metres)
          }, timeout)
        }
      })
    }
  })
}
