/**
 * App state and the derived-conversion hook.
 *
 * One rule: the imported scene is immutable. Every user decision — include, plane type,
 * rename — lives in a separate per-node record keyed by node id, and conversion is a pure
 * function of (scene, decisions, options). Nothing is destructive, so changing the unit
 * setting after an hour of pruning does not throw the pruning away.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { PlaneType } from './lib/dbacv/types.ts'
import { type ImportedNode, type ImportedScene, flattenNodes } from './lib/import/index.ts'
import {
  type AreaEntry,
  type ConvertOptions,
  type ConvertResult,
  type FitMode,
  DEFAULT_CONVERT,
  convertNodes,
} from './lib/geom/convert.ts'
import { type PlanarizeOptions, DEFAULT_PLANARIZE } from './lib/geom/planarize.ts'
import type { Pt2 } from './lib/geom/polygon.ts'
import {
  type CaptureFaces,
  type OutlineMode,
  type RationaliseStats,
  DEFAULT_RATIONALISE,
  rationalise,
} from './lib/geom/rationalise.ts'
import {
  type PrepareOptions,
  type PreparePlan,
  type SimplifyStats,
  DEFAULT_PREPARE,
  DEFAULT_SIMPLIFY,
  EMPTY_PLAN,
  preparePlan,
  simplifyScene,
} from './lib/prepare/index.ts'
import { type TransformOptions, boundsOf, guessUnits } from './lib/geom/transform.ts'

export interface NodeDecision {
  include: boolean
  planeType: PlaneType
  name: string
}

export type Decisions = Record<string, NodeDecision>

/**
 * A user's assertion that scattered surfaces stand for one surface.
 *
 * A DECISION, not a scene edit — the same rule as `Decisions` above and for the same
 * reason. The outlines are recomputed from the source geometry on every conversion, so
 * changing the units or the heading afterwards moves a rationalised seating area with the
 * rest of the room, and deleting the record brings the four hundred seats back.
 */
export interface Rationalisation {
  id: string
  name: string
  planeType: PlaneType
  /** Nodes whose geometry is captured. */
  memberIds: string[]
  /** Venue-XY polygon. Set when the area was drawn; clips the capture in every mode. */
  footprint?: Pt2[]
  faces: CaptureFaces
  gapMetres: number
  mode: OutlineMode
  /**
   * Drop the member nodes from the ordinary conversion.
   *
   * On by default because it is the entire point: rationalising four hundred seats and
   * then exporting the seats as well leaves four hundred objects in the venue. Off is for
   * checking the new plane against the geometry it came from before committing to it.
   */
  replaceMembers: boolean
}

export type ViewMode = 'source' | 'converted' | 'both'

export interface Settings {
  transform: TransformOptions
  planarize: PlanarizeOptions
  simplifyTolerance: number
  fit: FitMode
  maxObjectsPerNode: number
}

export const DEFAULT_SETTINGS: Settings = {
  transform: { ...DEFAULT_CONVERT.transform },
  planarize: { ...DEFAULT_PLANARIZE },
  simplifyTolerance: DEFAULT_CONVERT.simplifyTolerance,
  fit: 'exact',
  maxObjectsPerNode: 0,
}

/**
 * Seed a decision for every node.
 *
 * Default: include leaf nodes that actually carry geometry, and take the importer's plane
 * type suggestion when it made one. A node with no triangles is a container; including it
 * would emit an empty group.
 */
export function seedDecisions(scene: ImportedScene): Decisions {
  const out: Decisions = {}
  for (const n of flattenNodes(scene.nodes)) {
    out[n.id] = {
      include: n.positions.length > 0,
      planeType: n.suggestedPlaneType ?? PlaneType.Listening,
      name: n.name,
    }
  }
  return out
}

/**
 * Re-seed decisions for a scene that is still being edited.
 *
 * `seedDecisions` is right for a file, which arrives once and does not change. A traced
 * drawing does: every corner dragged rebuilds the scene, and re-seeding it would throw
 * away the include and plane-type choices already made. Existing ids keep their decision;
 * only the name is refreshed, because a traced region is renamed on the drawing rather
 * than in the tree.
 */
export function mergeDecisions(prev: Decisions, scene: ImportedScene): Decisions {
  const out: Decisions = {}
  for (const n of flattenNodes(scene.nodes)) {
    const old = prev[n.id]
    out[n.id] = old
      ? { ...old, name: n.name }
      : {
          include: n.positions.length > 0,
          planeType: n.suggestedPlaneType ?? PlaneType.Listening,
          name: n.name,
        }
  }
  return out
}

