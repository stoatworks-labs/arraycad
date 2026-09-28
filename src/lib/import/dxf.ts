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
import { checkCommonEntityProperties } from 'dxf-parser/dist/ParseHelpers.js'
import { type ImportedScene, ImportError } from './types.ts'
import { type CadDocument, type CadOptions, buildNodes, noSurfacesError } from './entities.ts'
import { satPoints } from './acis.ts'

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

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * 3DSOLID, which dxf-parser has no handler for and drops without a word.
 *
 * In a venue drawing these are the truss — the one thing the speakers are flown from — so
 * dropping them is not a loss of detail but of the rig. The body is ACIS SAT text, one line
 * per group code 1, continued by group code 3 when a line runs past 255 characters. It is
 * reduced to a point cloud here (see `acis.ts`); `entities.ts` turns that into a hull.
 */
class Solid3dHandler {
  ForEntityName = '3DSOLID'
  parseEntity(scanner: any, curr: any) {
    const entity: any = { type: curr.value, sat: [] as string[] }
    curr = scanner.next()
    while (!scanner.isEOF() && curr.code !== 0) {
      if (curr.code === 1) entity.sat.push(String(curr.value))
      else if (curr.code === 3 && entity.sat.length > 0) entity.sat[entity.sat.length - 1] += String(curr.value)
      else checkCommonEntityProperties(entity, curr, scanner)
      curr = scanner.next()
    }
    entity.points = satPoints(entity.sat)
    delete entity.sat
    return entity
  }
}

export function importDxf(
  text: string,
  filename: string,
  options: Partial<DxfOptions> = {},
): ImportedScene {
  let dxf: any
  try {
    const parser = new DxfParser()
    parser.registerEntityHandler(Solid3dHandler as any)
    dxf = parser.parseSync(text)
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
