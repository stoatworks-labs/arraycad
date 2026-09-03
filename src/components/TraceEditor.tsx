/**
 * The drawing board: a plan on the left of the screen and the venue coming into being on it.
 *
 * Everything here works in the raster's own pixel space and converts to screen only when
 * it paints. That keeps the maths trivial (pan and zoom are one scale and one offset) and
 * means a change of calibration re-labels the drawing without moving a single traced point.
 *
 * The 3D preview is the ordinary Viewport, driven by the ordinary conversion — the tracer
 * has no separate render path, so what is on screen here is genuinely what gets exported.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  type Calibration,
  type Px,
  type RegionHit,
  type TraceDocument,
  type TraceRegion,
  type WandOptions,
  SnapIndex,
  calibrateByDistance,
  floodOptionsFor,
  floodRegion,
  inkMask,
  nextRegionId,
  pointInPolygon,
  pxDistance,
  pxToVenue,
  scaleBarStep,
  withOrigin,
} from '../lib/trace/index.ts'
import type { InkMaskOptions, Mask } from '../lib/trace/raster.ts'
import { PlaneType } from '../lib/dbacv/types.ts'
import { PLANE_UI_COLOUR } from './planeColours.ts'

export type TraceTool = 'select' | 'draw' | 'wand' | 'scale' | 'origin'

export const TOOL_HELP: Record<TraceTool, string> = {
  select: 'Click a region to select it. Drag its corners to adjust. Alt-click a corner to delete it, click a midpoint to add one.',
  draw: 'Click each corner. Enter or a click on the first corner closes the outline; Backspace undoes; Esc cancels.',
  wand: 'Click inside an enclosed area and its outline is detected for you. If the fill escapes, thicken the lines under Detection.',
  scale: 'Click each end of a dimension you know — the longest one on the sheet — then type its real length.',
  origin: 'Click the point that should be the venue origin. Everything is measured from there.',
}

interface Props {
  doc: TraceDocument
  onChange: (updater: (d: TraceDocument) => TraceDocument) => void
  tool: TraceTool
  onTool: (t: TraceTool) => void
  selected: string | null
  onSelect: (id: string | null) => void
  detect: InkMaskOptions
  wand: WandOptions
  planeTypeOf: (regionId: string) => PlaneType
  /** Regions the user has excluded are drawn as outlines only. */
  includedIds: Set<string>
}

interface View {
  scale: number
  tx: number
  ty: number
}

const VERTEX_HIT_PX = 9
const SNAP_PX = 12

/**
 * Past these, a detected region is describing the drawing rather than the room: a hall
 * with pilasters comes back as a hundred corners, and a plot with its labels inside the
 * room as dozens of holes. Neither is wrong, but neither is what anyone wants to export.
 */
const MANY_CORNERS = 40
const MANY_HOLES = 10

/** What the wand found, and what to do when what it found is mostly annotation. */
function wandStatus(hit: RegionHit): string {
  let s = `Detected ${hit.outline.length} corners`
  if (hit.holes.length) s += ` and ${hit.holes.length} hole(s)`
  if (hit.holesDropped) s += `; ${hit.holesDropped} enclosed shape(s) inside it left out`
  s += '.'
  if (hit.outline.length > MANY_CORNERS) {
    s += ' That many corners is wall detail, not the shape of the room — trace it by hand with four clicks.'
  }
  if (hit.holes.length > MANY_HOLES) {
    s +=
      ' That many holes is usually annotation rather than columns — raise the hole size under Detection, or set Holes to Ignore.'
  }
  return s
}