/**
 * Preparation: the checkboxes, and what one run of them produced.
 *
 * `simplifyHeavy` sits beside the plan's options rather than inside them because it is the
 * one that changes GEOMETRY rather than decisions — see `lib/prepare/simplify.ts`. It is
 * also the reason a `Prepared` keeps the scene it made: re-running with the box unticked
 * has to go back to the file as imported, so the raw scene is kept beside the prepared one.
 */
export interface PrepareSettings extends PrepareOptions {
  simplifyHeavy: boolean
}

export const DEFAULT_PREPARE_SETTINGS: PrepareSettings = { ...DEFAULT_PREPARE, simplifyHeavy: true }

export interface Prepared {
  /** The scene as the importer produced it. Kept so preparation can be re-run or undone. */
  raw: ImportedScene
  /** What the app works in: `raw`, re-cut if `simplifyHeavy` was on. */
  scene: ImportedScene
  plan: PreparePlan
  simplify: SimplifyStats | null
  options: PrepareSettings
  /**
   * The transform the plan was decided against.
   *
   * Recorded because a plan's thresholds are in metres and the unit setting behind them may
   * have been a guess. Showing what it assumed is what makes "re-run" a meaningful offer
   * rather than a mystery button.
   */
  transform: TransformOptions
}

/**
 * Run preparation over a freshly imported scene.
 *
 * The order is deliberate: re-cut first, then read. Both halves are independent — the plan
 * reads names, sizes and spacings, none of which a re-cut changes — but running the plan on
 * the smaller scene keeps every id it hands back pointing at the nodes the app will actually
 * be holding.
 */
export function prepareScene(
  raw: ImportedScene,
  transform: TransformOptions,
  options: PrepareSettings,
): Prepared {
  // A file that is already a venue is left exactly as its author built it. See
  // `ImportedScene.alreadyAVenue` — there is nothing here to improve on, and plenty to
  // damage.
  if (raw.alreadyAVenue) {
    return { raw, scene: raw, plan: EMPTY_PLAN, simplify: null, options, transform }
  }

  const simplified = options.simplifyHeavy
    ? simplifyScene(raw, transform, DEFAULT_SIMPLIFY)
    : { scene: raw, stats: null }
  const scene = simplified.scene
  return {
    raw,
    scene,
    plan: preparePlan(scene, transform, options),
    simplify: simplified.stats,
    options,
    transform,
  }
}

/** Fold a plan's exclusions and plane types into the seeded decisions. */
export function applyPlan(decisions: Decisions, plan: PreparePlan | null): Decisions {
  if (!plan) return decisions
  const out: Decisions = {}
  for (const [id, d] of Object.entries(decisions)) {
    out[id] = {
      ...d,
      include: d.include && !plan.exclude.has(id),
      planeType: plan.planeTypes.get(id) ?? d.planeType,
    }
  }
  return out
}

/**
 * The rationalisations a plan asks for.
 *
 * Ordinary ones in every respect — the same record the panel edits and the same one the
 * user makes by hand — so a prepared seating area can be renamed, re-typed, loosened,
 * tightened or deleted exactly like a drawn one. The `prep` id prefix only keeps them from
 * colliding with the panel's own counter.
 */
export function rationalisationsFromPlan(plan: PreparePlan | null): Rationalisation[] {
  if (!plan) return []
  return plan.seating.map((c, i) => ({
    ...newRationalisation(`prep${i + 1}`, c.name, c.memberIds),
    gapMetres: c.gapMetres,
  }))
}

/** Settings the importer can decide for us, so the user starts from the file's own facts. */
export function settingsForScene(scene: ImportedScene): Settings {
  const bounds = boundsOf(scene.nodes)
  return {
    ...DEFAULT_SETTINGS,
    transform: {
      ...DEFAULT_SETTINGS.transform,
      unitsPerMetre: scene.unitsPerMetre ?? (bounds ? guessUnits(bounds) : 1),
      upAxis: scene.upAxis ?? 'z',
    },
  }
}

/**
 * Debounce a value, but adopt it immediately when `key` changes.
 *
 * The key is the loaded scene. Without the flush, the 250 ms after an import would
 * convert the NEW model using the PREVIOUS file's units and datum — briefly showing a
 * metre-scale room interpreted as millimetres, which looks like a units bug in the
 * importer rather than a stale frame.
 */
