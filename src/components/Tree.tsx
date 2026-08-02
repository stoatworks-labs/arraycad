/**
 * The object tree: where pruning happens.
 *
 * Shows the source model's own hierarchy — DXF and DWG layers, glTF node names, IFC entity
 * types — because those are the names the user already thinks in. A checkbox per row
 * includes or excludes; the plane type is set here or in the inspector.
 *
 * Two things stop that from working on a real venue, and both are handled by `lib/grouping`:
 * a `.dbacv` names every group after its own GUID, so a dozen rows read identically until
 * you open each one; and a DXF, a DWG or a flat glTF export has no groups at all, just a
 * long list of siblings. Derived labels fix the first, synthetic groups the second.
 *
 * **Every row that stands for more than one object carries a tri-state checkbox that
 * applies to all of them.** That is the whole point of grouping here — a venue is pruned by
 * throwing away categories, not objects one at a time.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { PLANE_TYPES, PlaneType } from '../lib/dbacv/types.ts'
import type { ImportedNode } from '../lib/import/index.ts'
import { autoGroup, deriveLabel, isUninformativeName } from '../lib/grouping.ts'
import type { Decisions } from '../state.ts'
import { PLANE_UI_COLOUR as PLANE_DOT } from './planeColours.ts'

export type GroupMode = 'auto' | 'type' | 'none'

interface Props {
  nodes: ImportedNode[]
  decisions: Decisions
  selection: string[]
  onSelect: (id: string, additive: boolean) => void
  onUpdate: (ids: string[], patch: { include?: boolean; planeType?: PlaneType; name?: string }) => void
  subtreeIds: (n: ImportedNode) => string[]
}

function triCount(n: ImportedNode): number {
  let t = n.positions.length / 9
  for (const c of n.children) t += triCount(c)
  return t
}

/**
 * Ids under `node` that actually carry triangles.
 *
 * Include is only meaningful for those: a container is not exported, it is a place where
 * its children live, and marking one included would put an empty group in the venue.
 */
function geomIds(node: ImportedNode, out: string[] = []): string[] {
  if (node.positions.length > 0) out.push(node.id)
  for (const c of node.children) geomIds(c, out)
  return out
}

/** The label a row should show: the node's own name, or one read off its children. */
function labelFor(node: ImportedNode, decisions: Decisions): string {
  const chosen = decisions[node.id]?.name
  if (chosen && !isUninformativeName(chosen)) return chosen
  if (node.children.length > 0) {
    const derived = deriveLabel(node.children.map((c) => decisions[c.id]?.name ?? c.name))
    if (derived) return derived
  }
  return chosen ?? node.name
}

/** How many of `ids` are included: none, some or all. */
function includeState(ids: string[], decisions: Decisions): 'none' | 'some' | 'all' {
  if (ids.length === 0) return 'none'
  let on = 0
  for (const id of ids) if (decisions[id]?.include) on++
  return on === 0 ? 'none' : on === ids.length ? 'all' : 'some'
}

/** A checkbox that can show "some of the things below this are on". */
function TriCheckbox({
  state,
  onChange,
  title,
}: {
  state: 'none' | 'some' | 'all'
  onChange: (next: boolean) => void
  title?: string
}) {
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    // `indeterminate` is not an attribute; it can only be set on the DOM node.
    if (ref.current) ref.current.indeterminate = state === 'some'
  }, [state])

  return (
    <input
      ref={ref}
      type="checkbox"
      checked={state === 'all'}
      onClick={(e) => e.stopPropagation()}
      // A partly-on group turns fully on, which is what "click the box" means everywhere
      // else. Turning it off from there would throw away choices the user just made.
      onChange={() => onChange(state !== 'all')}
      title={title}
    />
  )
}

const matchesFilter = (node: ImportedNode, decisions: Decisions, filter: string): boolean => {
  if (!filter) return true
  const f = filter.toLowerCase()
  const hit = (n: ImportedNode): boolean =>
    (decisions[n.id]?.name ?? n.name).toLowerCase().includes(f) || n.children.some(hit)
  return hit(node)
}

