/**
 * The rationalisation panel: turn many modelled objects into one plane.
 *
 * The controls are deliberately few, and every one of them changes an answer rather than a
 * setting. What earns most of the space is the readout underneath each area — captured
 * against emitted area, and how far off one plane the geometry sat. A rationalisation is
 * the user asserting that four hundred seats are one seating area; those numbers are how
 * the assertion gets checked, and hiding them would make the feature a guess with a
 * confident-looking result.
 */

import { PLANE_TYPES, PlaneType } from '../lib/dbacv/types.ts'
import type { CaptureFaces, OutlineMode, RationaliseStats } from '../lib/geom/rationalise.ts'
import type { Rationalisation } from '../state.ts'
import { Field, NumberInput, Segmented } from './ui.tsx'

interface Props {
  rationalisations: Rationalisation[]
  statsById: Map<string, RationaliseStats>
  /** How many objects are selected in the tree or by marquee. */
  selectionCount: number
  /** Corners placed so far in the drawing tool, if it is armed. */
  drawingPoints: number
  tool: 'marquee' | 'area' | null
  onTool: (t: 'marquee' | 'area' | null) => void
  onCreateFromSelection: () => void
  onUpdate: (id: string, patch: Partial<Rationalisation>) => void
  onRemove: (id: string) => void
  onSelectMembers: (ids: string[]) => void
}

const FACE_OPTIONS: { value: CaptureFaces; label: string }[] = [
  { value: 'upward', label: 'Upward faces' },
  { value: 'all', label: 'All faces' },
]

const MODE_OPTIONS: { value: OutlineMode; label: string }[] = [
  { value: 'concave', label: 'Follow' },
  { value: 'hull', label: 'Hull' },
  { value: 'rect', label: 'Rectangle' },
]

const m2 = (v: number) => `${v.toFixed(1)} m²`

export function RationalisePanel(props: Props) {
  const { tool, drawingPoints, selectionCount } = props

  return (
    <>
      <p className="hint">
        Where a plan models every seat, every step or every tread separately, the region
        finder is right to report hundreds of surfaces — they genuinely do not touch. Select
        them, or draw round them, and replace the lot with the one plane they stand for.
      </p>

      <div className="row2">
        <button
          type="button"
          className={`tool${tool === 'marquee' ? ' on' : ''}`}
          onClick={() => props.onTool(tool === 'marquee' ? null : 'marquee')}
          title="Drag a box in the 3D view to select every object inside it."
        >
          {tool === 'marquee' ? 'Drag a box…' : 'Box select'}
        </button>
        <button
          type="button"
          className={`tool${tool === 'area' ? ' on' : ''}`}
          onClick={() => props.onTool(tool === 'area' ? null : 'area')}
          title="Click corners in the 3D view to draw the area you want."
        >
          {tool === 'area' ? `Drawing — ${drawingPoints} corner${drawingPoints === 1 ? '' : 's'}` : 'Draw an area'}
        </button>
      </div>

      {tool === 'area' ? (
        <p className="hint">
          Click the corners of the area. Click the first corner again, or press Enter, to
          close it; Backspace removes the last corner and Esc starts over.
          {selectionCount > 0 ? (
            <>
              {' '}
              Only the <strong>{selectionCount} selected</strong> object
              {selectionCount === 1 ? '' : 's'} will be captured inside it.
            </>
          ) : (
            <>
              {' '}
              Everything inside it is captured — <strong>including the floor under the
              seats</strong>, which pulls the plane down between the two. Select the seating
              first and the drawing narrows to that.
            </>
          )}
        </p>
      ) : tool === 'marquee' ? (
        <p className="hint">
          Drag a box over the objects you want. Hold Shift to add to what is already
          selected. Orbiting is off while the box tool is armed.
        </p>
      ) : (
        <button
          type="button"
          className="primary wide"
          disabled={selectionCount === 0}
          onClick={props.onCreateFromSelection}
        >
          {selectionCount === 0
            ? 'Select objects to rationalise'
            : `Rationalise ${selectionCount} selected object${selectionCount === 1 ? '' : 's'}`}
        </button>
      )}

      {props.rationalisations.length === 0 ? null : (
        <div className="rat-list">
          {props.rationalisations.map((r) => (
            <Area
              key={r.id}
              r={r}
              stats={props.statsById.get(r.id)}
              onUpdate={props.onUpdate}
              onRemove={props.onRemove}
              onSelectMembers={props.onSelectMembers}
            />
          ))}
        </div>
      )}
    </>
  )
}