export function useDebounced<T>(value: T, ms: number, key?: unknown): T {
  const [v, setV] = useState(value)
  const lastKey = useRef(key)

  if (lastKey.current !== key) {
    lastKey.current = key
    if (v !== value) setV(value)
  }

  useEffect(() => {
    const t = setTimeout(() => setV(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])

  return v
}

/**
 * The per-node decisions a converter consumes.
 *
 * Shared by the live ArrayCalc conversion and by every export, so that what a user sees on
 * screen and what lands in the file cannot drift apart.
 */
export function conversionEntries(
  scene: ImportedScene,
  decisions: Decisions,
  rationalisations: Rationalisation[] = [],
): { node: ImportedNode; planeType: PlaneType; include: boolean; name: string }[] {
  const replaced = replacedNodeIds(rationalisations)
  return flattenNodes(scene.nodes)
    .filter((n) => n.positions.length > 0)
    .map((n) => {
      const d = decisions[n.id]
      return {
        node: n,
        planeType: d?.planeType ?? PlaneType.Listening,
        // A node stood in for by a rationalisation must not also be converted on its own,
        // or the venue gets the new plane AND the four hundred seats it replaced.
        include: (d?.include ?? false) && !replaced.has(n.id),
        name: d?.name ?? n.name,
      }
    })
}

/**
 * Nodes that a rationalisation is standing in for, and which therefore go out of the venue.
 *
 * Only ever handed the rationalisations that actually PRODUCED something — see
 * `rationalisedAreas`. A rationalisation that captured nothing stands in for nothing, and
 * letting it replace its members would take a seating block out of the venue and put
 * nothing back.
 */
export function replacedNodeIds(rationalisations: Rationalisation[]): Set<string> {
  const out = new Set<string>()
  for (const r of rationalisations) {
    if (!r.replaceMembers) continue
    for (const id of r.memberIds) out.add(id)
  }
  return out
}

export function newRationalisation(id: string, name: string, memberIds: string[]): Rationalisation {
  return {
    id,
    name,
    planeType: PlaneType.Listening,
    memberIds,
    faces: DEFAULT_RATIONALISE.faces,
    gapMetres: DEFAULT_RATIONALISE.gapMetres,
    mode: DEFAULT_RATIONALISE.mode,
    replaceMembers: true,
  }
}

export interface RationalisedArea extends AreaEntry {
  id: string
  stats: RationaliseStats
}

/**
 * Run every rationalisation against the current scene and settings.
 *
 * Done once and handed to both output targets, so what is on screen, what lands in the
 * `.dbacv` and what lands in the Soundvision `.txt` cannot disagree.
 */
export function rationalisedAreas(
  scene: ImportedScene,
  rationalisations: Rationalisation[],
  settings: Settings,
): { areas: RationalisedArea[]; warnings: string[]; effective: Rationalisation[] } {
  const byId = new Map(flattenNodes(scene.nodes).map((n) => [n.id, n]))
  const areas: RationalisedArea[] = []
  const warnings: string[] = []
  const effective: Rationalisation[] = []

  for (const r of rationalisations) {
    const members = r.memberIds.map((id) => byId.get(id)).filter((n): n is ImportedNode => !!n)
    if (members.length === 0) continue

    // A Positioning area must be rectangular — ArrayCalc refuses anything else, and both
    // of the answers its dialog offers damage the venue. Same forcing as `convertNode`.
    const mustBeRectangular = r.planeType === PlaneType.PositioningArea
    const mode = mustBeRectangular ? 'rect' : r.mode
    if (mustBeRectangular && r.mode !== 'rect') {
      warnings.push(
        `"${r.name}" is a Positioning area, which ArrayCalc requires to be rectangular, so it was squared off regardless of the outline setting.`,
      )
    }

    const result = rationalise(members, r.name, {
      ...DEFAULT_RATIONALISE,
      transform: settings.transform,
      faces: r.faces,
      gapMetres: r.gapMetres,
      mode,
      footprint: r.footprint,
      simplifyTolerance: settings.simplifyTolerance,
      minArea: settings.planarize.minArea,
    })

    warnings.push(...result.warnings)
    if (result.stats.trianglesOutside > 0 && r.replaceMembers) {
      warnings.push(
        `"${r.name}" replaces its source objects, but ${result.stats.trianglesOutside} of their triangles fall outside the drawn area and are not represented by it. Draw an area for those too, or turn off "replace originals".`,
      )
    }
    if (result.outlines.length === 0) {
      // Nothing came out. Say so where the consequence is, not only in the geometry
      // warnings: the members are staying in the venue, which is the opposite of what
      // "replace the originals" was asked to do, and the object count will show it.
      if (r.replaceMembers) {
        warnings.push(
          `"${r.name}" produced no area, so the objects it was meant to replace were left in the venue rather than removed.`,
        )
      }
      continue
    }

    effective.push(r)
    areas.push({ id: r.id, name: r.name, planeType: r.planeType, outlines: result.outlines, stats: result.stats })
  }

  return { areas, warnings, effective }
}

/** Settings -> the options every target's reduction takes. */
export function convertOptions(settings: Settings): ConvertOptions {
  return {
    transform: settings.transform,
    planarize: settings.planarize,
    simplifyTolerance: settings.simplifyTolerance,
    fit: settings.fit,
    maxObjectsPerNode: settings.maxObjectsPerNode,
  }
}

/**
 * Run the conversion whenever the inputs settle.
 *
 * Debounced because dragging a tolerance slider would otherwise re-planarise a 50,000
 * triangle model on every pixel of movement. This is synchronous and does block the main
 * thread on a big model; the UI says so rather than pretending otherwise.
 */
export function useConversion(
  scene: ImportedScene | null,
  decisions: Decisions,
  settings: Settings | null,
  rationalisations: Rationalisation[] = [],
): { result: ConvertResult | null; areas: RationalisedArea[]; running: boolean } {
  const debouncedSettings = useDebounced(settings, 250, scene)
  const debouncedDecisions = useDebounced(decisions, 250, scene)
  const debouncedRats = useDebounced(rationalisations, 250, scene)
  const settled =
    debouncedSettings === settings &&
    debouncedDecisions === decisions &&
    debouncedRats === rationalisations
  const [running, setRunning] = useState(false)
  const firstRun = useRef(true)

  const { result, areas } = useMemo(() => {
    // The debounced settings lag the scene by one debounce interval, so on the render
    // right after an import they still describe the PREVIOUS file — or, on the first
    // import, nothing at all. Converting against those is meaningless and, with no
    // transform to read, throws. Wait for them to catch up.
    if (!scene || !debouncedSettings?.transform) return { result: null, areas: [] as RationalisedArea[] }
    const r = rationalisedAreas(scene, debouncedRats, debouncedSettings)
    const converted = convertNodes(
      conversionEntries(scene, debouncedDecisions, r.effective),
      convertOptions(debouncedSettings),
      r.areas,
    )
    converted.warnings.push(...r.warnings)
    return { result: converted, areas: r.areas }
  }, [scene, debouncedDecisions, debouncedSettings, debouncedRats])

  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false
      return
    }
    setRunning(!settled)
  }, [settled])

  return { result, areas, running: running && !settled }
}

