/**
 * The four output files, assembled from the same inputs the live conversion reads.
 *
 * Shared by the app's export buttons and by the MCP server (`src/mcp/`), so a venue written
 * from either is the same file byte for byte. The reduction is already shared — every
 * target goes through `geom/outline.ts` — but what wraps it was not: the `.dbacv` header,
 * the winding Soundvision is written with, the project name a zone file carries. Those
 * lived in `App.tsx`'s callbacks, and a second front end copying them would be the drift
 * AGENTS.md §6 describes, one level up.
 *
 * Each target starts from outlines rather than from the ArrayCalc result, for the reason
 * the old callbacks gave: that result holds RoomObjects, already through the canonical
 * quad frame and possibly split into triangles to fit it, and Soundvision, EASE Focus and
 * MVR want each plane whole.
 */

import type { VenueFile } from './lib/dbacv/types.ts'
import { formatDbacvDate, writeDbacv } from './lib/dbacv/write.ts'
import type { ImportedScene } from './lib/import/index.ts'
import { type ConvertResult, convertNodes } from './lib/geom/convert.ts'
import { convertNodesToSoundvision } from './lib/soundvision/convert.ts'
import { writeSoundvision } from './lib/soundvision/write.ts'
import { convertNodesToEaseFocus } from './lib/easefocus/convert.ts'
import { writeEaseFocus } from './lib/easefocus/write.ts'
import { convertNodesToMvr } from './lib/mvr/convert.ts'
import { writeMvr } from './lib/mvr/write.ts'
import {
  type Decisions,
  type RationalisedArea,
  type Rationalisation,
  type Settings,
  conversionEntries,
  convertOptions,
  rationalisedAreas,
} from './state.ts'

export type Target = 'dbacv' | 'soundvision' | 'fc3' | 'mvr'

export interface TargetFile {
  data: string | Uint8Array
  /** With the dot. Soundvision's is `.txt`, which is what its importer asks for. */
  extension: string
  mime: string
  /** Objects, faces, zones or MVR objects written. Zero means there is nothing to write. */
  count: number
  stats: object
  warnings: string[]
}

/** What a venue is assembled from: the same four things `useConversion` reads. */
export interface VenueInputs {
  scene: ImportedScene
  decisions: Decisions
  settings: Settings
  rationalisations: Rationalisation[]
}

/**
 * The ArrayCalc conversion, as `useConversion` runs it on every settled change.
 *
 * The hook keeps its own copy of these four lines because it is a memo over debounced
 * inputs; this is the copy for callers that have no render loop. Change one, change both.
 */
export function convertVenue(v: VenueInputs): { result: ConvertResult; areas: RationalisedArea[] } {
  const r = rationalisedAreas(v.scene, v.rationalisations, v.settings)
  const result = convertNodes(conversionEntries(v.scene, v.decisions, r.effective), convertOptions(v.settings), r.areas)
  result.warnings.push(...r.warnings)
  return { result, areas: r.areas }
}

export function dbacvFile(result: ConvertResult, projectName: string, sourceFormat?: string): TargetFile {
  const venue: VenueFile = {
    // The version this format was reverse-engineered from. ArrayCalc reads its own older
    // files, so claiming the version we actually understand is the honest choice.
    appVersion: '12.8.2',
    venueVersion: '9',
    projectName,
    date: formatDbacvDate(),
    author: 'ArrayCAD',
    projectComments: '',
    venueComments: `Converted from ${sourceFormat ?? 'CAD'} by ArrayCAD.`,
    objects: result.objects,
  }
  return {
    data: writeDbacv(venue),
    extension: '.dbacv',
    mime: 'application/xml',
    // Objects, not top-level entries: a node of several planes is written as one group.
    count: result.stats.objectsOut,
    stats: result.stats,
    warnings: result.warnings,
  }
}

export function soundvisionFile(v: VenueInputs): TargetFile {
  const { areas, effective } = rationalisedAreas(v.scene, v.rationalisations, v.settings)
  const r = convertNodesToSoundvision(
    conversionEntries(v.scene, v.decisions, effective),
    { ...convertOptions(v.settings), winding: 'up' },
    areas,
  )
  return {
    data: writeSoundvision(r.scene),
    extension: '.txt',
    mime: 'text/plain',
    count: r.scene.faces.length,
    stats: r.stats,
    warnings: r.warnings,
  }
}

export function easeFocusFile(v: VenueInputs, projectName: string): TargetFile {
  const { areas, effective } = rationalisedAreas(v.scene, v.rationalisations, v.settings)
  const r = convertNodesToEaseFocus(
    conversionEntries(v.scene, v.decisions, effective),
    convertOptions(v.settings),
    areas,
    projectName || 'ArrayCAD export',
  )
  return {
    data: writeEaseFocus(r.project),
    extension: '.fc3',
    mime: 'application/octet-stream',
    count: r.project.zones.length,
    stats: r.stats,
    warnings: r.warnings,
  }
}

export function mvrFile(v: VenueInputs, projectName: string): TargetFile {
  const { areas, effective } = rationalisedAreas(v.scene, v.rationalisations, v.settings)
  const r = convertNodesToMvr(
    conversionEntries(v.scene, v.decisions, effective),
    convertOptions(v.settings),
    areas,
    projectName || 'ArrayCAD export',
  )
  return {
    data: writeMvr(r.scene).bytes,
    extension: '.mvr',
    mime: 'application/octet-stream',
    count: r.scene.objects.length,
    stats: r.stats,
    warnings: r.warnings,
  }
}
