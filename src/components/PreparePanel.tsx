/**
 * The preparation panel: what was decided for you, and how to change it.
 *
 * The checkboxes are the small half. The important half is the report underneath them —
 * every line says what actually happened to THIS model, with counts. A pass that silently
 * left out forty objects would be indistinguishable from an importer that lost them, and
 * the first thing a user would do is stop trusting the tool.
 *
 * So: state the effect, name the reason, and keep every part of it reversible. Nothing here
 * is a setting to tune. Each box is a question about the model, and the answer is visible in
 * the tree, in the viewport and in the object count the moment it is ticked.
 */

import { useState } from 'react'
import type { PrepareSettings, Prepared } from '../state.ts'
import { type FlatPlanReport, drawingUnitName } from '../lib/trace/cad.ts'
import { Field, NumberInput } from './ui.tsx'

interface Props {
  prepared: Prepared
  /** Preparation is being re-run — it re-reads the model and can take a moment. */
  busy: boolean
  onChange: (patch: Partial<PrepareSettings>) => void
  /** Whether what is left in is a flat plan. Null for anything that is not a DXF or DWG. */
  flatPlan: FlatPlanReport | null
  /**
   * Metres per unit the sheet would be drawn at, whether the drawing stated it, and why the
   * statement is doubtful when its seats disagree.
   */
  units: { metresPerUnit: number; stated: boolean; doubt?: string }
  /** How many layers "Draw only the layers left in" would put on the sheet. */
  layersLeftIn: number
  onTracePlan: (onlyLeftIn: boolean) => void
}

function Check({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string
  hint: string
  checked: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <label className="check" title={hint}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  )
}

export function PreparePanel({ prepared, busy, onChange, flatPlan, units, layersLeftIn, onTracePlan }: Props) {
  const { options, plan, simplify, split } = prepared
  const cut = simplify && simplify.trianglesIn > 0 ? 1 - simplify.trianglesOut / simplify.trianglesIn : 0

  // A file that is already a venue gets none of this, and saying so is better than five
  // checkboxes that do nothing when ticked. Whoever built it already decided what belongs
  // in it; there is no clutter to find and no seating left scattered.
  if (prepared.raw.alreadyAVenue) {
    return (
      <p className="hint">
        {prepared.raw.format} is already a venue — every object in it was put there by
        whoever built it, so nothing is left out, reclassified or flattened on the way in.
        Prune it in the tree, or gather anything you want to in <strong>Rationalise</strong>.
      </p>
    )
  }

  return (
    <>
      <p className="hint">
        Applied when the file opened. Everything here is a decision, not a change to the
        model: untick a box to put it back, or find the objects in the tree and include them
        again one at a time.
      </p>

      <Check
        label="Leave out clutter"
        hint={
          'Objects whose names say they are not room surfaces: dimensions, text, lighting ' +
          'bars, truss, cable, services, furniture, people — and loudspeakers, which ' +
          'ArrayCalc and Soundvision place themselves.\n\nWhole words only, so TEXTURED ' +
          'PANEL is kept and TEXT is not.'
        }
        checked={options.dropClutter}
        onChange={(v) => onChange({ dropClutter: v })}
      />

      <Check
        label="Leave out tiny objects"
        hint="Brackets, fixings, trim and stray facets — anything with almost no surface to reflect off."
        checked={options.dropTiny}
        onChange={(v) => onChange({ dropTiny: v })}
      />
      {options.dropTiny && (
        <Field label="Smaller than" hint="Total surface area of the whole object.">
          <NumberInput
            value={options.tinyArea}
            step={0.05}
            min={0}
            suffix="m²"
            onChange={(v) => onChange({ tinyArea: Math.max(0, v) })}
          />
        </Field>
      )}

      <Check
        label="Split one-piece models"
        hint={
          'A model that is one mesh — an OBJ, an STL, a media server\'s stock stage — has no ' +
          'names to prune or type by. Its shape is read instead: rows of steps become rakes, ' +
          'and the rest is split into floor, ceiling and walls, each a row in the tree.\n\n' +
          'Only an object whose name says nothing is split, and only one with height in it.'
        }
        checked={options.splitOnePiece}
        onChange={(v) => onChange({ splitOnePiece: v })}
      />

      <Check
        label="Flatten seating into audience planes"
        hint={
          'A bank of separately-modelled seats becomes the one plane it stands for — the ' +
          'same thing the Rationalise panel does by hand, and editable there afterwards.\n\n' +
          'Found by name, by repetition — hundreds of alike, small, upward-facing objects a ' +
          'metre apart are a bank of chairs whatever they are called — and by shape: a rake ' +
          'split out of a one-piece model.'
        }
        checked={options.flattenSeating}
        onChange={(v) => onChange({ flattenSeating: v })}
      />

      <Check
        label="Guess plane types from names and shape"
        hint="STAGE becomes a stage, WALL and CEILING become surfaces. An unnamed object that is all wall, or a ceiling over the room, becomes a surface too. Everything else stays Listening, and every guess is visible in the tree."
        checked={options.guessPlaneTypes}
        onChange={(v) => onChange({ guessPlaneTypes: v })}
      />

      <Check
        label="Re-cut heavy objects"
        hint={
          'A meshed flat wall is hundreds of triangles describing one rectangle. Merging ' +
          'them back into the flat region they already form and re-cutting it from its own ' +
          'outline gives the same shape with a fraction of the triangles — a faster ' +
          'viewport and a faster conversion.\n\nThe outline is kept exactly. Anything that ' +
          'is not genuinely flat, or has a hole in it, is left alone.'
        }
        checked={options.simplifyHeavy}
        onChange={(v) => onChange({ simplifyHeavy: v })}
      />

      {busy && <p className="hint">Re-running…</p>}

      <div className="prep-report">
        {split && split.nodesSplit > 0 && (
          <p className="hint">
            Split {split.nodesSplit} one-piece model{split.nodesSplit === 1 ? '' : 's'} into{' '}
            {split.parts} parts: {split.rakes} rake{split.rakes === 1 ? '' : 's'} by their steps, and the
            floor, ceiling and walls by where they are.
          </p>
        )}
        {prepared.surface === 'scan' && options.simplifyHeavy && (
          <p className="hint">
            Read as a scan, so nothing is re-cut: a scan's surfaces are flat only to within its
            noise, and re-cutting keeps only what is exactly flat.
          </p>
        )}
        {simplify && simplify.nodesSimplified > 0 && (
          <p className="hint">
            Re-cut {simplify.nodesSimplified} object{simplify.nodesSimplified === 1 ? '' : 's'}:{' '}
            {simplify.trianglesIn.toLocaleString()} triangles down to{' '}
            {simplify.trianglesOut.toLocaleString()} — {Math.round(cut * 100)}% fewer, same shape.
          </p>
        )}
        {plan.notes.map((n) => (
          <p key={n} className="hint">
            {n}
          </p>
        ))}
        {plan.notes.length === 0 &&
          prepared.surface !== 'scan' &&
          (!simplify || simplify.nodesSimplified === 0) &&
          (!split || split.nodesSplit === 0) &&
          !flatPlan?.flat && (
          <p className="hint">
            Nothing to do on this model — no names it recognised, nothing repeated enough to
            read as seating, and nothing meshed finely enough to be worth re-cutting.
          </p>
        )}
      </div>

      {flatPlan?.flat && (
        <FlatPlan report={flatPlan} units={units} layersLeftIn={layersLeftIn} onTrace={onTracePlan} />
      )}

      {plan.seating.length > 0 && (
        <p className="hint">
          The audience planes it made are in <strong>Rationalise</strong> below, with the
          area they captured against the area they emitted and how far off one plane the
          seats sat. Check those numbers before trusting a plane you did not draw.
        </p>
      )}
    </>
  )
}

