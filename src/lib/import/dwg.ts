/**
 * DWG importer.
 *
 * DWG is AutoCAD's native format: the same drawing model as DXF, written as a versioned
 * bitstream rather than tagged text. It has no public specification — everything known
 * about it is reverse-engineered — so this file does not attempt to parse it. `acad-ts`
 * does that, and this is only the translation from its object model into `CadDocument`.
 * All the geometry, including the segment chaining that makes a plan drawing usable, is
 * shared with the DXF importer in `entities.ts`.
 *
 * Why acad-ts and not libredwg: libredwg is the obvious choice and is GPL-3. Bundling it
 * into a browser app licensed MIT would relicense the whole app, and several npm packages
 * that wrap it in a WASM build declare themselves MIT anyway, which they cannot do.
 * acad-ts is a genuinely independent MIT implementation (a port of ACadSharp), is pure
 * TypeScript, and pulls in no WebAssembly — so unlike web-ifc it needs nothing added to
 * the CSP.
 *
 * WHERE acad-ts AND DXF DISAGREE, and both places change geometry:
 *   - angles are RADIANS here and degrees in DXF's INSERT rotation;
 *   - `Arc.sweep` is `start - end`, the negative of the DXF sweep.
 * Both are converted below. Everything else maps across one for one — verified by reading
 * the same drawing from both a .dwg and a .dxf and comparing the geometry.
 */

import { type ImportedScene, ImportError } from './types.ts'
import { type CadBlock, type CadDocument, type CadOptions, buildNodes, noSurfacesError } from './entities.ts'
import { INSUNITS } from './dxf.ts'

export type DwgOptions = CadOptions

/* eslint-disable @typescript-eslint/no-explicit-any */
type Obj = any

const DEG = 180 / Math.PI

const xyz = (p: Obj) => (p ? { x: p.x ?? 0, y: p.y ?? 0, z: p.z ?? 0 } : { x: 0, y: 0, z: 0 })

/**
 * A DXF-shaped entity, or null for anything with no geometry in it.
 *
 * Text, dimensions and attributes are dropped here rather than in `entities.ts` so that
 * the shared code never has to know which parser it is being fed by.
 */
function toCadEntity(e: Obj, layer: string): Obj | null {
  switch (e.constructor?.name) {
    case 'Line':
      return { type: 'LINE', layer, vertices: [xyz(e.startPoint), xyz(e.endPoint)] }

    case 'Arc': {
      // DXF arcs always sweep counter-clockwise from start to end. acad-ts exposes a
      // `sweep` getter that is start-minus-end — the negative — so it is not used; the
      // sweep is recomputed and normalised the same way the DXF importer does it.
      const start = e.startAngle ?? 0
      const end = e.endAngle ?? 0
      let angleLength = end - start
      if (angleLength <= 0) angleLength += Math.PI * 2
      return { type: 'ARC', layer, center: xyz(e.center), radius: e.radius ?? 0, startAngle: start, angleLength }
    }

    case 'Circle':
      return { type: 'CIRCLE', layer, center: xyz(e.center), radius: e.radius ?? 0 }

    case 'Ellipse':
      return {
        type: 'ELLIPSE',
        layer,
        center: xyz(e.center),
        majorAxisEndPoint: xyz(e.majorAxisEndPoint),
        axisRatio: e.radiusRatio ?? 1,
        startAngle: e.startParameter ?? 0,
        endAngle: e.endParameter ?? Math.PI * 2,
      }

    case 'Spline':
      return {
        type: 'SPLINE',
        layer,
        controlPoints: (e.controlPoints ?? []).map(xyz),
        fitPoints: (e.fitPoints ?? []).map(xyz),
        knotValues: e.knots ?? [],
        degreeOfSplineCurve: e.degree ?? 3,
        closed: Boolean(e.isClosed),
      }

    case 'LwPolyline':
      return {
        type: 'LWPOLYLINE',
        layer,
        elevation: e.elevation ?? 0,
        shape: Boolean(e.isClosed),
        vertices: (e.vertices ?? []).map((v: Obj) => ({
          x: v.location?.x ?? 0,
          y: v.location?.y ?? 0,
          bulge: v.bulge || undefined,
        })),
      }

    case 'Polyline':
    case 'Polyline2D':
    case 'Polyline3D':
      return {
        type: 'POLYLINE',
        layer,
        shape: Boolean(e.isClosed),
        vertices: [...(e.vertices ?? [])].map((v: Obj) => ({
          ...xyz(v.location ?? v),
          bulge: v.bulge || undefined,
        })),
      }

    case 'Face3D':
      return {
        type: '3DFACE',
        layer,
        vertices: [e.firstCorner, e.secondCorner, e.thirdCorner, e.fourthCorner].map(xyz),
      }

    case 'Solid':
      return {
        type: 'SOLID',
        layer,
        points: [e.firstCorner, e.secondCorner, e.thirdCorner, e.fourthCorner].map(xyz),
      }

    case 'PolyfaceMesh': {
      // Reduced to 3DFACEs on the way through: the shared code reads a polyface only in
      // dxf-parser's VERTEX-with-faceA form, which is a shape acad-ts has no reason to
      // imitate. The faces themselves carry the same four indices either way.
      const verts = [...(e.vertices ?? [])].map((v: Obj) => xyz(v.location ?? v))
      const faces = [...(e.faces ?? [])]
      return {
        type: 'POLYFACE',
        layer,
        faces: faces.map((f: Obj) =>
          [f.index1, f.index2, f.index3, f.index4]
            .filter((n: number) => typeof n === 'number' && n !== 0)
            .map((n: number) => verts[Math.abs(n) - 1])
            .filter(Boolean),
        ),
      }
    }

    case 'Insert':
      return {
        type: 'INSERT',
        layer,
        name: e.block?.name ?? '',
        position: xyz(e.insertPoint),
        // acad-ts reports rotation in radians; the shared code, following DXF group code
        // 50, wants degrees. Missing this puts every seat in the house at the wrong angle.
        rotation: (e.rotation ?? 0) * DEG,
        xScale: e.xScale ?? 1,
        yScale: e.yScale ?? 1,
        zScale: e.zScale ?? 1,
        columnCount: e.columnCount ?? 1,
        rowCount: e.rowCount ?? 1,
        columnSpacing: e.columnSpacing ?? 0,
        rowSpacing: e.rowSpacing ?? 0,
      }

    default:
      return null
  }
}

