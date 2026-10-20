/**
 * The one intermediate model every importer produces.
 *
 * Whatever the source format, an importer's job is to reduce it to named nodes holding
 * WORLD-SPACE triangle soup, in the source file's own units and axis convention. All unit
 * conversion, axis flipping and datum placement happens once, afterwards, in
 * geom/transform.ts — never inside an importer. Two importers each doing their own
 * half-correct unit guess is how a model ends up 25.4x too big in one axis only.
 */

import type { PlaneType } from '../dbacv/types.ts'
import type { UnitsDoubt } from './seats.ts'

export interface ImportedNode {
  id: string
  /** From the source: layer name, object name, IFC GlobalId label. Shown in the tree. */
  name: string
  /**
   * Free-form provenance — DXF layer, IFC entity type, material name. Used to suggest a
   * plane type and to drive "select all like this".
   */
  tags: string[]
  /** World-space triangle soup: 9 numbers per triangle, x,y,z per corner. */
  positions: Float64Array
  /** A plane type the importer is confident about, e.g. from an IFC entity type. */
  suggestedPlaneType?: PlaneType
  children: ImportedNode[]
}

export interface ImportedScene {
  /** For display: 'glTF', 'DXF', 'IFC', ... */
  format: string
  /** Source filename, for naming the export. */
  sourceName: string
  /**
   * Metres per source unit, when the format states it (glTF is always metres, DXF has
   * $INSUNITS, IFC has IfcUnitAssignment). Undefined means the user must choose.
   */
  unitsPerMetre?: number
  /** When the format states its up axis. Undefined means the user must choose. */
  upAxis?: 'y' | 'z'
  /**
   * The stated units, contradicted by the drawing's own seats. `unitsPerMetre` is still
   * what the file says; this is the reason to doubt it, shown wherever the units are.
   * See `import/seats.ts`.
   */
  unitsDoubt?: UnitsDoubt
  /**
   * This file is ALREADY a venue: an ArrayCalc, Soundvision or EASE Focus project.
   *
   * Every object in one of those was put there by whoever built it. There is no clutter
   * to leave out, nothing to classify that is not already classified, and no scattering
   * of seats to gather — the person who made the file did all of that. So `prepare/`
   * leaves it alone rather than second-guessing a finished design: a venue whose author
   * named a plane `LIGHTING BRIDGE` meant it to be there, and an automatic pass reading
   * that name as rigging would quietly drop it on the way in.
   */
  alreadyAVenue?: boolean
  nodes: ImportedNode[]
  /**
   * DXF and DWG only: the drawing as it was DRAWN, one entry per layer — every line, arc,
   * polyline and outline, open or closed, before anything was filled or thrown away.
   *
   * `nodes` holds only what closed into a surface. A floor plan is mostly lines that never
   * do, and those are exactly what the tracer needs to see: they are the ink a region is
   * detected between. Source units, like `positions`; nothing reads it but `trace/cad.ts`.
   */
  linework?: LayerLinework[]
  /** Non-fatal problems worth showing: skipped entities, unsupported features. */
  warnings: string[]
}

/**
 * One layer's line work, packed: a few hundred thousand two-point LINEs as separate
 * arrays would cost more in object headers than in coordinates.
 */
export interface LayerLinework {
  layer: string
  /** x, y, z of every path, back to back, in source units. */
  points: Float64Array
  /** Where each path starts, as a POINT index into `points`. One longer than the path count. */
  starts: Uint32Array
  /** 1 where the path is a closed ring. */
  closed: Uint8Array
}

/** Thrown when a file cannot be imported at all. `advice` is shown to the user verbatim. */
export class ImportError extends Error {
  advice: string
  /**
   * The file has no surfaces in it, but it is a drawing that can be TRACED: a DXF or DWG
   * plan whose lines never close. A scene with no nodes and its `linework`, for the app to
   * open in the tracer instead of stopping at this error.
   */
  traceable?: ImportedScene
  constructor(message: string, advice = '', traceable?: ImportedScene) {
    super(message)
    this.advice = advice
    this.traceable = traceable
  }
}

export function countTriangles(nodes: ImportedNode[]): number {
  let n = 0
  for (const node of nodes) {
    n += node.positions.length / 9
    n += countTriangles(node.children)
  }
  return n
}

export function flattenNodes(nodes: ImportedNode[]): ImportedNode[] {
  const out: ImportedNode[] = []
  const walk = (ns: ImportedNode[]) => {
    for (const n of ns) {
      out.push(n)
      walk(n.children)
    }
  }
  walk(nodes)
  return out
}