/**
 * The offer to trace a flat plan instead of converting it.
 *
 * Stated as a finding about THIS drawing, with the share it was decided on, because the
 * alternative it argues against — converting as a model — will look like it worked: the
 * surfaces all arrive, just every one of them at the same height.
 */
function FlatPlan({
  report,
  units,
  layersLeftIn,
  onTrace,
}: {
  report: FlatPlanReport
  units: Props['units']
  layersLeftIn: number
  onTrace: (onlyLeftIn: boolean) => void
}) {
  const [onlyLeftIn, setOnlyLeftIn] = useState(true)
  const pct = Math.floor(report.share * 100)
  const level = Math.abs(report.levelM) < 0.005 ? '' : ` (${report.levelM.toFixed(2)} m)`
  const unit = drawingUnitName(units.metresPerUnit)

  return (
    <div className="flat-plan">
      <p className="hint">
        <strong>This is a flat plan.</strong>{' '}
        {report.measuredOn === 'surfaces'
          ? `${pct}% of the surface left in lies on one level${level}`
          : `Nothing left in closes into a surface, and ${pct}% of its lines lie on one level${level}`}
        , so converted as a model it comes out lying flat — a ceiling on the floor. Trace it
        instead: pick out the regions with the wand and type their heights.{' '}
        {units.doubt
          ? units.doubt
          : units.stated
            ? `It states ${unit}, so it arrives at the right scale with nothing to measure.`
            : `It does not state its units, so the sheet is drawn in ${unit} as set under Source units — check that first.`}
      </p>
      {report.withHeight.length > 0 && (
        <p className="hint">
          {report.withHeight
            .slice(0, 4)
            .map((h) => `${h.name} (${h.spanM.toFixed(1)} m)`)
            .join(', ')}
          {report.withHeight.length > 4 ? ` and ${report.withHeight.length - 4} more` : ''}{' '}
          {report.withHeight.length === 1 ? 'is left in and carries' : 'are left in and carry'} height —
          symbols drawn in 3D, usually, not the room.
          {report.leftOutWithHeight > 0 &&
            ` ${report.leftOutWithHeight} more with height ${report.leftOutWithHeight === 1 ? 'was' : 'were'} left out as clutter.`}
        </p>
      )}
      <label
        className="check"
        title={
          'Put only the layers left in on the sheet, so the clutter found above — centrelines, ' +
          'dimensions, lighting — does not cut rooms in two for the wand.\n\nA layer left out ' +
          'only for being small is still drawn: its lines are what the wand stops at.'
        }
      >
        <input type="checkbox" checked={onlyLeftIn} onChange={(e) => setOnlyLeftIn(e.target.checked)} />
        Draw only the layers left in ({layersLeftIn})
      </label>
      <button
        type="button"
        className="primary"
        disabled={onlyLeftIn && layersLeftIn === 0}
        onClick={() => onTrace(onlyLeftIn)}
      >
        Trace this plan
      </button>
    </div>
  )
}
