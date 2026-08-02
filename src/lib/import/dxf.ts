/**
 * DXF importer.
 *
 * DXF is what a venue actually hands you: an entity list written out as tagged text, and
 * usually a 2D plan with no z in it at all. This file is only the translation from
 * dxf-parser's shape into `CadDocument` — every piece of geometry work, including the
 * segment chaining that makes a plan drawing importable at all, lives in `entities.ts`
 * and is shared with the DWG importer.
 *
 * Field names below are taken from dxf-parser's own entity handlers, not from the DXF
 * spec — the two disagree in places and the parser is what we are actually reading. Where
 * they disagree in a way that changes geometry, `entities.ts` says so at the point of use.
 */

import DxfParser from 'dxf-parser'
import { type ImportedScene, ImportError } from './types.ts'
import { type CadDocument, type CadOptions, buildNodes, noSurfacesError } from './entities.ts'

export type DxfOptions = CadOptions
export { DEFAULT_CAD_OPTIONS as DEFAULT_DXF_OPTIONS } from './entities.ts'

/**
 * DXF $INSUNITS code -> metres per unit.
 *
 * Code 0 is "unitless" and is by far the most common value in drawings that arrive from
 * the trade. It tells us nothing, so it maps to undefined and the user picks.
 */
export const INSUNITS: Record<number, number | undefined> = {
  0: undefined,
  1: 0.0254, // inches
  2: 0.3048, // feet
  3: 1609.344, // miles
  4: 0.001, // millimetres
  5: 0.01, // centimetres
  6: 1, // metres
  7: 1000, // kilometres
  8: 2.54e-8, // microinches
  9: 2.54e-5, // mils
  10: 0.9144, // yards
  11: 1e-10, // angstroms
  12: 1e-9, // nanometres
  13: 1e-6, // microns
  14: 0.1, // decimetres
  15: 10, // decametres
  16: 100, // hectometres
}

export function importDxf(
  text: string,
  filename: string,
  options: Partial<DxfOptions> = {},
): ImportedScene {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let dxf: any
  try {
    dxf = new DxfParser().parseSync(text)
  } catch (e) {
    throw new ImportError(
      `Could not parse this DXF: ${(e as Error).message}`,
      'Save it as ASCII DXF (R2013 or earlier is safest). Binary DXF cannot be read here — ' +
        'from AutoCAD use SAVEAS and pick a DXF format.',
    )
  }
  if (!dxf?.entities) throw new ImportError('That DXF has no ENTITIES section.')

  const warn = new Set<string>()
  const doc: CadDocument = { entities: dxf.entities, blocks: dxf.blocks ?? {} }
  const nodes = buildNodes(doc, options, warn)
  if (nodes.length === 0) throw noSurfacesError('DXF')

  const insunits = dxf.header?.$INSUNITS
  const unitsPerMetre = typeof insunits === 'number' ? INSUNITS[insunits] : undefined
  if (unitsPerMetre === undefined) {
    warn.add('This DXF does not declare its units ($INSUNITS is 0 or absent). Set them yourself.')
  }

  return {
    format: 'DXF',
    sourceName: filename.replace(/\.[^.]+$/, ''),
    unitsPerMetre,
    // DXF world coordinates are Z-up; nothing in the header says otherwise.
    upAxis: 'z',
    nodes,
    warnings: [...warn],
  }
}
