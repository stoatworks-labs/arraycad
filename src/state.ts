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
  type ConvertOptions,
  type ConvertResult,
  type FitMode,
  DEFAULT_CONVERT,
  convertNodes,
} from './lib/geom/convert.ts'
import { type PlanarizeOptions, DEFAULT_PLANARIZE } from './lib/geom/planarize.ts'
import { type TransformOptions, boundsOf, guessUnits } from './lib/geom/transform.ts'

export interface NodeDecision {
  include: boolean
  planeType: PlaneType
  name: string
}

export type Decisions = Record<string, NodeDecision>

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
): { result: ConvertResult | null; running: boolean } {
  const debouncedSettings = useDebounced(settings, 250, scene)
  const debouncedDecisions = useDebounced(decisions, 250, scene)
  const settled = debouncedSettings === settings && debouncedDecisions === decisions
  const [running, setRunning] = useState(false)
  const firstRun = useRef(true)

  const result = useMemo(() => {
    // The debounced settings lag the scene by one debounce interval, so on the render
    // right after an import they still describe the PREVIOUS file — or, on the first
    // import, nothing at all. Converting against those is meaningless and, with no
    // transform to read, throws. Wait for them to catch up.
    if (!scene || !debouncedSettings?.transform) return null
    const opts: ConvertOptions = {
      transform: debouncedSettings.transform,
      planarize: debouncedSettings.planarize,
      simplifyTolerance: debouncedSettings.simplifyTolerance,
      fit: debouncedSettings.fit,
      maxObjectsPerNode: debouncedSettings.maxObjectsPerNode,
    }
    const entries = flattenNodes(scene.nodes)
      .filter((n) => n.positions.length > 0)
      .map((n) => {
        const d = debouncedDecisions[n.id]
        return {
          node: n,
          planeType: d?.planeType ?? PlaneType.Listening,
          include: d?.include ?? false,
          name: d?.name ?? n.name,
        }
      })
    return convertNodes(entries, opts)
  }, [scene, debouncedDecisions, debouncedSettings])

  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false
      return
    }
    setRunning(!settled)
  }, [settled])

  return { result, running: running && !settled }
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
