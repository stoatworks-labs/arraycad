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

import type { PrepareSettings, Prepared } from '../state.ts'
import { Field, NumberInput } from './ui.tsx'

interface Props {
  prepared: Prepared
  /** Preparation is being re-run — it re-reads the model and can take a moment. */
  busy: boolean
  onChange: (patch: Partial<PrepareSettings>) => void
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

export function PreparePanel({ prepared, busy, onChange }: Props) {
  const { options, plan, simplify } = prepared
  const cut = simplify && simplify.trianglesIn > 0 ? 1 - simplify.trianglesOut / simplify.trianglesIn : 0

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
        label="Flatten seating into audience planes"
        hint={
          'A bank of separately-modelled seats becomes the one plane it stands for — the ' +
          'same thing the Rationalise panel does by hand, and editable there afterwards.\n\n' +
          'Found by name, and by repetition: hundreds of alike, small, upward-facing ' +
          'objects a metre apart are a bank of chairs whatever they are called.'
        }
        checked={options.flattenSeating}
        onChange={(v) => onChange({ flattenSeating: v })}
      />

      <Check
        label="Guess plane types from names"
        hint="STAGE becomes a stage, WALL and CEILING become surfaces. Everything else stays Listening, and every guess is visible in the tree."
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
        {plan.notes.length === 0 && (!simplify || simplify.nodesSimplified === 0) && (
          <p className="hint">
            Nothing to do on this model — no names it recognised, nothing repeated enough to
            read as seating, and nothing meshed finely enough to be worth re-cutting.
          </p>
        )}
      </div>

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
