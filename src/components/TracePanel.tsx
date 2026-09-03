/**
 * The trace side panel: the sheet, the scale, the regions and their heights.
 *
 * Heights are the whole reason this panel exists. A plan gives an outline and nothing
 * else, so every number that makes a surface three-dimensional is typed here — one per
 * corner, which is what lets a rake, a raised balcony and a sunken pit all be described
 * without leaving the drawing.
 */

import { useMemo } from 'react'
import { PLANE_TYPES, PlaneType } from '../lib/dbacv/types.ts'
import {
  type HeightMode,
  type RegionFit,
  type TraceDocument,
  type TraceRegion,
  type WandOptions,
  calibrateByPaperScale,
  fitHeightPlane,
  fitRegion,
  pxToVenue,
  rampHeights,
  regionAreaM2,
  regionPerimeterM,
  slopeOf,
  traceContours,
} from '../lib/trace/index.ts'
import { type InkMaskOptions, inkMask } from '../lib/trace/raster.ts'
import type { Decisions, NodeDecision } from '../state.ts'
import { Field, NumberInput, Panel, Segmented } from './ui.tsx'
import { PLANE_UI_COLOUR } from './planeColours.ts'

interface Props {
  doc: TraceDocument
  onChange: (updater: (d: TraceDocument) => TraceDocument) => void
  selected: string | null
  onSelect: (id: string | null) => void
  decisions: Decisions
  onUpdateDecisions: (ids: string[], patch: Partial<NodeDecision>) => void
  detect: InkMaskOptions
  onDetect: (patch: Partial<InkMaskOptions>) => void
  wand: WandOptions
  onWand: (patch: Partial<WandOptions>) => void
  /** Re-read the source file, e.g. to move to another page of a PDF. */
  onPage: (index: number) => void
  /** Height entry state, kept above the panel so switching region does not lose it. */
  ramp: { from: number; to: number; zFrom: number; zTo: number; flat: number }
  onRamp: (patch: Partial<Props['ramp']>) => void
}