function Area({
  r,
  stats,
  onUpdate,
  onRemove,
  onSelectMembers,
}: {
  r: Rationalisation
  stats?: RationaliseStats
  onUpdate: (id: string, patch: Partial<Rationalisation>) => void
  onRemove: (id: string) => void
  onSelectMembers: (ids: string[]) => void
}) {
  const rect = r.planeType === PlaneType.PositioningArea

  return (
    <div className="rat">
      <header>
        <input
          value={r.name}
          onChange={(e) => onUpdate(r.id, { name: e.target.value })}
          aria-label="Area name"
        />
        <button type="button" className="ghost" onClick={() => onRemove(r.id)} title="Delete this area">
          ✕
        </button>
      </header>

      <button type="button" className="ghost wide" onClick={() => onSelectMembers(r.memberIds)}>
        {r.memberIds.length} source object{r.memberIds.length === 1 ? '' : 's'}
        {r.footprint ? ` · ${r.footprint.length}-corner area` : ''} — show
      </button>

      <Field label="Plane type">
        <select
          value={r.planeType}
          onChange={(e) => onUpdate(r.id, { planeType: Number(e.target.value) as PlaneType })}
        >
          {/* The raw code beside every label, because most of these names are inferred and
              not documented. Same rule as the inspector. */}
          {PLANE_TYPES.filter((p) => p.code !== PlaneType.None).map((p) => (
            <option key={p.code} value={p.code}>
              {p.label} ({p.code})
            </option>
          ))}
        </select>
      </Field>

      <Field label="Capture">
        <Segmented
          value={r.faces}
          options={FACE_OPTIONS}
          onChange={(v) => onUpdate(r.id, { faces: v })}
        />
      </Field>

      <Field label="Outline">
        <Segmented
          value={rect ? 'rect' : r.mode}
          options={MODE_OPTIONS}
          onChange={(v) => onUpdate(r.id, { mode: v })}
        />
      </Field>

      {rect ? (
        <p className="hint">
          ArrayCalc refuses a Positioning area that is not a rectangle, so this one is
          squared off whatever the outline setting says.
        </p>
      ) : r.mode === 'concave' ? (
        <Field label="Bridge gaps up to" hint="Set this to the row pitch. Aisles wider than it survive as aisles.">
          <NumberInput
            value={r.gapMetres}
            step={0.1}
            min={0.05}
            suffix="m"
            onChange={(v) => onUpdate(r.id, { gapMetres: v })}
          />
        </Field>
      ) : null}

      <label className="check">
        <input
          type="checkbox"
          checked={r.replaceMembers}
          onChange={(e) => onUpdate(r.id, { replaceMembers: e.target.checked })}
        />
        <span>
          Replace the originals
          <em>Off exports the new plane AND the objects it was made from.</em>
        </span>
      </label>

      {stats ? (
        <div className="rat-stats">
          <span>
            {stats.trianglesKept.toLocaleString()} of {stats.trianglesIn.toLocaleString()} triangles
          </span>
          <span>
            {m2(stats.areaCaptured)} of surface → {m2(stats.areaEmitted)}
            {stats.componentsOut > 1 ? ` in ${stats.componentsOut} areas` : ''}
          </span>
          {/* The number that says whether one plane was ever the right answer. A stepped
              rake reads a few centimetres here; two tiers read metres. */}
          <span className={stats.maxResidual > 0.25 ? 'warn' : undefined}>
            {stats.maxResidual < 0.005
              ? 'flat to within 5 mm'
              : `up to ${stats.maxResidual.toFixed(2)} m off plane`}
          </span>
        </div>
      ) : (
        <div className="rat-stats warn">
          <span>Nothing captured — see the warnings below.</span>
        </div>
      )}
    </div>
  )
}
