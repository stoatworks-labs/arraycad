/**
 * What a name SAYS an object is.
 *
 * A venue drawing is named by a draughtsman for other humans, and those names carry most of
 * what this tool otherwise asks the user to supply by hand: that `DIMENSIONS` is not a
 * surface, that `SEATING - STALLS` is an audience area, that `WALL - SR` is an obstacle.
 * Reading them is the cheapest simplification available — it costs no geometry work at all
 * and it happens before the first conversion, which is the expensive one.
 *
 * Two rules keep it honest:
 *
 * 1. **Whole words only.** `TEXT` is annotation; `TEXTURED PANEL` is a surface. Substring
 *    matching would drop the panel, and dropping a real surface silently is the one failure
 *    this must not have. Everything is matched on tokens split out of the name.
 * 2. **Nothing here is destructive.** A match becomes a *decision* — an include flag or a
 *    plane type — which the tree shows, the viewport ghosts rather than hides, and one
 *    click reverses. See `plan.ts`.
 *
 * The word lists are deliberately plain data rather than clever patterns. They are the part
 * a user of a particular house style will want to extend, and a list you can read is worth
 * more than a stemmer you have to reason about. English plus the CAD abbreviations that
 * turn up everywhere; there is no attempt at other languages, and a French or German
 * drawing simply falls through to "unknown", which is the safe answer.
 */

export type Category = 'clutter' | 'seating' | 'stage' | 'ceiling' | 'wall' | 'floor'

/**
 * Not room surfaces. Drawing furniture, services, and the things a venue model carries that
 * a prediction has no use for.
 *
 * Loudspeakers are in here on purpose: ArrayCalc and Soundvision place their own sources,
 * and importing the ones already modelled leaves a venue full of surfaces shaped like
 * cabinets, sitting exactly where the new sources want to go.
 */
const CLUTTER = [
  // Drawing furniture
  'dimension', 'dimensions', 'dim', 'dims', 'dimn',
  'annotation', 'annotations', 'anno', 'note', 'notes', 'label', 'labels',
  'text', 'mtext', 'title', 'titleblock', 'legend', 'key', 'scalebar', 'north',
  'grid', 'gridline', 'gridlines', 'hatch', 'hatching',
  'centreline', 'centerline', 'callout', 'leader', 'symbol', 'symbols',
  'defpoints', 'nonplot', 'noplot', 'viewport', 'vport',
  // Production rigging and lighting
  'lighting', 'light', 'lights', 'luminaire', 'luminaires', 'lantern', 'lanterns', 'lx',
  'truss', 'trusses', 'rigging', 'hoist', 'hoists', 'motor', 'motors', 'winch',
  // MVR node types, which `import/mvr.ts` stamps on every node it produces. In a
  // visualiser model the node type is the reliable signal and the name is not — a truss is
  // as likely to be called "Sunstrip 12" as "TRUSS 1". `truss`, `rigging` and `hoist`
  // above already cover the rest of what MVR calls infrastructure.
  //
  // MVR's `VideoScreen` is deliberately absent, and so is a bare `screen`: an LED wall is
  // a large rigid reflector and belongs in the prediction as a surface, not in the bin.
  'fixture', 'fixtures', 'projector', 'projectors',
  'drape', 'drapes', 'curtain', 'curtains', 'legs', 'border', 'borders',
  // Services
  'cable', 'cables', 'cabling', 'conduit', 'tray', 'trunking',
  'hvac', 'duct', 'ducts', 'ductwork', 'pipe', 'pipes', 'pipework', 'plumbing',
  'sprinkler', 'sprinklers', 'drainage', 'services', 'electrical', 'socket', 'sockets',
  // Contents
  'furniture', 'furn', 'planting', 'tree', 'trees', 'shrub', 'shrubs',
  'person', 'people', 'figure', 'figures', 'mannequin', 'manikin',
  'loudspeaker', 'loudspeakers', 'speaker', 'speakers',
  'handrail', 'handrails', 'balustrade', 'railing', 'railings',
]

