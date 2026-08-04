/**
 * Reader for the EASE Focus 3 project format.
 *
 * Exists to prove the writer by round trip — the standard `soundvision/read.ts` sets —
 * and to make an existing EASE Focus venue usable as an import source, which completes
 * the converter triangle: ArrayCalc, Soundvision and EASE Focus all read and all write.
 *
 * Reads only what the venue model needs. Sound sources, receivers, filters and pictures
 * pass through this parser unread; a round trip through ArrayCAD is a venue conversion,
 * not a project edit.
 */

import { isEaseFocusFile, readSoapHashtable, unframeFc3 } from './container.ts'
import type { EaseFocusArea, EaseFocusProject, EaseFocusZone } from './types.ts'

export interface EaseFocusReadResult {
  project: EaseFocusProject
  /** From the file header: the application version that wrote it. */
  writtenBy: string
  warnings: string[]
}

export { isEaseFocusFile }

export function readEaseFocus(bytes: Uint8Array): EaseFocusReadResult {
  const { headerXml, payloadXml } = unframeFc3(bytes)
  const header = readSoapHashtable(headerXml)
  const map = readSoapHashtable(payloadXml)
  const warnings: string[] = []

  const str = (key: string, fallback = ''): string => {
    const v = map.get(key)
    return typeof v === 'string' ? v : fallback
  }
  const num = (key: string, fallback = 0): number => {
    const v = map.get(key)
    if (typeof v !== 'string' || v === '') return fallback
    const n = Number(v)
    if (!Number.isFinite(n)) {
      warnings.push(`"${key}" is not a number (${JSON.stringify(v)}); using ${fallback}.`)
      return fallback
    }
    return n
  }

  const zones: EaseFocusZone[] = []
  const zoneCount = num('Project.AudienceZoneManager.Count')
  for (let i = 0; i < zoneCount; i++) {
    const p = `Project.AudienceZoneManager.Zone[${i}]`
    const type = str(`${p}.Type`, 'Rectangle')
    if (type !== 'Rectangle') {
      // Sector zones exist in the format; nothing downstream can hold one yet.
      warnings.push(`Zone "${str(`${p}.Label`)}" is a ${type} and was skipped — only Rectangle zones are read.`)
      continue
    }
    const areas: EaseFocusArea[] = []
    const areaCount = num(`${p}.AreaCount`)
    for (let j = 0; j < areaCount; j++) {
      const q = `${p}.Area[${j}]`
      areas.push({
        label: str(`${q}.Label`),
        d1: num(`${q}.D1`),
        d2: num(`${q}.D2`),
        z1: num(`${q}.Z1`),
        z2: num(`${q}.Z2`),
      })
    }
    zones.push({
      label: str(`${p}.Label`, `Zone ${i + 1}`),
      x: num(`${p}.X`),
      y: num(`${p}.Y`),
      orientation: num(`${p}.Orientation`),
      width: num(`${p}.Width`),
      depth: num(`${p}.Depth`),
      referenceZ: num(`${p}.ReferencePoint.Z`),
      areas,
    })
  }

  const sources = num('Project.SoundSourcesManager.Count')
  if (sources > 0) {
    warnings.push(
      `The project has ${sources} sound source(s). Only the venue geometry is read — ` +
        'sources, filters and mapping settings do not survive a conversion.',
    )
  }

  const headerVersion = header.get('EASEFocusVersion')

  return {
    project: {
      title: str('Project.Title'),
      author: str('Project.Author'),
      company: str('Project.Company'),
      notes: str('Project.Notes'),
      zones,
    },
    writtenBy: typeof headerVersion === 'string' ? headerVersion : '',
    warnings,
  }
}
