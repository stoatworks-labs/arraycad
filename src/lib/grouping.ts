/**
 * Making a long object list prunable: labels for groups, and groups for flat lists.
 *
 * Pruning is the work this app asks of a user, and it is done by reading names. Two things
 * get in the way of that, and both are fixed here rather than in the tree component so
 * they can be tested without a DOM.
 *
 * 1. **Some groups arrive with no usable name.** A `.dbacv` names every group after its
 *    own GUID — `RoomObjectGroup: {c9ab9376-…}` — so the tree shows a dozen identical
 *    rows and the only way to tell them apart is to open each one. The children know
 *    perfectly well what the group is: eleven objects all called `TIER 3 - something`
 *    make it the tier 3 group. `deriveLabel` reads that back off them.
 *
 * 2. **Some scenes have no groups at all.** A DXF or DWG is one node per layer, an STL is
 *    one node full stop, and a flat glTF export can be hundreds of siblings. `autoGroup`
 *    clusters a sibling list by the structure already present in the names.
 *
 * Nothing here changes the scene. Grouping is a view over the nodes, in the same way that
 * decisions are a record beside them — the ids are what everything downstream works in.
 */

/** Words that are a separator rather than a name: a common prefix should not end on one. */
const SEPARATORS = new Set(['-', '–', '—', '|', ':', '/', '·', '>', '»'])

const isNumeric = (word: string) => /^[0-9]+(\.[0-9]+)?$/.test(word)

/** Trailing punctuation left behind when a common prefix stops at a separator. */
const trimTrailing = (s: string) => s.replace(/[\s\-–—|:/·>»_,.]+$/, '').trim()

const words = (name: string) => name.trim().split(/\s+/).filter(Boolean)

/**
 * The name a set of names share, or null if they share nothing worth showing.
 *
 * Word-wise rather than character-wise, so `TIER 3 - LEFT 1` and `TIER 3 - LEFT 2` give
 * `TIER 3 - LEFT` and not `TIER 3 - LEFT ` with a ragged tail. A character-wise common
 * prefix of `TIER 3 - CENTRE` and `TIER 3 - CEILING LEFT 1` would be `TIER 3 - CE`, which
 * is not a word and reads as a typo.
 */
export function deriveLabel(names: string[]): string | null {
  const usable = names.map(words).filter((w) => w.length > 0)
  if (usable.length === 0) return null
  if (usable.length === 1) return trimTrailing(usable[0].join(' ')) || null

  const first = usable[0]
  let n = 0
  while (n < first.length) {
    const w = first[n]
    if (!usable.every((other) => n < other.length && other[n] === w)) break
    n++
  }
  if (n === 0) return null

  // Only the trailing separator is dropped. A NUMBER inside a common prefix is always
  // part of the name rather than an index — if it were an index it would differ between
  // the names and would not be common — so "TIER 3" keeps its 3, and losing it would
  // merge the three tiers of a theatre into one indistinguishable heap.
  return trimTrailing(first.slice(0, n).join(' ')) || null
}

/**
 * True when a name tells the user nothing and a derived one would be better.
 *
 * Deliberately narrow — a GUID, or nothing at all. Guessing more widely ("Mesh", "Object",
 * "Layer0") risks overriding a name the draughtsman chose on purpose, and a real name that
 * is merely terse is still the author's.
 */
export function isUninformativeName(name: string): boolean {
  const s = name.trim()
  if (s === '') return true
  return /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(s)
}

/** What a sibling list turned into. `loose` keeps document order, as do the groups. */
export interface NameGroup<T> {
  key: string
  label: string
  items: T[]
}

export interface GroupingResult<T> {
  groups: NameGroup<T>[]
  loose: T[]
}

export interface AutoGroupOptions {
  /** Smallest group worth a header row of its own. */
  minGroupSize: number
  /** Below this many siblings, grouping costs more attention than it saves. */
  minSiblings: number
}

export const DEFAULT_AUTO_GROUP: AutoGroupOptions = { minGroupSize: 2, minSiblings: 9 }