export function TraceEditor({
  doc,
  onChange,
  tool,
  onTool,
  selected,
  onSelect,
  detect,
  wand,
  planeTypeOf,
  includedIds,
}: Props) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [view, setView] = useState<View>({ scale: 1, tx: 0, ty: 0 })
  const [size, setSize] = useState({ w: 800, h: 600 })
  const [draft, setDraft] = useState<Px[]>([])
  const [cursor, setCursor] = useState<Px | null>(null)
  const [scalePts, setScalePts] = useState<Px[]>([])
  const [scaleMetres, setScaleMetres] = useState('10')
  const [status, setStatus] = useState<string | null>(null)
  const [snapOn, setSnapOn] = useState(true)

  const drag = useRef<
    | { kind: 'pan'; from: [number, number]; view: View }
    | { kind: 'vertex'; regionId: string; index: number }
    | null
  >(null)
  // The ink mask is only needed by the wand and costs a full pass over the page, so it is
  // built on first use and thrown away whenever a detection setting changes.
  const maskRef = useRef<Mask | null>(null)

  const underlay = useMemo(() => {
    const { width, height, data } = doc.raster
    const c = document.createElement('canvas')
    c.width = width
    c.height = height
    if (data.length === width * height * 4) {
      // Copied rather than handed over: ImageData insists on a plain ArrayBuffer, and the
      // document's raster stays the detector's input for the life of the session.
      c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(data), width, height), 0, 0)
    }
    return c
  }, [doc.raster])

  const snap = useMemo(() => new SnapIndex(doc.paths), [doc.paths])

  useEffect(() => {
    maskRef.current = null
  }, [doc.raster, detect.threshold, detect.invert, detect.lineThickenPx])

  // ------------------------------------------------------------------ viewport

  const fit = useCallback(() => {
    const { width, height } = doc.raster
    const el = wrapRef.current
    if (!el || !width || !height) return
    const w = el.clientWidth
    const h = el.clientHeight
    const scale = Math.min(w / width, h / height) * 0.94
    setView({ scale, tx: (w - width * scale) / 2, ty: (h - height * scale) / 2 })
  }, [doc.raster])

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    setSize({ w: el.clientWidth, h: el.clientHeight })
    return () => ro.disconnect()
  }, [])

  // Fit once the box is real, not once on mount. The first render happens before the
  // grid has laid out, so fitting then computes a scale for a zero-sized viewport and the
  // drawing arrives either invisible or hugely magnified.
  const fitted = useRef(false)
  useEffect(() => {
    fitted.current = false
  }, [doc.raster])
  useEffect(() => {
    if (size.w > 0 && size.h > 0 && !fitted.current) {
      fitted.current = true
      fit()
    }
  }, [size, fit])

  const toImage = useCallback(
    (sx: number, sy: number): Px => [(sx - view.tx) / view.scale, (sy - view.ty) / view.scale],
    [view],
  )

  const eventPoint = useCallback(
    (e: { clientX: number; clientY: number }): Px => {
      const r = canvasRef.current!.getBoundingClientRect()
      return toImage(e.clientX - r.left, e.clientY - r.top)
    },
    [toImage],
  )

  /** The point a click should actually land on: snapped to detected geometry, or raw. */
  const snapped = useCallback(
    (p: Px): Px => (snapOn ? snap.snap(p, SNAP_PX / view.scale).point : p),
    [snap, snapOn, view.scale],
  )

  // -------------------------------------------------------------------- editing

  const patchRegion = useCallback(
    (id: string, fn: (r: TraceRegion) => TraceRegion) => {
      onChange((d) => ({ ...d, regions: d.regions.map((r) => (r.id === id ? fn(r) : r)) }))
    },
    [onChange],
  )

  const addRegion = useCallback(
    (points: Px[], holes: Px[][], origin: TraceRegion['origin']) => {
      if (points.length < 3) return
      const id = nextRegionId()
      onChange((d) => ({
        ...d,
        regions: [
          ...d.regions,
          {
            id,
            name: `Region ${d.regions.length + 1}`,
            planeType: PlaneType.Listening,
            vertices: points.map((p) => ({ p, z: 0 })),
            holes,
            heightMode: 'plane',
            visible: true,
            origin,
          },
        ],
      }))
      onSelect(id)
    },
    [onChange, onSelect],
  )

  const closeDraft = useCallback(() => {
    // A double-click to finish is two clicks, so it has already dropped two corners in
    // the same place. Discard the repeat rather than leaving a zero-length edge that the
    // planarizer would later have to weld away.
    const pts = draft.slice()
    while (pts.length >= 2 && pxDistance(pts[pts.length - 1], pts[pts.length - 2]) < 1e-6) pts.pop()
    if (pts.length >= 3) {
      addRegion(pts, [], 'drawn')
      onTool('select')
    }
    setDraft([])
  }, [draft, addRegion, onTool])

  const runWand = useCallback(
    (p: Px) => {
      if (!maskRef.current) maskRef.current = inkMask(doc.raster, detect)
      const hit = floodRegion(maskRef.current, p, floodOptionsFor(wand, doc.calibration))
      if (!hit) {
        setStatus('That point is on a drawn line — click inside an empty area.')
        return
      }
      if (hit.outline.length < 3) {
        setStatus('Nothing enclosed that point.')
        return
      }
      if (hit.touchedBorder) {
        setStatus(
          `The fill reached the edge of the sheet (${(hit.coverage * 100).toFixed(0)}% of the page), ` +
            'so the area is not closed. Increase "thicken lines" under Detection, or trace it by hand.',
        )
        if (hit.coverage > 0.5) return
      } else {
        setStatus(wandStatus(hit))
      }
      addRegion(hit.outline, hit.holes, 'detected')
    },
    [doc.raster, doc.calibration, detect, wand, addRegion],
  )

  const applyScale = useCallback(() => {
    const metres = Number(scaleMetres)
    if (scalePts.length < 2 || !Number.isFinite(metres) || metres <= 0) return
    const cal = calibrateByDistance(scalePts[0], scalePts[1], metres)
    if (!cal) return
    // Keep the origin the user already chose; only the scale is being measured here.
    onChange((d) => ({ ...d, calibration: { ...cal, origin: d.calibration.origin } }))
    setScalePts([])
    setStatus(`Scale set: ${cal.pixelsPerMetre.toFixed(1)} px per metre.`)
    onTool('select')
  }, [scalePts, scaleMetres, onChange, onTool])

  // ------------------------------------------------------------------- pointers

  const hitVertex = useCallback(
    (p: Px): { regionId: string; index: number } | null => {
      const r = doc.regions.find((x) => x.id === selected)
      if (!r) return null
      const tol = VERTEX_HIT_PX / view.scale
      for (let i = 0; i < r.vertices.length; i++) {
        if (pxDistance(r.vertices[i].p, p) <= tol) return { regionId: r.id, index: i }
      }
      return null
    },
    [doc.regions, selected, view.scale],
  )

  const hitMidpoint = useCallback(
    (p: Px): number | null => {
      const r = doc.regions.find((x) => x.id === selected)
      if (!r || r.vertices.length < 2) return null
      const tol = VERTEX_HIT_PX / view.scale
      for (let i = 0; i < r.vertices.length; i++) {
        const a = r.vertices[i].p
        const b = r.vertices[(i + 1) % r.vertices.length].p
        const m: Px = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
        if (pxDistance(m, p) <= tol) return i
      }
      return null
    },
    [doc.regions, selected, view.scale],
  )

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    canvasRef.current?.setPointerCapture(e.pointerId)
    const raw = eventPoint(e)
    const p = snapped(raw)

    if (e.button === 1 || (e.button === 0 && e.shiftKey && tool === 'select')) {
      drag.current = { kind: 'pan', from: [e.clientX, e.clientY], view }
      return
    }
    if (e.button !== 0) return

    if (tool === 'draw') {
      // A click back on the first corner closes the ring, the way every CAD tool does it.
      if (draft.length >= 3 && pxDistance(draft[0], raw) <= VERTEX_HIT_PX / view.scale) {
        closeDraft()
        return
      }
      setDraft((d) => [...d, p])
      return
    }
    if (tool === 'wand') {
      runWand(raw)
      return
    }
    if (tool === 'scale') {
      setScalePts((s) => (s.length >= 2 ? [p] : [...s, p]))
      return
    }
    if (tool === 'origin') {
      onChange((d) => ({ ...d, calibration: withOrigin(d.calibration, p) }))
      onTool('select')
      return
    }

    // select
    const v = hitVertex(raw)
    if (v) {
      if (e.altKey) {
        patchRegion(v.regionId, (r) =>
          r.vertices.length > 3 ? { ...r, vertices: r.vertices.filter((_, i) => i !== v.index) } : r,
        )
        return
      }
      drag.current = { kind: 'vertex', regionId: v.regionId, index: v.index }
      return
    }
    const mid = hitMidpoint(raw)
    if (mid !== null) {
      patchRegion(selected!, (r) => {
        const a = r.vertices[mid]
        const b = r.vertices[(mid + 1) % r.vertices.length]
        const nv = { p: [(a.p[0] + b.p[0]) / 2, (a.p[1] + b.p[1]) / 2] as Px, z: (a.z + b.z) / 2 }
        const vs = [...r.vertices]
        vs.splice(mid + 1, 0, nv)
        return { ...r, vertices: vs }
      })
      drag.current = { kind: 'vertex', regionId: selected!, index: mid + 1 }
      return
    }
    // Topmost region wins, so a balcony drawn over the stalls is still reachable.
    const hit = [...doc.regions].reverse().find((r) => r.visible && pointInPolygon(raw, r.vertices.map((v2) => v2.p)))
    if (hit) onSelect(hit.id)
    else {
      onSelect(null)
      drag.current = { kind: 'pan', from: [e.clientX, e.clientY], view }
    }
  }

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const raw = eventPoint(e)
    setCursor(tool === 'select' ? raw : snapped(raw))
    const d = drag.current
    if (!d) return
    if (d.kind === 'pan') {
      setView({ ...d.view, tx: d.view.tx + (e.clientX - d.from[0]), ty: d.view.ty + (e.clientY - d.from[1]) })
      return
    }
    const p = snapped(raw)
    patchRegion(d.regionId, (r) => ({
      ...r,
      vertices: r.vertices.map((v, i) => (i === d.index ? { ...v, p } : v)),
    }))
  }

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    canvasRef.current?.releasePointerCapture(e.pointerId)
    drag.current = null
  }

  const onWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    const r = canvasRef.current!.getBoundingClientRect()
    const sx = e.clientX - r.left
    const sy = e.clientY - r.top
    const k = Math.exp(-e.deltaY * 0.0015)
    const scale = Math.max(0.02, Math.min(60, view.scale * k))
    // Zoom about the cursor: the image point under it must not move.
    const [ix, iy] = toImage(sx, sy)
    setView({ scale, tx: sx - ix * scale, ty: sy - iy * scale })
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return
      if (e.key === 'Escape') {
        setDraft([])
        setScalePts([])
        onTool('select')
      } else if (e.key === 'Enter' && draft.length >= 3) {
        closeDraft()
      } else if (e.key === 'Backspace' && draft.length > 0) {
        e.preventDefault()
        setDraft((d) => d.slice(0, -1))
      } else if (e.key === 'v') onTool('select')
      else if (e.key === 'p') onTool('draw')
      else if (e.key === 'w') onTool('wand')
      else if (e.key === 'f') fit()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [draft, closeDraft, onTool, fit])

  // -------------------------------------------------------------------- drawing

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    // CSS sizes the element and this only sets the backing store, read from the box the
    // element actually has. Driving `style.width` from React state instead lets the two
    // drift after a layout change, and a canvas whose box is not where its pixels are is
    // a click that lands somewhere other than where the cursor is — silently.
    const box = { w: canvas.clientWidth, h: canvas.clientHeight }
    if (box.w === 0 || box.h === 0) return
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    canvas.width = Math.max(1, Math.round(box.w * dpr))
    canvas.height = Math.max(1, Math.round(box.h * dpr))
    const ctx = canvas.getContext('2d')!
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    paint(ctx, {
      size: box,
      view,
      doc,
      underlay,
      draft,
      cursor,
      scalePts,
      tool,
      selected,
      planeTypeOf,
      includedIds,
    })
  }, [size, view, doc, underlay, draft, cursor, scalePts, tool, selected, planeTypeOf, includedIds])

  // ---------------------------------------------------------------------- render

  const cal = doc.calibration
  const uncalibrated = cal.source.kind === 'unset'

  return (
    <div className="trace">
      <div className="trace-toolbar">
        {(
          [
            ['select', 'Select', 'V'],
            ['draw', 'Trace', 'P'],
            ['wand', 'Detect region', 'W'],
            ['scale', 'Set scale', ''],
            ['origin', 'Set origin', ''],
          ] as [TraceTool, string, string][]
        ).map(([t, label, key]) => (
          <button
            key={t}
            type="button"
            className={`tool${tool === t ? ' on' : ''}${t === 'scale' && uncalibrated ? ' urgent' : ''}`}
            onClick={() => {
              setDraft([])
              setScalePts([])
              setStatus(null)
              onTool(t)
            }}
            title={`${TOOL_HELP[t]}${key ? ` (${key})` : ''}`}
          >
            {label}
          </button>
        ))}
        <span className="spacer" />
        <label className="check inline">
          <input type="checkbox" checked={snapOn} onChange={(e) => setSnapOn(e.target.checked)} />
          Snap ({doc.paths.length})
        </label>
        <button type="button" onClick={fit} title="Fit the sheet to the window (F)">
          Fit
        </button>
      </div>

      <div className="trace-canvas-wrap" ref={wrapRef}>
        <canvas
          ref={canvasRef}
          className={`trace-canvas tool-${tool}`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={() => setCursor(null)}
          onDoubleClick={() => tool === 'draw' && closeDraft()}
          onWheel={onWheel}
          onContextMenu={(e) => e.preventDefault()}
        />

        {tool === 'scale' && scalePts.length === 2 && (
          <div className="trace-dialog">
            <span>
              That distance is{' '}
              <input
                type="number"
                min="0.001"
                step="0.1"
                value={scaleMetres}
                autoFocus
                onChange={(e) => setScaleMetres(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && applyScale()}
              />{' '}
              m
            </span>
            <button type="button" className="primary" onClick={applyScale}>
              Set scale
            </button>
            <button type="button" onClick={() => setScalePts([])}>
              Cancel
            </button>
          </div>
        )}

        <div className="trace-hint">{status ?? TOOL_HELP[tool]}</div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------- painting

interface PaintState {
  size: { w: number; h: number }
  view: View
  doc: TraceDocument
  underlay: HTMLCanvasElement
  draft: Px[]
  cursor: Px | null
  scalePts: Px[]
  tool: TraceTool
  selected: string | null
  planeTypeOf: (id: string) => PlaneType
  includedIds: Set<string>
}

function paint(ctx: CanvasRenderingContext2D, s: PaintState) {
  const { view, doc, size } = s
  ctx.clearRect(0, 0, size.w, size.h)
  ctx.fillStyle = '#0a1420'
  ctx.fillRect(0, 0, size.w, size.h)

  ctx.save()
  ctx.translate(view.tx, view.ty)
  ctx.scale(view.scale, view.scale)

  ctx.imageSmoothingEnabled = view.scale < 1
  // Dimmed, so traced outlines read clearly on top of the line work.
  ctx.globalAlpha = 0.72
  ctx.drawImage(s.underlay, 0, 0)
  ctx.globalAlpha = 1
  ctx.restore()

  const S = (p: Px): [number, number] => [p[0] * view.scale + view.tx, p[1] * view.scale + view.ty]

  for (const r of doc.regions) {
    if (!r.visible || r.vertices.length < 2) continue
    const isSel = r.id === s.selected
    const colour = PLANE_UI_COLOUR[s.planeTypeOf(r.id)] ?? '#4cc9f0'
    const included = s.includedIds.has(r.id)

    ctx.beginPath()
    r.vertices.forEach((v, i) => {
      const [x, y] = S(v.p)
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    })
    ctx.closePath()
    for (const hole of r.holes) {
      if (hole.length < 3) continue
      ctx.moveTo(...S(hole[0]))
      for (let i = hole.length - 1; i >= 1; i--) ctx.lineTo(...S(hole[i]))
      ctx.closePath()
    }
    ctx.fillStyle = colour
    ctx.globalAlpha = included ? (isSel ? 0.34 : 0.18) : 0.06
    ctx.fill('evenodd')
    ctx.globalAlpha = 1
    ctx.strokeStyle = colour
    ctx.lineWidth = isSel ? 2.5 : 1.5
    ctx.setLineDash(included ? [] : [5, 4])
    ctx.stroke()
    ctx.setLineDash([])

    if (isSel) {
      for (const v of r.vertices) {
        const [x, y] = S(v.p)
        ctx.fillStyle = '#0a1420'
        ctx.strokeStyle = colour
        ctx.lineWidth = 2
        ctx.beginPath()
        ctx.rect(x - 4, y - 4, 8, 8)
        ctx.fill()
        ctx.stroke()
        ctx.fillStyle = '#e8eef5'
        ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace'
        ctx.fillText(`${v.z.toFixed(2)}`, x + 7, y - 6)
      }
      // Midpoint handles: click one to add a corner there.
      ctx.fillStyle = colour
      ctx.globalAlpha = 0.6
      for (let i = 0; i < r.vertices.length; i++) {
        const a = r.vertices[i].p
        const b = r.vertices[(i + 1) % r.vertices.length].p
        const [x, y] = S([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2])
        ctx.beginPath()
        ctx.arc(x, y, 2.5, 0, Math.PI * 2)
        ctx.fill()
      }
      ctx.globalAlpha = 1
    }

    const c = centroid(r.vertices.map((v) => v.p))
    if (c) {
      const [x, y] = S(c)
      ctx.fillStyle = '#e8eef5'
      ctx.font = '12px -apple-system, system-ui, sans-serif'
      ctx.textAlign = 'center'
      ctx.fillText(r.name, x, y)
      ctx.textAlign = 'left'
    }
  }

  // In-progress outline
  if (s.draft.length > 0) {
    ctx.strokeStyle = '#4cc9f0'
    ctx.lineWidth = 2
    ctx.beginPath()
    s.draft.forEach((p, i) => {
      const [x, y] = S(p)
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    })
    if (s.cursor && s.tool === 'draw') ctx.lineTo(...S(s.cursor))
    ctx.stroke()
    for (const p of s.draft) {
      const [x, y] = S(p)
      ctx.fillStyle = '#4cc9f0'
      ctx.fillRect(x - 3, y - 3, 6, 6)
    }
  }

  // Scale line being measured
  if (s.scalePts.length > 0) {
    const a = S(s.scalePts[0])
    const b = s.scalePts[1] ? S(s.scalePts[1]) : s.cursor ? S(s.cursor) : a
    ctx.strokeStyle = '#f2b134'
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.moveTo(...a)
    ctx.lineTo(...b)
    ctx.stroke()
    for (const p of [a, b]) {
      ctx.beginPath()
      ctx.arc(p[0], p[1], 4, 0, Math.PI * 2)
      ctx.fillStyle = '#f2b134'
      ctx.fill()
    }
  }

  drawOriginMarker(ctx, S, doc.calibration)
  if (s.cursor && s.tool !== 'select') drawCursor(ctx, S(s.cursor))
  drawScaleBar(ctx, size, doc.calibration, view.scale)
  drawReadout(ctx, size, doc.calibration, s.cursor)
}

function centroid(pts: Px[]): Px | null {
  if (pts.length === 0) return null
  let x = 0
  let y = 0
  for (const p of pts) {
    x += p[0]
    y += p[1]
  }
  return [x / pts.length, y / pts.length]
}

function drawOriginMarker(ctx: CanvasRenderingContext2D, S: (p: Px) => [number, number], cal: Calibration) {
  const [x, y] = S(cal.origin)
  ctx.strokeStyle = '#5ec98a'
  ctx.lineWidth = 1.5
  ctx.beginPath()
  ctx.moveTo(x - 10, y)
  ctx.lineTo(x + 26, y)
  ctx.moveTo(x, y + 10)
  ctx.lineTo(x, y - 26)
  ctx.stroke()
  ctx.fillStyle = '#5ec98a'
  ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace'
  // Venue +X is image +x and venue +Y is image -y: rows run down the page, the venue
  // runs up it.
  ctx.fillText('+X', x + 29, y + 3)
  ctx.fillText('+Y', x + 4, y - 28)
}

function drawCursor(ctx: CanvasRenderingContext2D, p: [number, number]) {
  ctx.strokeStyle = '#4cc9f0'
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.rect(p[0] - 5, p[1] - 5, 10, 10)
  ctx.stroke()
}

function drawScaleBar(
  ctx: CanvasRenderingContext2D,
  size: { w: number; h: number },
  cal: Calibration,
  viewScale: number,
) {
  const metresPerScreenPx = 1 / (cal.pixelsPerMetre * viewScale)
  const { metres, px } = scaleBarStep(metresPerScreenPx)
  const x = 14
  const y = size.h - 20
  ctx.strokeStyle = '#93a8bd'
  ctx.fillStyle = '#93a8bd'
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.moveTo(x, y)
  ctx.lineTo(x + px, y)
  ctx.moveTo(x, y - 5)
  ctx.lineTo(x, y + 5)
  ctx.moveTo(x + px, y - 5)
  ctx.lineTo(x + px, y + 5)
  ctx.stroke()
  ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace'
  ctx.fillText(`${metres} m${cal.source.kind === 'unset' ? ' (not calibrated)' : ''}`, x, y - 9)
}

function drawReadout(
  ctx: CanvasRenderingContext2D,
  size: { w: number; h: number },
  cal: Calibration,
  cursor: Px | null,
) {
  if (!cursor) return
  const v = pxToVenue(cursor, cal)
  ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace'
  ctx.fillStyle = '#93a8bd'
  ctx.textAlign = 'right'
  ctx.fillText(`x ${v.x.toFixed(2)}  y ${v.y.toFixed(2)} m`, size.w - 14, size.h - 16)
  ctx.textAlign = 'left'
}
