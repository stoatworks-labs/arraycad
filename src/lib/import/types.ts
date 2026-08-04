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
  /** Non-fatal problems worth showing: skipped entities, unsupported features. */
  warnings: string[]
}

/** Thrown when a file cannot be imported at all. `advice` is shown to the user verbatim. */
export class ImportError extends Error {
  advice: string
  constructor(message: string, advice = '') {
    super(message)
    this.advice = advice
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