/**
 * Audience.
 *
 * The strong words only. This category does more than exclude something — it asserts that a
 * scattering of separate objects stands for one plane, which is the biggest claim this pass
 * makes, so a word earns its place here only if it means seating and nothing else. `tier`,
 * `circle` and `gallery` are all seating in a British theatre and all ordinary geometry
 * words elsewhere, so they are left out and caught by repetition instead (`plan.ts`).
 */
const SEATING = [
  'seat', 'seats', 'seating', 'chair', 'chairs',
  'stall', 'stalls', 'audience', 'spectator', 'spectators',
  'bench', 'benches', 'pew', 'pews',
  'bleacher', 'bleachers', 'grandstand', 'tribune', 'auditorium',
]

const STAGE = ['stage', 'apron', 'thrust', 'rostrum', 'rostra', 'riser', 'risers', 'podium', 'catwalk']
const CEILING = ['ceiling', 'ceilings', 'soffit', 'soffits', 'roof', 'canopy']
const WALL = ['wall', 'walls', 'partition', 'partitions', 'proscenium', 'cladding']
const FLOOR = ['floor', 'floors', 'flooring', 'ground', 'slab', 'terrain']

/**
 * Order matters. Clutter first, seating last.
 *
 * **Clutter first** because `STAGE LIGHTING` is a lighting bar over a stage, not a stage,
 * and `SEATING DIMENSIONS` is a dimension string, not an audience. In both, the clutter
 * word is the one that says what the object is FOR. Getting that backwards imports a
 * lighting rig as a stage deck, which is worse than leaving something out: leaving
 * something out is visible in the tree, and putting something wrong in is not.
 *
 * **Seating last** because it claims the most — it is the category that turns hundreds of
 * objects into one fitted plane — so it should win only when nothing else in the name
 * disagrees. `FLOOR - STALLS` is the raked floor under the stalls and it is a floor;
 * reading it as seating fits an audience plane through the concrete. A name that says
 * seating and nothing else still reads as seating, which is the case that matters.
 */
const CATEGORIES: [Category, string[]][] = [
  ['clutter', CLUTTER],
  ['stage', STAGE],
  ['ceiling', CEILING],
  ['wall', WALL],
  ['floor', FLOOR],
  ['seating', SEATING],
]

const LOOKUP = new Map<string, Category>()
for (const [category, words] of CATEGORIES) {
  // First list wins, so a word appearing twice keeps its highest-priority meaning rather
  // than whichever list happened to be declared last.
  for (const w of words) if (!LOOKUP.has(w)) LOOKUP.set(w, category)
}

/**
 * A name into the words it is made of. Case and punctuation go.
 *
 * camelCase is split as well as punctuation, because the two places names arrive without
 * spaces are both ones this has to read: an IFC entity type (`IfcFurniture`, `IfcSlab`) and
 * a modeller's object name (`SeatBack`, `TrussSection`). Splitting only on punctuation
 * leaves those as one unrecognisable word.
 */
export function tokens(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
}

/**
 * The category a name and its tags fall into, or null when they say nothing.
 *
 * Tags are read as well as the name because that is where a DXF layer and an IFC entity
 * type end up (`import/types.ts`), and an IFC model's node names are often GUIDs while the
 * tag says `IfcSlab`. Priority is by category, not by which string matched: a name of
 * `SEATING` and a tag of `DIMENSIONS` is clutter either way round, so the answer does not
 * depend on the order the importer happened to write the tags in.
 */
export function categorise(name: string, tags: string[] = []): Category | null {
  const seen = new Set<Category>()
  for (const source of [name, ...tags]) {
    for (const t of tokens(source)) {
      const c = LOOKUP.get(t)
      if (c) seen.add(c)
    }
  }
  if (seen.size === 0) return null
  for (const [category] of CATEGORIES) if (seen.has(category)) return category
  return null
}

/** The plane type a category implies. Null where the category only decides inclusion. */
export const CATEGORY_HINT: Record<Category, string> = {
  clutter: 'not a room surface',
  seating: 'audience',
  stage: 'stage',
  ceiling: 'ceiling',
  wall: 'wall',
  floor: 'floor',
}