export function TracePanel(props: Props) {
  const { doc, onChange, selected } = props
  const region = doc.regions.find((r) => r.id === selected) ?? null

  const patch = (id: string, fn: (r: TraceRegion) => TraceRegion) =>
    onChange((d) => ({ ...d, regions: d.regions.map((r) => (r.id === id ? fn(r) : r)) }))

  return (
    <>
      <Panel title="Scale">
        <Calibration {...props} />
      </Panel>

      <Panel title={`Regions (${doc.regions.length})`}>
        {doc.regions.length === 0 ? (
          <p className="muted">
            Nothing traced yet. Use <strong>Detect region</strong> to click inside an enclosed
            area, or <strong>Trace</strong> to draw an outline corner by corner.
          </p>
        ) : (
          <ul className="region-list">
            {doc.regions.map((r) => {
              const d = props.decisions[r.id]
              return (
                <li key={r.id} className={r.id === selected ? 'on' : ''}>
                  <button
                    type="button"
                    className="eye"
                    title={r.visible ? 'Hide' : 'Show'}
                    onClick={() => patch(r.id, (x) => ({ ...x, visible: !x.visible }))}
                  >
                    {r.visible ? '◉' : '○'}
                  </button>
                  <span
                    className="dot"
                    style={{ background: PLANE_UI_COLOUR[d?.planeType ?? r.planeType] }}
                  />
                  <button type="button" className="region-name" onClick={() => props.onSelect(r.id)}>
                    {d?.name ?? r.name}
                  </button>
                  <span className="region-area">{regionAreaM2(r, doc.calibration).toFixed(1)} m²</span>
                  <button
                    type="button"
                    className="danger-btn"
                    title="Delete this region"
                    onClick={() => {
                      onChange((dd) => ({ ...dd, regions: dd.regions.filter((x) => x.id !== r.id) }))
                      if (selected === r.id) props.onSelect(null)
                    }}
                  >
                    ×
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </Panel>

      {region && <RegionEditor {...props} region={region} patch={patch} />}

      <Panel title="Detection">
        <Detection {...props} />
      </Panel>
    </>
  )
}

// ------------------------------------------------------------------- calibration

function Calibration({ doc, onChange }: Props) {
  const cal = doc.calibration
  const src = cal.source

  return (
    <>
      <div className="cal-readout">
        <strong>{cal.pixelsPerMetre.toFixed(2)}</strong> px / m
        <em>
          {src.kind === 'known-distance'
            ? `measured over ${src.metres} m`
            : src.kind === 'paper-scale'
              ? `1:${src.denominator} on the page`
              : 'not calibrated'}
        </em>
      </div>
      {src.kind === 'unset' && (
        <p className="hint warn-text">
          Nothing is at the right size yet. Use <strong>Set scale</strong> and measure a
          dimension you know — the longest one on the sheet, because the click accuracy is
          fixed and spreading it over a longer line makes the error smaller.
        </p>
      )}

      {doc.page && (
        <Field
          label="Paper scale"
          hint="For a vector PDF: the scale printed in the title block. Exact, and no clicking."
        >
          <div className="row-inline">
            <span className="prefix">1:</span>
            <input
              type="number"
              min="1"
              step="1"
              defaultValue={50}
              id="paper-scale"
              aria-label="Paper scale denominator"
            />
            <button
              type="button"
              onClick={() => {
                const el = document.getElementById('paper-scale') as HTMLInputElement | null
                const n = Number(el?.value)
                if (!doc.page || !Number.isFinite(n) || n <= 0) return
                const c = calibrateByPaperScale(n, doc.page.pixelsPerPagePoint, cal.origin)
                if (c) onChange((d) => ({ ...d, calibration: c }))
              }}
            >
              Apply
            </button>
          </div>
        </Field>
      )}

      <p className="hint">
        Venue origin is at pixel {cal.origin[0].toFixed(0)}, {cal.origin[1].toFixed(0)} — the
        green cross. Venue +X runs right across the sheet and +Y runs up it; use{' '}
        <strong>Heading</strong> under Placement to aim the room down +X.
      </p>
    </>
  )
}

// ----------------------------------------------------------------- region editor

function RegionEditor({
  doc,
  region,
  patch,
  onChange,
  decisions,
  onUpdateDecisions,
  ramp,
  onRamp,
}: Props & { region: TraceRegion; patch: (id: string, fn: (r: TraceRegion) => TraceRegion) => void }) {
  const decision = decisions[region.id]
  const planeType = decision?.planeType ?? region.planeType

  const plan = useMemo(
    () =>
      region.vertices.map((v) => {
        const { x, y } = pxToVenue(v.p, doc.calibration)
        return { x, y, z: v.z }
      }),
    [region.vertices, doc.calibration],
  )
  const fit = useMemo(() => fitHeightPlane(plan), [plan])
  const slope = slopeOf(fit)

  // Rounded to the millimetre: a ramp lands corners on values like 0.157552, and a venue
  // height nobody could measure to is just noise in a box the user has to read.
  const setHeights = (zs: number[]) =>
    patch(region.id, (r) => ({
      ...r,
      vertices: r.vertices.map((v, i) => ({ ...v, z: zs[i] === undefined ? v.z : Math.round(zs[i] * 1000) / 1000 })),
    }))

  return (
    <Panel title="Surface">
      <Field label="Name">
        <input
          className="name-input"
          value={decision?.name ?? region.name}
          onChange={(e) => {
            patch(region.id, (r) => ({ ...r, name: e.target.value }))
            onUpdateDecisions([region.id], { name: e.target.value })
          }}
        />
      </Field>

      <Field label="Plane type" hint="Labels are reverse-engineered; the raw code is shown too.">
        <select
          value={planeType}
          onChange={(e) => {
            const v = Number(e.target.value) as PlaneType
            patch(region.id, (r) => ({ ...r, planeType: v }))
            onUpdateDecisions([region.id], { planeType: v })
          }}
        >
          {PLANE_TYPES.map((p) => (
            <option key={p.code} value={p.code}>
              {p.label} ({p.code}){p.verified ? '' : ' ?'}
            </option>
          ))}
        </select>
      </Field>

      <label className="check">
        <input
          type="checkbox"
          checked={decision?.include ?? true}
          onChange={(e) => onUpdateDecisions([region.id], { include: e.target.checked })}
        />
        Include in the export
      </label>

      <Field
        label="Fit"
        hint="Rectangle and Hull replace the corners with the smallest rectangle or convex shape round the outline, drop its holes, and carry the heights across as a plane. Switching back restores the outline as it was detected or drawn."
      >
        <Segmented<RegionFit>
          value={region.fit}
          onChange={(v) => patch(region.id, (r) => fitRegion(r, v))}
          options={[
            { value: 'outline', label: region.origin === 'drawn' ? 'As drawn' : 'As detected' },
            { value: 'rect', label: 'Rectangle' },
            { value: 'hull', label: 'Hull' },
          ]}
        />
      </Field>

      {region.holes.length > 0 && (
        <div className="row-inline">
          <span className="hint">
            {region.holes.length} hole(s) — alt-click inside one on the drawing to remove it.
          </span>
          <button
            type="button"
            onClick={() => patch(region.id, (r) => ({ ...r, holes: [] }))}
            title="Remove every hole from this surface. Switching Fit back to As detected brings them back."
          >
            Remove holes
          </button>
        </div>
      )}

      <Field label="Heights" hint="How the typed corner heights become a surface.">
        <Segmented<HeightMode>
          value={region.heightMode}
          onChange={(v) => patch(region.id, (r) => ({ ...r, heightMode: v }))}
          options={[
            { value: 'plane', label: 'Single plane' },
            { value: 'free', label: 'Exactly as typed' },
          ]}
        />
      </Field>
      <p className="hint">
        {region.heightMode === 'plane'
          ? 'One flat surface fitted through the corner heights — always a single ArrayCalc object. A level floor and a constant rake both come out exact.'
          : 'The typed heights are used as they are. Faithful to a stepped or dished surface, but anything not flat becomes several ArrayCalc objects.'}
      </p>

      <div className="height-table">
        {region.vertices.map((v, i) => (
          <label key={i} className="height-row">
            <span className="corner-no">{i + 1}</span>
            <NumberInput
              value={v.z}
              step={0.1}
              suffix="m"
              onChange={(z) =>
                patch(region.id, (r) => ({
                  ...r,
                  vertices: r.vertices.map((w, j) => (j === i ? { ...w, z } : w)),
                }))
              }
            />
          </label>
        ))}
      </div>

      <div className="row-inline">
        <NumberInput value={ramp.flat} step={0.1} suffix="m" onChange={(z) => onRamp({ flat: z })} />
        <button
          type="button"
          onClick={() => setHeights(region.vertices.map(() => ramp.flat))}
          title="Give every corner the same height"
        >
          Set all
        </button>
      </div>

      <div className="ramp">
        <span className="hint">Ramp: corner</span>
        <CornerSelect n={region.vertices.length} value={ramp.from} onChange={(v) => onRamp({ from: v })} />
        <NumberInput value={ramp.zFrom} step={0.1} suffix="m" onChange={(z) => onRamp({ zFrom: z })} />
        <span className="hint">to</span>
        <CornerSelect n={region.vertices.length} value={ramp.to} onChange={(v) => onRamp({ to: v })} />
        <NumberInput value={ramp.zTo} step={0.1} suffix="m" onChange={(z) => onRamp({ zTo: z })} />
        <button
          type="button"
          onClick={() => setHeights(rampHeights(plan, ramp.from, ramp.to, ramp.zFrom, ramp.zTo))}
        >
          Apply
        </button>
      </div>
      <p className="hint">
        Every other corner takes the height its position along that line implies, and corners
        past the far anchor carry on up the same slope rather than levelling off.
      </p>

      <div className="surface-stats">
        <span>
          <em>plan area</em> {regionAreaM2(region, doc.calibration).toFixed(2)} m²
        </span>
        <span>
          <em>perimeter</em> {regionPerimeterM(region, doc.calibration).toFixed(2)} m
        </span>
        <span>
          <em>rake</em>{' '}
          {slope.gradient < 1e-4
            ? 'level'
            : `1:${slope.oneIn.toFixed(1)} (${(slope.gradient * 100).toFixed(1)}%)`}
        </span>
        {region.heightMode === 'plane' && fit.maxResidual > 0.002 && (
          <span className="warn-text">
            <em>fit moves a corner</em> {(fit.maxResidual * 1000).toFixed(0)} mm
          </span>
        )}
      </div>

      <div className="row-inline">
        <button
          type="button"
          onClick={() =>
            onChange((d) => ({
              ...d,
              regions: d.regions.map((r) =>
                r.id === region.id ? { ...r, vertices: [...r.vertices].reverse() } : r,
              ),
            }))
          }
          title="Reverse the corner order. Only changes which corner is number 1 — the surface still faces up."
        >
          Reverse order
        </button>
        <button
          type="button"
          className="danger-btn wide"
          onClick={() => onChange((d) => ({ ...d, regions: d.regions.filter((r) => r.id !== region.id) }))}
        >
          Delete region
        </button>
      </div>
    </Panel>
  )
}

function CornerSelect({ n, value, onChange }: { n: number; value: number; onChange: (v: number) => void }) {
  return (
    <select value={Math.min(value, Math.max(0, n - 1))} onChange={(e) => onChange(Number(e.target.value))}>
      {Array.from({ length: n }, (_, i) => (
        <option key={i} value={i}>
          {i + 1}
        </option>
      ))}
    </select>
  )
}

// -------------------------------------------------------------------- detection

function Detection({ doc, detect, onDetect, wand, onWand, onChange, onPage }: Props) {
  return (
    <>
      {doc.page && doc.page.count > 1 && (
        <Field label="Page">
          <select value={doc.page.index} onChange={(e) => onPage(Number(e.target.value))}>
            {Array.from({ length: doc.page.count }, (_, i) => (
              <option key={i} value={i}>
                Page {i + 1}
              </option>
            ))}
          </select>
        </Field>
      )}

      <Field label="Ink threshold" hint="0 for auto (Otsu). Raise it to pick up fainter lines.">
        <NumberInput
          value={detect.threshold === 'auto' ? 0 : (detect.threshold as number)}
          step={5}
          min={0}
          max={255}
          onChange={(v) => onDetect({ threshold: v <= 0 ? 'auto' : Math.round(v) })}
        />
      </Field>

      <label className="check">
        <input
          type="checkbox"
          checked={detect.invert ?? false}
          onChange={(e) => onDetect({ invert: e.target.checked })}
        />
        Light lines on a dark background
      </label>

      <label
        className="check"
        title="Keeps only black and grey ink. On a CAD plot the loudspeakers, labels and cable runs are usually on coloured layers and the architecture is black, so this leaves the walls alone to detect."
      >
        <input
          type="checkbox"
          checked={detect.ignoreColour ?? false}
          onChange={(e) => onDetect({ ignoreColour: e.target.checked })}
        />
        Ignore coloured lines
      </label>

      <Field
        label="Thicken lines"
        hint="Closes hairline gaps before filling. Raise it if region detect leaks out of the room."
      >
        <NumberInput
          value={detect.lineThickenPx ?? 1}
          step={1}
          min={0}
          max={6}
          suffix="px"
          onChange={(v) => onDetect({ lineThickenPx: Math.max(0, Math.round(v)) })}
        />
      </Field>

      <Field
        label="Holes"
        hint="Shapes enclosed inside a detected area. On a real plot they are mostly labels, symbols and furniture rather than columns, so they are left out unless you ask."
      >
        <Segmented<WandOptions['holes']>
          value={wand.holes}
          onChange={(v) => onWand({ holes: v })}
          options={[
            { value: 'ignore', label: 'Ignore' },
            { value: 'keep', label: 'Keep' },
          ]}
        />
      </Field>
      {wand.holes === 'keep' && (
        <Field
          label="Keep holes over"
          hint="Anything enclosed and smaller than this is still left out. A label or a loudspeaker symbol is under 0.2 m²; a structural column is anywhere from 0.1 to 1 m², so keeping columns may keep a few symbols with them."
        >
          <NumberInput
            value={wand.minHoleAreaM2}
            step={0.5}
            min={0}
            suffix="m²"
            onChange={(v) => onWand({ minHoleAreaM2: Math.max(0, v) })}
          />
        </Field>
      )}

      <button
        type="button"
        onClick={() => {
          const paths = traceContours(inkMask(doc.raster, detect))
          onChange((d) => ({ ...d, paths }))
        }}
        title="Re-run outline detection on the pixels with the current settings, for snapping."
      >
        Re-detect outlines for snapping
      </button>
      <p className="hint">
        {doc.paths.length.toLocaleString()} outline(s) available to snap to. On a vector PDF
        these are the real drawn lines; on an image they are recovered from the pixels, so
        they are only as accurate as the render.
      </p>
    </>
  )
}