function Row({
  node,
  depth,
  props,
  filter,
  mode,
  defaultOpen,
}: {
  node: ImportedNode
  depth: number
  props: Props
  filter: string
  mode: GroupMode
  defaultOpen: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
  const d = props.decisions[node.id]
  const selected = props.selection.includes(node.id)
  const tris = triCount(node)
  const ids = useMemo(() => geomIds(node), [node])
  const state = includeState(ids, props.decisions)

  if (!matchesFilter(node, props.decisions, filter)) return null

  const isContainer = node.children.length > 0

  return (
    <>
      <div
        className={`tree-row${selected ? ' selected' : ''}${state === 'none' ? ' excluded' : ''}`}
        style={{ paddingLeft: 6 + depth * 14 }}
        onClick={(e) => props.onSelect(node.id, e.shiftKey || e.metaKey)}
      >
        <button
          type="button"
          className="twisty"
          onClick={(e) => {
            e.stopPropagation()
            setOpen((o) => !o)
          }}
          style={{ visibility: isContainer ? 'visible' : 'hidden' }}
          aria-label={open ? 'Collapse' : 'Expand'}
        >
          {open ? '▾' : '▸'}
        </button>

        <TriCheckbox
          state={state}
          onChange={(next) => props.onUpdate(ids, { include: next })}
          title={
            ids.length === 0
              ? 'Nothing under here has any geometry'
              : isContainer
                ? `Include or exclude all ${ids.length} objects under this`
                : undefined
          }
        />

        <span
          className="dot"
          style={{ background: d && !isContainer ? PLANE_DOT[d.planeType] : 'transparent' }}
          title={PLANE_TYPES.find((p) => p.code === d?.planeType)?.label}
        />

        <span className="tree-name" title={node.tags.join(' · ') || node.name}>
          {labelFor(node, props.decisions)}
        </span>

        <span className="tree-count">{tris.toLocaleString()}</span>
      </div>

      {open && (
        <Level
          nodes={node.children}
          depth={depth + 1}
          props={props}
          filter={filter}
          mode={mode}
          defaultOpen={defaultOpen}
        />
      )}
    </>
  )
}

/** A synthesised group: a header row plus the nodes it stands for. */
function GroupRow({
  label,
  nodes,
  depth,
  props,
  filter,
  mode,
  defaultOpen,
}: {
  label: string
  nodes: ImportedNode[]
  depth: number
  props: Props
  filter: string
  mode: GroupMode
  defaultOpen: boolean
}) {
  const [open, setOpen] = useState(false)
  const ids = useMemo(() => nodes.flatMap((n) => geomIds(n)), [nodes])
  const state = includeState(ids, props.decisions)
  const tris = useMemo(() => nodes.reduce((t, n) => t + triCount(n), 0), [nodes])

  const visible = nodes.filter((n) => matchesFilter(n, props.decisions, filter))
  if (visible.length === 0) return null
  // A search is a request to see the matches, not to go hunting for them behind a twisty.
  const expanded = open || filter !== ''

  return (
    <>
      <div
        className={`tree-row tree-group${state === 'none' ? ' excluded' : ''}`}
        style={{ paddingLeft: 6 + depth * 14 }}
        onClick={() => setOpen((o) => !o)}
      >
        <button
          type="button"
          className="twisty"
          onClick={(e) => {
            e.stopPropagation()
            setOpen((o) => !o)
          }}
          aria-label={expanded ? 'Collapse' : 'Expand'}
          aria-expanded={expanded}
        >
          {expanded ? '▾' : '▸'}
        </button>

        <TriCheckbox
          state={state}
          onChange={(next) => props.onUpdate(ids, { include: next })}
          title={`Include or exclude all ${ids.length} objects in ${label}`}
        />

        <span className="tree-name">{label}</span>
        <span className="tree-group-n">{visible.length}</span>
        <span className="tree-count">{tris.toLocaleString()}</span>
      </div>

      {expanded &&
        visible.map((n) => (
          <Row
            key={n.id}
            node={n}
            depth={depth + 1}
            props={props}
            filter={filter}
            mode={mode}
            defaultOpen={defaultOpen}
          />
        ))}
    </>
  )
}

/** One sibling list, grouped or not. */
function Level({
  nodes,
  depth,
  props,
  filter,
  mode,
  defaultOpen,
}: {
  nodes: ImportedNode[]
  depth: number
  props: Props
  filter: string
  mode: GroupMode
  defaultOpen: boolean
}) {
  // Grouping reads NAMES and nothing else, but `decisions` also carries include and plane
  // type, which change on every click. Keying the memo on the whole record would re-group
  // the level on each one — fine for a theatre, but quadratic-ish work on a flat export
  // with thousands of siblings, on the hot path of ticking a box.
  const nameKey = useMemo(
    () =>
      nodes
        .map((n) => `${labelFor(n, props.decisions)}${n.id}`)
        .join(' '),
    [nodes, props.decisions],
  )

  const grouped = useMemo(() => {
    if (mode !== 'auto') return null
    // Where the file already organised itself, leave it organised. A `.dbacv` arrives as a
    // dozen real groups whose names happen to be GUIDs; the fix for that is to label them
    // (`labelFor`), not to shuffle them into synthetic groups of groups.
    const containers = nodes.filter((n) => n.children.length > 0).length
    if (containers * 2 >= nodes.length) return null
    // Grouped on what the row SHOWS, not on the raw name — otherwise a dozen groups all
    // called `RoomObjectGroup: {guid}` cluster into one bucket named after the noise.
    const labels = new Map(nodes.map((n) => [n, labelFor(n, props.decisions)]))
    return autoGroup(nodes, (n) => labels.get(n) ?? n.name)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, nodes, nameKey])

  if (!grouped || grouped.groups.length === 0) {
    return (
      <>
        {nodes.map((n) => (
          <Row
            key={n.id}
            node={n}
            depth={depth}
            props={props}
            filter={filter}
            mode={mode}
            defaultOpen={defaultOpen}
          />
        ))}
      </>
    )
  }

  return (
    <>
      {grouped.groups.map((g) => (
        <GroupRow
          key={g.key}
          label={g.label}
          nodes={g.items}
          depth={depth}
          props={props}
          filter={filter}
          mode={mode}
          defaultOpen={defaultOpen}
        />
      ))}
      {grouped.loose.map((n) => (
        <Row
          key={n.id}
          node={n}
          depth={depth}
          props={props}
          filter={filter}
          mode={mode}
          defaultOpen={defaultOpen}
        />
      ))}
    </>
  )
}

/**
 * Everything with geometry, bucketed by the plane type it will be exported as.
 *
 * A different question from the tree's: not "what is this object" but "what have I said
 * everything is". Checking that before export is how a mis-typed balcony gets caught, and
 * the source hierarchy actively hides it.
 */
function ByPlaneType({ props, filter, defaultOpen }: { props: Props; filter: string; defaultOpen: boolean }) {
  const buckets = useMemo(() => {
    const out = new Map<PlaneType, ImportedNode[]>()
    const walk = (ns: ImportedNode[]) => {
      for (const n of ns) {
        if (n.positions.length > 0) {
          const t = props.decisions[n.id]?.planeType ?? PlaneType.Listening
          const b = out.get(t)
          if (b) b.push(n)
          else out.set(t, [n])
        }
        walk(n.children)
      }
    }
    walk(props.nodes)
    return [...out].sort((a, b) => a[0] - b[0])
  }, [props.nodes, props.decisions])

  return (
    <>
      {buckets.map(([type, nodes]) => (
        <GroupRow
          key={type}
          label={PLANE_TYPES.find((p) => p.code === type)?.label ?? `Type ${type}`}
          nodes={nodes}
          depth={0}
          props={props}
          filter={filter}
          mode="none"
          defaultOpen={defaultOpen}
        />
      ))}
    </>
  )
}

export function Tree(props: Props) {
  const [filter, setFilter] = useState('')
  const [mode, setMode] = useState<GroupMode>('auto')

  const all = useMemo(() => props.nodes.flatMap((n) => props.subtreeIds(n)), [props.nodes, props.subtreeIds])
  const withGeom = useMemo(() => props.nodes.flatMap((n) => geomIds(n)), [props.nodes])
  const included = withGeom.filter((id) => props.decisions[id]?.include).length

  // A small model is easier to read opened out. A venue is not: now that every row carries
  // a real label and a count, a closed tree of a dozen named groups says more at a glance
  // than a hundred rows of seating blocks does.
  const defaultOpen = all.length <= 24

  return (
    <div className="tree">
      <div className="tree-toolbar">
        <input
          type="search"
          placeholder="Filter by name…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <button type="button" onClick={() => props.onUpdate(withGeom, { include: true })}>
          All
        </button>
        <button type="button" onClick={() => props.onUpdate(all, { include: false })}>
          None
        </button>
        <button
          type="button"
          onClick={() => {
            for (const id of withGeom) {
              props.onUpdate([id], { include: !props.decisions[id]?.include })
            }
          }}
        >
          Invert
        </button>
      </div>

      <div className="tree-toolbar tree-toolbar-group">
        <label htmlFor="tree-group-mode">Group by</label>
        <select
          id="tree-group-mode"
          value={mode}
          onChange={(e) => setMode(e.target.value as GroupMode)}
        >
          <option value="auto">Name (automatic)</option>
          <option value="type">Plane type</option>
          <option value="none">Nothing — full tree</option>
        </select>
      </div>

      <div className="tree-scroll">
        {mode === 'type' ? (
          <ByPlaneType props={props} filter={filter} defaultOpen={defaultOpen} />
        ) : (
          <Level
            nodes={props.nodes}
            depth={0}
            props={props}
            filter={filter}
            mode={mode}
            defaultOpen={defaultOpen}
          />
        )}
      </div>

      <div className="tree-foot">
        {included} of {withGeom.length} objects included
      </div>
    </div>
  )
}