/**
 * Entity classes that are meant to be dropped, so that anything else being dropped can be
 * reported. Silence is the wrong default: a venue whose balcony front is a HATCH should
 * say the hatch was skipped, not just quietly come out without a balcony.
 */
const IGNORED = new Set([
  'TextEntity',
  'MText',
  'AttributeEntity',
  'AttributeDefinition',
  'Leader',
  'MultiLeader',
  'Dimension',
  'DimensionAligned',
  'DimensionLinear',
  'DimensionRadius',
  'DimensionDiameter',
  'DimensionAngular2Line',
  'DimensionAngular3Pt',
  'DimensionOrdinate',
  'Point',
  'Viewport',
  'Seqend',
  'Ray',
  'XLine',
])

function mapEntities(
  source: Iterable<Obj> | undefined,
  fallbackLayer: string,
  skipped: Set<string>,
): Obj[] {
  const out: Obj[] = []
  for (const e of source ?? []) {
    const layer = e.layer?.name ?? fallbackLayer
    const mapped = toCadEntity(e, String(layer))
    if (mapped) out.push(mapped)
    else {
      const name = e.constructor?.name
      if (name && !IGNORED.has(name)) skipped.add(name)
    }
  }
  return out
}

/**
 * The whole translation, given an already-parsed acad-ts document.
 *
 * Split out from the file reading so it can be tested against real acad-ts entity objects
 * without a .dwg fixture. Everything this file can get wrong — the angle units, the sweep
 * direction, which property holds a block's base point — is in here.
 */
export function buildDwgScene(
  doc: Obj,
  filename: string,
  options: Partial<DwgOptions> = {},
): ImportedScene {
  const warn = new Set<string>()

  // Blocks by name, so an INSERT can be resolved the same way it is for DXF. Every block
  // record is included, not only those reachable from model space: a block referenced
  // from inside another block has to resolve too.
  const skipped = new Set<string>()
  const blocks: Record<string, CadBlock> = {}
  for (const record of doc.blockRecords ?? []) {
    const name = record?.name
    if (!name) continue
    blocks[String(name)] = {
      position: xyz(record.blockEntity?.basePoint ?? record.basePoint),
      entities: mapEntities(record.entities, String(name), skipped),
    }
  }

  const entities = mapEntities(doc.modelSpace?.entities, '0', skipped)
  for (const name of skipped) {
    warn.add(`Skipped unsupported DWG entity type ${name}.`)
  }
  if (entities.length === 0) {
    throw new ImportError(
      'That DWG has nothing in model space.',
      'The drawing may keep its geometry in a paper-space layout, which is a sheet of ' +
        'annotation rather than a model. Move the geometry to model space and re-save.',
    )
  }

  const cad: CadDocument = { entities, blocks }
  const nodes = buildNodes(cad, options, warn)
  if (nodes.length === 0) throw noSurfacesError('DWG')

  const insunits = doc.header?.insUnits
  const unitsPerMetre = typeof insunits === 'number' ? INSUNITS[insunits] : undefined
  if (unitsPerMetre === undefined) {
    warn.add('This DWG does not declare its units (INSUNITS is 0 or absent). Set them yourself.')
  }

  return {
    format: 'DWG',
    sourceName: filename.replace(/\.[^.]+$/, ''),
    unitsPerMetre,
    // DWG world coordinates are Z-up, as DXF's are.
    upAxis: 'z',
    nodes,
    warnings: [...warn],
  }
}

/**
 * Read a DWG.
 *
 * `acad-ts` is loaded on demand. It is a large dependency next to the rest of this app,
 * and a user who never opens a DWG should never pay to download it.
 */
export async function importDwg(
  buffer: ArrayBuffer,
  filename: string,
  options: Partial<DwgOptions> = {},
): Promise<ImportedScene> {
  let doc: Obj
  try {
    const { DwgReader } = await import('@node-projects/acad-ts')
    doc = await new DwgReader(buffer).read()
  } catch (e) {
    throw new ImportError(
      `Could not read this DWG: ${(e as Error).message}`,
      'DWG has no public specification and every AutoCAD release changes it, so some files ' +
        'cannot be read. From AutoCAD use SAVEAS and pick DXF (R2013 ASCII is safest), or ' +
        'run the free ODA File Converter to turn it into DXF, then drop that here.',
    )
  }
  return buildDwgScene(doc, filename, options)
}
