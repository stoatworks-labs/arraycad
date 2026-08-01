/**
 * The inspector: assign what each thing IS.
 *
 * Plane type labels are shown with their raw numeric code because the labels are
 * reverse-engineered, not documented. If a guess is wrong the user can still see which
 * code they are writing and correct it against ArrayCalc — a label alone would hide that.
 */

import { DEFAULT_LISTENER_HEIGHT, PLANE_TYPES, PlaneType } from '../lib/dbacv/types.ts'
import type { ImportedNode } from '../lib/import/index.ts'
import type { Decisions } from '../state.ts'
import { Field } from './ui.tsx'

interface Props {
  selection: string[]
  nodesById: Map<string, ImportedNode>
  decisions: Decisions
  onUpdate: (ids: string[], patch: { include?: boolean; planeType?: PlaneType; name?: string }) => void
  onSelectMatchingTag: (tag: string) => void
}

export function Inspector(props: Props) {
  const sel = props.selection.filter((id) => props.nodesById.has(id))

  if (sel.length === 0) {
    return (
      <p className="muted">
        Select an object in the tree or click one in the viewport. Shift-click to add to the
        selection; alt-click a checkbox to include or exclude a whole branch.
      </p>
    )
  }

  const first = props.decisions[sel[0]]
  const mixedType = sel.some((id) => props.decisions[id]?.planeType !== first?.planeType)
  const node = props.nodesById.get(sel[0])!
  const tris = sel.reduce((t, id) => t + (props.nodesById.get(id)?.positions.length ?? 0) / 9, 0)

  return (
    <div className="inspector">
      <div className="insp-head">
        {sel.length === 1 ? (
          <input
            className="name-input"
            value={first?.name ?? ''}
            onChange={(e) => props.onUpdate(sel, { name: e.target.value })}
            aria-label="Object name"
          />
        ) : (
          <strong>{sel.length} objects selected</strong>
        )}
        <span className="muted">{tris.toLocaleString()} triangles</span>
      </div>

      <Field label="Plane type" hint="What this surface is, acoustically.">
        <select
          value={mixedType ? '' : String(first?.planeType ?? '')}
          onChange={(e) => props.onUpdate(sel, { planeType: Number(e.target.value) as PlaneType })}
        >
          {mixedType && <option value="">— mixed —</option>}
          {PLANE_TYPES.filter((p) => p.code !== PlaneType.None).map((p) => (
            <option key={p.code} value={p.code}>
              {p.label} (type {p.code})
            </option>
          ))}
        </select>
      </Field>

      {!mixedType && first && (
        <p className="hint">
          {PLANE_TYPES.find((p) => p.code === first.planeType)?.hint} Listener height will be{' '}
          <code>{DEFAULT_LISTENER_HEIGHT[first.planeType] ?? 1.2} m</code>.
        </p>
      )}

      <div className="insp-actions">
        <button type="button" onClick={() => props.onUpdate(sel, { include: true })}>
          Include
        </button>
        <button type="button" onClick={() => props.onUpdate(sel, { include: false })}>
          Exclude
        </button>
      </div>

      {node.tags.length > 0 && (
        <div className="tags">
          <span className="muted">Select all with tag:</span>
          {node.tags.map((t) => (
            <button key={t} type="button" className="tag" onClick={() => props.onSelectMatchingTag(t)}>
              {t}
            </button>
          ))}
        </div>
      )}

      <p className="caveat">
        Plane type names here are <strong>reverse-engineered</strong> from a real ArrayCalc
        export, not from documentation. The numeric code in brackets is what actually gets
        written to the file — check it against ArrayCalc before trusting a whole venue to it.
      </p>
    </div>
  )
}