/** The part of a name before its first separator word — `TIER 3` of `TIER 3 - LEFT 1`. */
function leadingSegment(name: string): string | null {
  const w = words(name)
  if (w.length === 0) return null
  const cut = w.findIndex((x) => SEPARATORS.has(x))
  const head = cut === -1 ? [w[0]] : w.slice(0, cut)
  // An all-numeric head is an index, not a category: grouping a seating plan by the layer
  // numbers 21, 41, 61 puts every layer in a group of one and calls it organisation.
  if (head.length === 0 || head.every(isNumeric)) return null
  return head.join(' ')
}

/** Lower-cased non-numeric words, for the fallback pass. */
function contentWords(name: string): string[] {
  return words(name)
    .filter((w) => !SEPARATORS.has(w) && !isNumeric(w) && w.length > 1)
    .map((w) => w.toLowerCase().replace(/[^a-z0-9]+/g, ''))
    .filter(Boolean)
}

/**
 * Cluster a sibling list by the structure in its names.
 *
 * Two passes, because venue drawings are named both ways round. The leading segment
 * catches `TIER 3 - LEFT 1` and `STALLS - MAIN 2`, where the category leads. The shared
 * word catches `25 loge` and `45 loge`, where the category trails a number that means
 * nothing on its own — and which the first pass deliberately refuses to group by.
 *
 * The second pass is greedy, largest group first, so a name matching several candidate
 * words lands in the biggest one and cannot appear twice.
 */
export function autoGroup<T>(
  items: T[],
  nameOf: (item: T) => string,
  options: Partial<AutoGroupOptions> = {},
): GroupingResult<T> {
  const opts = { ...DEFAULT_AUTO_GROUP, ...options }
  if (items.length < opts.minSiblings) return { groups: [], loose: items }

  const assigned = new Map<T, string>()
  const buckets = new Map<string, T[]>()

  const put = (key: string, item: T) => {
    const b = buckets.get(key)
    if (b) b.push(item)
    else buckets.set(key, [item])
  }

  // Pass one: leading segment.
  const bySegment = new Map<string, T[]>()
  for (const item of items) {
    const seg = leadingSegment(nameOf(item))
    if (!seg) continue
    const b = bySegment.get(seg)
    if (b) b.push(item)
    else bySegment.set(seg, [item])
  }
  for (const [seg, members] of bySegment) {
    if (members.length < opts.minGroupSize) continue
    // A group holding every sibling has organised nothing — it just adds a row and an
    // indent. This is the common case one level down, where all eleven children of the
    // tier 3 group are of course called `TIER 3 - something`.
    if (members.length === items.length) continue
    for (const m of members) {
      assigned.set(m, seg)
      put(seg, m)
    }
  }

  // Pass two: shared content word, greedy on the rest.
  for (;;) {
    const byWord = new Map<string, T[]>()
    let remaining = 0
    for (const item of items) {
      if (assigned.has(item)) continue
      remaining++
      for (const w of new Set(contentWords(nameOf(item)))) {
        const b = byWord.get(w)
        if (b) b.push(item)
        else byWord.set(w, [item])
      }
    }
    let best: { word: string; members: T[] } | null = null
    for (const [word, members] of byWord) {
      if (members.length < opts.minGroupSize) continue
      // Against what is LEFT, not against the original list. Once the right-hand seats
      // have been taken out, the word they all still share — "tier" — covers everything
      // that remains, and wrapping the remainder in one header organises nothing.
      if (members.length === remaining) continue
      // Bigger wins; on a tie the longer word is the more specific label.
      if (!best || members.length > best.members.length || (members.length === best.members.length && word.length > best.word.length)) {
        best = { word, members }
      }
    }
    if (!best) break
    for (const m of best.members) {
      assigned.set(m, best.word)
      put(best.word, m)
    }
  }

  const groups: NameGroup<T>[] = []
  for (const [key, members] of buckets) {
    groups.push({
      key,
      // The members know their own shared name better than the key does: a bucket keyed
      // on the word "loge" is better labelled from what is actually in it.
      label: deriveLabel(members.map(nameOf)) ?? key,
      items: members,
    })
  }
  // Document order, by where each group's first member sits, so the tree does not
  // reshuffle itself relative to the file.
  const indexOf = new Map(items.map((it, i) => [it, i]))
  groups.sort((a, b) => (indexOf.get(a.items[0]) ?? 0) - (indexOf.get(b.items[0]) ?? 0))

  return { groups, loose: items.filter((it) => !assigned.has(it)) }
}
