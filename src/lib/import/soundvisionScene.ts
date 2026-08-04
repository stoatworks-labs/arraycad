/**
 * Import a Soundvision 3D room data `.txt` as if it were a CAD file.
 *
 * The counterpart to `dbacvScene.ts`, and it exists for the same two reasons. It lets an
 * existing Soundvision room be opened, pruned and retyped, and — with `dbacvScene.ts` on
 * the other side — it makes the two prediction tools' venue formats interconvertible:
 * ArrayCalc in, Soundvision out, or the reverse. Everything between the two is the ordinary
 * pipeline, so a cross conversion is reduced and simplified exactly like a CAD import and
 * gets the same tree, the same pruning and the same plane typing.
 *
 * Soundvision surfaces are free polygons, so they arrive as rings and have to be
 * triangulated before the planariser can see them; `geom/polygon.ts:triangulateRing` does
 * that, and coplanar neighbours are merged straight back afterwards. A room whose surfaces
 * were already one-per-plane therefore comes out with the object count it went in with.
 */

import { type ImportedNode, type ImportedScene, ImportError } from './types.ts'
import { triangulateRing } from '../geom/polygon.ts'
import { isSoundvisionText, readSoundvision } from '../soundvision/read.ts'

let seq = 0
const nextId = () => `svn${++seq}`

/**
 * The stock SketchUp and Vectorworks plug-ins label every face `"<layer name> face"`, and
 * `soundvision/convert.ts` writes the same so that an ArrayCAD export reads the way a
 * Vectorworks one does. Which means the suffix has to come back OFF here: without this a
 * file that goes out and comes back is labelled `"Seating face face"`, and the trip after
 * that `"Seating face face face"`.
 *
 * A layer genuinely called "Seating face" loses its word, which is the lesser harm — it is
 * one name, against a suffix that grows without bound on every conversion.
 */
const FACE_SUFFIX = / face$/

export function importSoundvisionAsScene(text: string, filename: string): ImportedScene {
  if (!isSoundvisionText(text)) {
    throw new ImportError(
      'This .txt is not a Soundvision 3D room data file.',
      'A 3D room data export is a list of "Label" rows each followed by x,y,z coordinates. ' +
        'Export one from Soundvision with 3D room data > Export 3D room data, or from the ' +
        'SketchUp or Vectorworks plug-in.\n\n' +
        "Soundvision's own scene file (.xmls) is encrypted and cannot be read by anything " +
        'outside Soundvision, so 3D room data is the route in as well as the route out.',
    )
  }

  const { scene, warnings } = readSoundvision(text)

  // Group by label, first seen first. Labels are NOT unique — 6,786 of the 7,194 faces in
  // the reference export share "None face" — so this is what turns a flat list of surfaces
  // back into the layer tree the drawing had, which is the thing worth pruning by.
  const groups = new Map<string, number[]>()
  let fanned = 0
  let degenerate = 0

  for (const face of scene.faces) {
    let tris = groups.get(face.label)
    if (!tris) {
      tris = []
      groups.set(face.label, tris)
    }
    const fill = triangulateRing(face.points, tris)
    if (fill === 'fanned') fanned++
    else if (fill === 'degenerate') degenerate++
  }

  const nodes: ImportedNode[] = [...groups].map(([label, tris]) => ({
    id: nextId(),
    name: label.replace(FACE_SUFFIX, '') || label,
    tags: [`label:${label}`],
    positions: new Float64Array(tris),
    children: [],
  }))

  const notes = [...warnings]
  if (fanned > 0) {
    notes.push(
      `${fanned} surface(s) were not flat and were fanned about their centre rather than ` +
        'folded onto a plane. Each one becomes several objects with a seam between them.',
    )
  }
  if (degenerate > 0) {
    notes.push(`${degenerate} surface(s) enclosed no area and were dropped.`)
  }
  if (nodes.length > 0) {
    notes.push(
      'Surfaces are triangulated on the way in and rebuilt from planes on the way out, so a ' +
        'round trip through here is not lossless — use it to prune, retype and convert, not ' +
        'to preserve. 3D room data carries no listening levels, so plane types start at the ' +
        'default and are yours to set.',
    )
  }

  return {
    // Read by the .dbacv writer for its venue comment, so it says what this came from.
    format: 'Soundvision 3D room data',
    alreadyAVenue: true,
    sourceName: filename.replace(/\.[^.]+$/, ''),
    // Soundvision works in metres with Z up, and geometry that will be read as metres by
    // Soundvision is in metres by definition. The header's `LengthUnit` row is a comment
    // its parser never reads (docs/soundvision-format.md §3) and is not evidence.
    unitsPerMetre: 1,
    upAxis: 'z',
    nodes,
    warnings: notes,
  }
}