/**
 * Rationalisations, keyed by id, with the same immutability rule as `useDecisions`.
 *
 * Reset on a new scene: a rationalisation names node ids, and the ids in the next file mean
 * something else entirely. Reset TO `seed` rather than to nothing, because preparation
 * arrives with a set of them — and through a ref, so a render passing an equal seed does
 * not re-seed over work already done to it.
 *
 * `resetOn` is the thing that means "start again", and it is NOT the scene. Re-running
 * preparation with a box unticked usually hands back the very same scene object — nothing
 * about the geometry changed, only what was decided about it — and keying this on the scene
 * left the audience planes standing after the box that made them was cleared.
 */
export function useRationalisations(resetOn: unknown, seed: Rationalisation[] = []) {
  const [rationalisations, setRationalisations] = useState<Rationalisation[]>([])
  const seedRef = useRef(seed)
  seedRef.current = seed

  useEffect(() => {
    setRationalisations(seedRef.current)
  }, [resetOn])

  const add = useCallback((r: Rationalisation) => {
    setRationalisations((prev) => [...prev, r])
  }, [])

  const update = useCallback((id: string, patch: Partial<Rationalisation>) => {
    setRationalisations((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)))
  }, [])

  const remove = useCallback((id: string) => {
    setRationalisations((prev) => prev.filter((r) => r.id !== id))
  }, [])

  return { rationalisations, add, update, remove, setRationalisations }
}

/** Walk a node subtree, for "apply to all children". */
export function subtreeIds(node: ImportedNode): string[] {
  const out: string[] = []
  const walk = (n: ImportedNode) => {
    out.push(n.id)
    n.children.forEach(walk)
  }
  walk(node)
  return out
}

export function useDecisions(scene: ImportedScene | null) {
  const [decisions, setDecisions] = useState<Decisions>({})

  useEffect(() => {
    setDecisions(scene ? seedDecisions(scene) : {})
  }, [scene])

  const update = useCallback((ids: string[], patch: Partial<NodeDecision>) => {
    setDecisions((prev) => {
      const next = { ...prev }
      for (const id of ids) {
        if (next[id]) next[id] = { ...next[id], ...patch }
      }
      return next
    })
  }, [])

  return { decisions, update, setDecisions }
}
