/**
 * Writer for the EASE Focus 3 project format.
 *
 * Emits the key set a default 3.1.260 project carries, with the zones swapped for the
 * caller's. Keys the application is known to tolerate missing are still written, because
 * "tolerated by 3.1.260" is not a contract — the default project's set is.
 *
 * Proof standard: a file from this writer was re-saved by EASE Focus 3.1.260 and every
 * zone value came back exactly as written (see docs/ease-focus-format.md §6). A byte-exact
 * round trip against the application is NOT possible for this format — the app's
 * Hashtable serialises in hash order, which reshuffles on every save — so equality is
 * asserted on the decoded key/value map instead.
 */

import {
  type SoapValue,
  frameFc3,
  newGuid,
  writeSoapHashtable,
} from './container.ts'
import {
  type EaseFocusProject,
  DEFAULT_GLOBAL_FILTER,
  EASEFOCUS_VERSION,
  PROJECT_VERSION,
} from './types.ts'

/**
 * Shortest round-trip decimal, which is also what .NET's default double.ToString gives
 * for every value this writer produces. Exponent notation never appears at venue scale,
 * and refusing non-finite input here beats EASE Focus refusing the file later.
 */
export function fmt(n: number): string {
  if (!Number.isFinite(n)) throw new Error(`EASE Focus export: value is not finite (${n}).`)
  return String(n)
}

/** The default broadband noise floor a new project carries, 35.2 dB in every band. */
const NOISE_LEVEL = '35.2287874528034'

export function writeEaseFocus(project: EaseFocusProject): Uint8Array {
  const pairs: [string, SoapValue][] = [
    ['Project.Title', project.title],
    ['Project.Author', project.author],
    ['Project.Company', project.company],
    ['Project.Notes', project.notes],
    ['Project.Origin.X', '0'],
    ['Project.Origin.Y', '0'],
    ['Project.Temperature', '20'],
    ['Project.Pressure', '101000'],
    ['Project.Humidity', '60'],
    ['Project.EarHeightSitting', '1.2'],
    ['Project.EarHeightStanding', '1.7'],
    ['Project.EarHeightCustom', '1.2'],
    ['Project.LayoutBitmap.IsEmpty', '1'],
    ['Project.NoiseLevel.Bandwidth', '2'],
    ['Project.SoundSourcesManager.Count', '0'],
    ['Project.SoundSourcesManager.SoundSourceGroups.Count', '0'],
    ['Project.SoundSourcesManager.GlobalFilter', DEFAULT_GLOBAL_FILTER],
    ['Project.SoundSourcesManager.DefaultHeightLimit.IsActive', '1'],
    ['Project.SoundSourcesManager.DefaultHeightLimit.LowerLimit', '3'],
    ['Project.SoundSourcesManager.DefaultHeightLimit.LowerLimitEnabled', '0'],
    ['Project.SoundSourcesManager.DefaultHeightLimit.UpperLimit', '8'],
    ['Project.SoundSourcesManager.DefaultHeightLimit.UpperLimitEnabled', '0'],
    ['Project.ReceiverManager.FreeReceiversCount', '0'],
    ['Project.SectionPlaneManager.Count', '0'],
    ['Project.MappingSoundsources.Count', '0'],
    ['Project.AudienceZoneManager.AudienceAreaGroups.Count', '0'],
    ['Enclosures.SystemDefinitionCount', '0'],
    ['__AttachmentCount', '0'],
  ]
  for (let i = 0; i < 30; i++) pairs.push([`Project.NoiseLevel.N[${i}]`, NOISE_LEVEL])

  pairs.push(['Project.AudienceZoneManager.Count', fmt(project.zones.length)])

  // Every area guid goes into the mapping list, so a written venue arrives with all its
  // areas enabled for mapping — matching what a project built by hand in the app has.
  const mappingGuids: string[] = []

  project.zones.forEach((zone, i) => {
    const p = `Project.AudienceZoneManager.Zone[${i}]`
    const zoneGuid = newGuid()
    pairs.push(
      [`${p}.Guid`, { base64: zoneGuid.base64 }],
      [`${p}.Label`, zone.label],
      [`${p}.Type`, 'Rectangle'],
      [`${p}.X`, fmt(zone.x)],
      [`${p}.Y`, fmt(zone.y)],
      [`${p}.Orientation`, fmt(zone.orientation)],
      [`${p}.Width`, fmt(zone.width)],
      [`${p}.Depth`, fmt(zone.depth)],
      [`${p}.ReferencePoint.Z`, fmt(zone.referenceZ)],
      [`${p}.ReferencePoint.DisplayCoordinatesRelativeToReference`, '0'],
      [`${p}.LayoutBitmapSide.IsEmpty`, '1'],
      [`${p}.AreaCount`, fmt(zone.areas.length)],
    )
    zone.areas.forEach((area, j) => {
      const q = `${p}.Area[${j}]`
      const areaGuid = newGuid()
      mappingGuids.push(areaGuid.text)
      pairs.push(
        [`${q}.Guid`, { base64: areaGuid.base64 }],
        [`${q}.Label`, area.label],
        [`${q}.D1`, fmt(area.d1)],
        [`${q}.D2`, fmt(area.d2)],
        [`${q}.Z1`, fmt(area.z1)],
        [`${q}.Z2`, fmt(area.z2)],
        [`${q}.EarHeightValue`, '0'],
        [`${q}.AnchoredReceiversCount`, '0'],
      )
    })
  })

  pairs.push(['Project.MappingAudienceAreas.Count', fmt(mappingGuids.length)])
  mappingGuids.forEach((g, i) => pairs.push([`Project.MappingAudienceAreas[${i}].Guid`, g]))

  const header = writeSoapHashtable([
    ['EASEFocusVersion', EASEFOCUS_VERSION],
    // Opaque S4 runtime data; four zero bytes is what a default project's header carries.
    ['AdditionalS4Data59333950', { base64: 'AAAAAA==' }],
    ['EASEFocusProjectVersion', PROJECT_VERSION],
  ])

  return frameFc3(header, writeSoapHashtable(pairs))
}
