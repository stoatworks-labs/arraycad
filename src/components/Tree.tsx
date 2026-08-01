/**
 * The object tree: where pruning happens.
 *
 * Shows the source model's own hierarchy — DXF layers, glTF node names, IFC entity types —
 * because those are the names the user already thinks in. A checkbox per node includes or
 * excludes it; the plane type is set here or in the inspector.
 */

import { useMemo, useState } from 'react'
import { PLANE_TYPES, PlaneType } from '../lib/dbacv/types.ts'
import type { ImportedNode } from '../lib/import/index.ts'
import type { Decisions } from '../state.ts'

const PLANE_DOT: Record<number, string> = {
  [PlaneType.None]: '#8899aa',
  [PlaneType.Audience]: '#f0a04b',
  [PlaneType.Surface]: '#5ec98a',
  [PlaneType.Unknown3]: '#999999',
  [PlaneType.Stage]: '#b07be0',
  [PlaneType.Soundscape]: '#00c0ae',
}

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

function Row({
  node,
  depth,
  props,
  filter,
}: {
  node: ImportedNode
  depth: number
  props: Props
  filter: string
}) {
  const [open, setOpen] = useState(depth < 2)
  const d = props.decisions[node.id]
  const selected = props.selection.includes(node.id)
  const tris = triCount(node)
  const own = node.positions.length / 9

  const matches = useMemo(() => {
    if (!filter) return true
    const f = filter.toLowerCase()
    const hit = (n: ImportedNode): boolean =>
      (props.decisions[n.id]?.name ?? n.name).toLowerCase().includes(f) || n.children.some(hit)
    return hit(node)
  }, [filter, node, props.decisions])

  if (!matches) return null

  return (
    <>
      <div
        className={`tree-row${selected ? ' selected' : ''}${d?.include ? '' : ' excluded'}`}
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
          style={{ visibility: node.children.length ? 'visible' : 'hidden' }}
          aria-label={open ? 'Collapse' : 'Expand'}
        >
          {open ? '▾' : '▸'}
        </button>

        <input
          type="checkbox"
          checked={d?.include ?? false}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => {
            // Alt-click applies to the whole subtree — the difference between pruning a
            // 400-node IFC tree in a minute and in twenty.
            const ids = (e.nativeEvent as MouseEvent).altKey ? props.subtreeIds(node) : [node.id]
            props.onUpdate(ids, { include: e.target.checked })
          }}
          disabled={own === 0}
          title={own === 0 ? 'This node has no geometry of its own' : 'Alt-click to apply to all children'}
        />

        <span
          className="dot"
          style={{ background: d ? PLANE_DOT[d.planeType] : 'transparent' }}
          title={PLANE_TYPES.find((p) => p.code === d?.planeType)?.label}
        />

        <span className="tree-name" title={node.tags.join(' · ')}>
          {d?.name ?? node.name}
        </span>

        <span className="tree-count">{tris.toLocaleString()}</span>
      </div>

      {open &&
        node.children.map((c) => (
          <Row key={c.id} node={c} depth={depth + 1} props={props} filter={filter} />
        ))}
    </>
  )
}

export function Tree(props: Props) {
  const [filter, setFilter] = useState('')
  const all = useMemo(() => props.nodes.flatMap((n) => props.subtreeIds(n)), [props.nodes, props.subtreeIds])
  const withGeom = useMemo(() => {
    const out: string[] = []
    const walk = (ns: ImportedNode[]) => {
      for (const n of ns) {
        if (n.positions.length > 0) out.push(n.id)
        walk(n.children)
      }
    }
    walk(props.nodes)
    return out
  }, [props.nodes])

  const included = withGeom.filter((id) => props.decisions[id]?.include).length

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

      <div className="tree-scroll">
        {props.nodes.map((n) => (
          <Row key={n.id} node={n} depth={0} props={props} filter={filter} />
        ))}
      </div>

      <div className="tree-foot">
        {included} of {withGeom.length} objects included
      </div>
    </div>
  )
}
