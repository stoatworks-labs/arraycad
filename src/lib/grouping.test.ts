import { describe, expect, it } from 'vitest'
import { autoGroup, deriveLabel, isUninformativeName } from './grouping.ts'

const g = (names: string[], opts = {}) => autoGroup(names, (n) => n, opts)
const shape = (names: string[], opts = {}) => {
  const r = g(names, opts)
  return { groups: r.groups.map((x) => `${x.label}: ${x.items.length}`), loose: r.loose }
}

describe('deriveLabel', () => {
  it('reads a group name back off its children', () => {
    // A .dbacv calls every group after its own GUID. The children know what it is.
    expect(
      deriveLabel(['TIER 3 - LEFT 5', 'TIER 3 - CENTRE', 'TIER 3 - RIGHT 1']),
    ).toBe('TIER 3')
  })

  it('keeps a number that the names carry on past', () => {
    // The 3 in "TIER 3" is part of the name; the 1 in "LEFT 1" is an index.
    expect(deriveLabel(['TIER 2 - CEILING LEFT 1', 'TIER 2 - CEILING LEFT 2'])).toBe(
      'TIER 2 - CEILING LEFT',
    )
  })

  it('stops on whole words, not part-way through one', () => {
    // Character-wise this would be "TIER 3 - CE", which reads as a typo.
    expect(deriveLabel(['TIER 3 - CENTRE', 'TIER 3 - CEILING LEFT 1'])).toBe('TIER 3')
  })

  it('accepts a prefix that is the whole of one name', () => {
    expect(deriveLabel(['STAGE', 'STAGE - FRONT'])).toBe('STAGE')
  })

  it('gives up when the names share nothing', () => {
    expect(deriveLabel(['STAGE', 'BALCONY'])).toBeNull()
    expect(deriveLabel([])).toBeNull()
  })
})

describe('isUninformativeName', () => {
  it('spots a GUID name and an empty one', () => {
    expect(isUninformativeName('RoomObjectGroup: {c9ab9376-247c-4a03-9112-6b386568921e}')).toBe(true)
    expect(isUninformativeName('   ')).toBe(true)
  })

  it('leaves a real name alone, however terse', () => {
    // Guessing more widely would override names a draughtsman chose on purpose.
    for (const n of ['21', 'STAGE', 'Mesh', 'Layer0', 'A-Anno-Symb']) {
      expect(isUninformativeName(n)).toBe(false)
    }
  })
})

describe('autoGroup', () => {
  it('leaves a short list alone', () => {
    const names = ['STAGE', 'PIT', 'BALCONY']
    expect(g(names).groups).toEqual([])
    expect(g(names).loose).toEqual(names)
  })

  it('groups a venue by its leading segment', () => {
    const names = [
      'TIER 3 - LEFT 1', 'TIER 3 - LEFT 2', 'TIER 3 - CENTRE',
      'TIER 3 - RIGHT 1', 'TIER 3 - RIGHT 2',
      'TIER 2 - LEFT 1', 'TIER 2 - CENTRE', 'TIER 2 - RIGHT 1',
      'STALLS - MAIN 1', 'STALLS - MAIN 2',
      'SOUNDSCAPE',
    ]
    const r = shape(names)
    expect(r.groups).toEqual(['TIER 3: 5', 'TIER 2: 3', 'STALLS - MAIN: 2'])
    expect(r.loose).toEqual(['SOUNDSCAPE'])
  })

  it('groups by a trailing word when the number leads', () => {
    // A seating plan numbers its layers: 21/41/61 are the categories' indices, not
    // categories. Grouping by those puts every layer in a group of one.
    const names = [
      '21', '25 loge', '26 balcony', '41', '45 loge', '46 balcony',
      '61 sizes', '65 loge sizes', '66 balcony sizes', 'return air grills',
    ]
    const r = shape(names)
    expect(r.groups).toContainEqual('loge: 3')
    expect(r.groups).toContainEqual('balcony: 3')
    expect(r.loose).toContain('21')
    expect(r.loose).toContain('41')
  })

  it('never puts one item in two groups', () => {
    const names = [
      'A-Anno-Symb', 'A-Anno-Titl', 'A-Detl-010', 'A-Detl-018',
      'north wall', 'south wall', 'east wall', 'west wall', 'roof', 'floor',
    ]
    const r = g(names)
    const seen = r.groups.flatMap((x) => x.items).concat(r.loose)
    expect(new Set(seen).size).toBe(names.length)
    expect(seen).toHaveLength(names.length)
  })

  it('keeps groups in document order', () => {
    const names = [
      'ZULU - 1', 'ZULU - 2', 'ALPHA - 1', 'ALPHA - 2',
      'a', 'b', 'c', 'd', 'e', 'f',
    ]
    expect(shape(names).groups).toEqual(['ZULU: 2', 'ALPHA: 2'])
  })

  it('honours the minimum group size', () => {
    const names = [
      'TIER 3 - A', 'TIER 3 - B', 'TIER 2 - A',
      'p', 'q', 'r', 's', 't', 'u', 'v',
    ]
    // At 2, the leading segment splits the tiers apart. At 3 neither tier reaches the
    // minimum on its own, so the fallback finds the word they share and groups all three.
    expect(shape(names, { minGroupSize: 2 }).groups).toEqual(['TIER 3: 2'])
    expect(shape(names, { minGroupSize: 3 }).groups).toEqual(['TIER: 3'])
  })
})

describe('a group that holds everything is not a group', () => {
  it('refuses to wrap a whole sibling list in one group', () => {
    // One level down inside the tier 3 group, all eleven children are of course called
    // "TIER 3 - something". Grouping them under "TIER 3" adds a row and an indent and
    // organises nothing — but "LEFT" and "RIGHT" inside it are worth having.
    const names = [
      'TIER 3 - LEFT 1', 'TIER 3 - LEFT 2', 'TIER 3 - LEFT 3',
      'TIER 3 - LEFT 4', 'TIER 3 - LEFT 5', 'TIER 3 - CENTRE',
      'TIER 3 - RIGHT 1', 'TIER 3 - RIGHT 2', 'TIER 3 - RIGHT 3',
      'TIER 3 - RIGHT 4', 'TIER 3 - RIGHT 5',
    ]
    const r = shape(names)
    expect(r.groups).toEqual(['TIER 3 - LEFT: 5', 'TIER 3 - RIGHT: 5'])
    expect(r.loose).toEqual(['TIER 3 - CENTRE'])
  })
})
