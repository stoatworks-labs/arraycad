import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { type VenueFile } from './lib/dbacv/types.ts'
import { formatDbacvDate, writeDbacv } from './lib/dbacv/write.ts'
import {
  type ImportedNode,
  ACCEPTED_EXTENSIONS,
  ImportError,
  countTriangles,
  flattenNodes,
  importFile,
} from './lib/import/index.ts'
import { convertNodesToSoundvision } from './lib/soundvision/convert.ts'
import { writeSoundvision } from './lib/soundvision/write.ts'
import { convertNodesToEaseFocus } from './lib/easefocus/convert.ts'
import { writeEaseFocus } from './lib/easefocus/write.ts'
import { type TraceDocument, type WandOptions, DEFAULT_WAND, buildTraceScene } from './lib/trace/index.ts'
import type { InkMaskOptions } from './lib/trace/raster.ts'
import { TRACE_EXTENSIONS, isTraceFile, loadTraceSource } from './lib/trace/source.ts'
import { UNIT_PRESETS, withOriginAt } from './lib/geom/transform.ts'
import {
  type PrepareSettings,
  type Prepared,
  type Settings,
  type ViewMode,
  DEFAULT_PREPARE_SETTINGS,
  DEFAULT_SETTINGS,
  applyPlan,
  conversionEntries,
  convertOptions,
  mergeDecisions,
  newRationalisation,
  prepareScene,
  rationalisationsFromPlan,
  rationalisedAreas,
  seedDecisions,
  settingsForScene,
  subtreeIds,
  useConversion,
  useDebounced,
  useRationalisations,
} from './state.ts'
import { type CameraPreset, type ViewportTool, Viewport } from './components/Viewport.tsx'
import { PreparePanel } from './components/PreparePanel.tsx'
import { RationalisePanel } from './components/RationalisePanel.tsx'
import { Tree } from './components/Tree.tsx'
import { Inspector } from './components/Inspector.tsx'
import { type TraceTool, TraceEditor } from './components/TraceEditor.tsx'
import { TracePanel } from './components/TracePanel.tsx'
import { Field, NumberInput, Panel, Segmented, Stat } from './components/ui.tsx'
import type { Decisions, NodeDecision } from './state.ts'

const ALL_EXTENSIONS = [...ACCEPTED_EXTENSIONS, ...TRACE_EXTENSIONS]

/** What the centre of the screen shows while tracing. */
type TraceView = 'drawing' | 'model' | 'both'

function download(content: string | Uint8Array, filename: string, mime: string) {
  const url = URL.createObjectURL(new Blob([content as BlobPart], { type: mime }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

export default function App() {
  const [prepared, setPrepared] = useState<Prepared | null>(null)
  const [prepareOptions, setPrepareOptions] = useState<PrepareSettings>(DEFAULT_PREPARE_SETTINGS)
  const [traceDoc, setTraceDoc] = useState<TraceDocument | null>(null)
  const [traceFile, setTraceFile] = useState<File | null>(null)
  const [decisions, setDecisions] = useState<Decisions>({})
  const [settings, setSettings] = useState<Settings | null>(null)
  const [selection, setSelection] = useState<string[]>([])
  const [view, setView] = useState<ViewMode>('both')
  const [traceView, setTraceView] = useState<TraceView>('drawing')
  const [traceTool, setTraceTool] = useState<TraceTool>('select')
  const [detect, setDetect] = useState<InkMaskOptions>({
    threshold: 'auto',
    invert: false,
    ignoreColour: false,
    lineThickenPx: 1,
  })
  const [wand, setWand] = useState<WandOptions>(DEFAULT_WAND)
  const [ramp, setRamp] = useState({ from: 0, to: 1, zFrom: 0, zTo: 1, flat: 0 })
  const [preset, setPreset] = useState<CameraPreset>('iso')
  const [presetNonce, setPresetNonce] = useState(0)
  const [tool, setTool] = useState<ViewportTool>(null)
  const [drawnPoints, setDrawnPoints] = useState<[number, number][]>([])
  const [error, setError] = useState<{ message: string; advice: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const [projectName, setProjectName] = useState('Untitled')

  // Tracing rebuilds the scene on every dragged corner, so the build is debounced rather
  // than run per pointer event. The 3D preview lags the drawing by a frame or two, which
  // is the right trade: the drawing itself is repainted immediately.
  const settledDoc = useDebounced(traceDoc, 150)
  const tracedScene = useMemo(() => (settledDoc ? buildTraceScene(settledDoc) : null), [settledDoc])
  const scene = traceDoc ? tracedScene : prepared?.scene ?? null
  const tracing = traceDoc !== null
  /** Whether the 3D view is on screen at all — while tracing the drawing can have it all. */
  const modelVisible = !traceDoc || traceView !== 'drawing'

  const nodesById = useMemo(() => {
    const m = new Map<string, ImportedNode>()
    if (scene) for (const n of flattenNodes(scene.nodes)) m.set(n.id, n)
    return m
  }, [scene])

  /**
   * Preparation is a set of decisions about the scene, so it is seeded here with the rest.
   *
   * `prepared` is in the dependencies as well as the scene, and has to be: re-running
   * preparation with a box unticked leaves the scene object untouched whenever nothing was
   * re-cut, so keying on the scene alone would tick the box and change nothing.
   */
  useEffect(() => {
    if (!scene) {
      setDecisions({})
      return
    }
    setDecisions((prev) =>
      tracing ? mergeDecisions(prev, scene) : applyPlan(seedDecisions(scene), prepared?.plan ?? null),
    )
  }, [scene, tracing, prepared])

  const { rationalisations, add: addRationalisation, update: updateRationalisation, remove: removeRationalisation } =
    useRationalisations(
      prepared ?? scene,
      useMemo(() => rationalisationsFromPlan(prepared?.plan ?? null), [prepared]),
    )

  // Every viewport tool is modal and belongs to the 3D view. Escape leaves, and so does
  // anything that takes the view away: an armed tool with nothing to click under it is a
  // trap, and the only sign of it would be a click that moved the venue.
  //
  // The area tool owns Escape itself, to clear a half-drawn ring rather than disarm — one
  // stray corner should cost a keypress, not the whole outline.
  useEffect(() => {
    if (!tool) return
    if (!modelVisible) {
      setTool(null)
      return
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && tool !== 'area') setTool(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [tool, modelVisible])

  const { result, areas, running } = useConversion(scene, decisions, settings, rationalisations)
  const areaStats = useMemo(() => new Map(areas.map((a) => [a.id, a.stats])), [areas])

  const load = useCallback(
    async (file: File) => {
      setBusy(true)
      setError(null)
      setTool(null)
      setDrawnPoints([])
      try {
        if (isTraceFile(file.name)) {
          const doc = await loadTraceSource(file)
          setTraceDoc(doc)
          setTraceFile(file)
          setPrepared(null)
          setTraceView('drawing')
          setTraceTool(doc.calibration.source.kind === 'unset' ? 'scale' : 'select')
          // A trace is authored in metres with Z up by construction, so there is nothing for
          // the units guess to do — but heading, offset and mirror still matter.
          setSettings({
            ...DEFAULT_SETTINGS,
            transform: { ...DEFAULT_SETTINGS.transform, unitsPerMetre: 1, upAxis: 'z' },
            // The outline is exactly what the user drew; there is no CAD noise to shave off.
            simplifyTolerance: 0,
          })
        } else {
          const s = await importFile(file)
          // The settings the file itself implies, decided BEFORE preparation, because
          // preparation's thresholds are in metres and it needs the scale to read them.
          const seeded = settingsForScene(s)
          setSettings(seeded)
          setPrepared(prepareScene(s, seeded.transform, prepareOptions))
          setTraceDoc(null)
          setTraceFile(null)
        }
        setSelection([])
        setProjectName(file.name.replace(/\.[^.]+$/, '') || 'Untitled')
        setPresetNonce((n) => n + 1)
      } catch (e) {
        if (e instanceof ImportError) setError({ message: e.message, advice: e.advice })
        else setError({ message: (e as Error).message, advice: '' })
        setPrepared(null)
        setTraceDoc(null)
      } finally {
        setBusy(false)
      }
    },
    [prepareOptions],
  )

  /**
   * Re-run preparation with a box ticked or unticked.
   *
   * From the RAW scene every time, never from the prepared one: re-cutting is the only part
   * that touches geometry, and running it twice over its own output would keep the second
   * run's tolerances working on the first run's triangles. Against the CURRENT transform,
   * not the one the import guessed — fixing the units and re-running is the whole reason
   * this is offered rather than being a one-shot at import.
   *
   * Pruning already done by hand is thrown away with it, which is why nothing calls this
   * except a deliberate click on a checkbox.
   */
  const rerunPreparation = useCallback(
    (patch: Partial<PrepareSettings>) => {
      const options = { ...prepareOptions, ...patch }
      setPrepareOptions(options)
      if (!prepared || !settings) return
      setBusy(true)
      // Out of the click handler: re-cutting a large model blocks the main thread, and the
      // checkbox should be seen to tick before the tab stops answering.
      setTimeout(() => {
        try {
          setPrepared(prepareScene(prepared.raw, settings.transform, options))
        } finally {
          setBusy(false)
        }
      }, 0)
    },
    [prepareOptions, prepared, settings],
  )

  /** Move to another page of the same PDF, keeping nothing — a new page is a new drawing. */
  const loadPage = useCallback(
    async (index: number) => {
      if (!traceFile) return
      setBusy(true)
      try {
        const doc = await loadTraceSource(traceFile, { pageIndex: index })
        setTraceDoc(doc)
        setSelection([])
      } catch (e) {
        setError({ message: (e as Error).message, advice: '' })
      } finally {
        setBusy(false)
      }
    },
    [traceFile],
  )

  const updateDecisions = useCallback((ids: string[], patch: Partial<NodeDecision>) => {
    setDecisions((prev) => {
      const next = { ...prev }
      for (const id of ids) if (next[id]) next[id] = { ...next[id], ...patch }
      return next
    })
  }, [])

  const select = useCallback((id: string, additive: boolean) => {
    setSelection((prev) => (additive ? (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]) : [id]))
  }, [])

  const selectMatchingTag = useCallback(
    (tag: string) => {
      if (!scene) return
      setSelection(flattenNodes(scene.nodes).filter((n) => n.tags.includes(tag)).map((n) => n.id))
    },
    [scene],
  )

  const patchSettings = useCallback((patch: Partial<Settings>) => {
    setSettings((s) => (s ? { ...s, ...patch } : s))
  }, [])

  /**
   * Take a point clicked in the 3D view as the venue origin.
   *
   * One shot. The result is immediately visible — the axes land on the point picked — and
   * the click after that nearly always means "select that object", so leaving the tool
   * armed would move the venue again just as the user goes back to work.
   */
  const takeOrigin = useCallback((p: { x: number; y: number; z: number }) => {
    setSettings((s) => (s ? { ...s, transform: withOriginAt(s.transform, p) } : s))
    setTool(null)
  }, [])

  const ratSeq = useRef(0)

  /**
   * Name a new area after what it was made from.
   *
   * The members' shared leading words when they have any — forty nodes called
   * `STALLS ROW A`…`STALLS ROW T` make "STALLS", which is the name a person would have
   * given it. Falls back to a number, never to the first member's name: "TIER 3 - CEILING
   * LEFT 1" as the label for the whole tier reads as a mistake rather than as a summary.
   */
  const nameFor = useCallback(
    (ids: string[]): string => {
      const names = ids.map((id) => nodesById.get(id)?.name ?? '').filter(Boolean)
      if (names.length > 0) {
        const words = names.map((n) => n.split(/\s+/))
        const shared: string[] = []
        for (let i = 0; i < words[0].length; i++) {
          const w = words[0][i]
          if (words.every((ws) => ws[i] === w)) shared.push(w)
          else break
        }
        const label = shared.join(' ').replace(/[-–—:,]+$/, '').trim()
        if (label.length >= 2) return label
      }
      return `Area ${++ratSeq.current}`
    },
    [nodesById],
  )

  const createFromSelection = useCallback(() => {
    if (selection.length === 0) return
    const members = selection.filter((id) => (nodesById.get(id)?.positions.length ?? 0) > 0)
    if (members.length === 0) return
    addRationalisation(newRationalisation(`rat${++ratSeq.current}`, nameFor(members), members))
    setSelection([])
  }, [selection, nodesById, addRationalisation, nameFor])

  /**
   * A drawn area captures what is under it — narrowed by the selection when there is one.
   *
   * The two halves of the answer compose, and they have to. Drawing alone cannot say
   * WHICH surfaces under the polygon are wanted: draw round a seating block and the floor
   * beneath it, its stage edge and any structure overhead all fall inside too, and one
   * plane fitted through seats and floor together sits between them — a listening plane
   * half a seat height too low, which the residual reports but nobody asked for.
   *
   * So the tree says what kind of thing, and the polygon says where. Select the seating
   * layer and draw round the left bank, and the clip in `capture` discards both the right
   * bank and the floor. With nothing selected it still falls back to everything included,
   * because that is the reasonable reading of drawing with no other instruction.
   */
  const createFromArea = useCallback(
    (footprint: [number, number][]) => {
      if (!scene || footprint.length < 3) return
      const chosen = selection.filter((id) => (nodesById.get(id)?.positions.length ?? 0) > 0)
      const members =
        chosen.length > 0
          ? chosen
          : flattenNodes(scene.nodes)
              .filter((n) => n.positions.length > 0 && decisions[n.id]?.include)
              .map((n) => n.id)
      if (members.length === 0) return
      const id = `rat${++ratSeq.current}`
      addRationalisation({
        ...newRationalisation(id, chosen.length > 0 ? nameFor(chosen) : `Area ${ratSeq.current}`, members),
        footprint,
        // Drawing the boundary is a statement about where the area is. Following the
        // captured geometry instead would sand the drawn corners back off again.
        mode: 'footprint',
        // A drawn area nearly always covers part of a node, so replacing the whole node
        // would take the rest of the layer with it. The panel offers it; it is not assumed.
        replaceMembers: false,
      })
      setTool(null)
      setDrawnPoints([])
    },
    [scene, decisions, addRationalisation, selection, nodesById, nameFor],
  )

  const marqueeSelect = useCallback((ids: string[], additive: boolean) => {
    setSelection((prev) => (additive ? [...new Set([...prev, ...ids])] : ids))
  }, [])

  const patchDoc = useCallback((updater: (d: TraceDocument) => TraceDocument) => {
    setTraceDoc((d) => (d ? updater(d) : d))
  }, [])

  const exportFile = useCallback(() => {
    if (!result || result.objects.length === 0) return
    const venue: VenueFile = {
      // The version this format was reverse-engineered from. ArrayCalc reads its own older
      // files, so claiming the version we actually understand is the honest choice.
      appVersion: '12.8.2',
      venueVersion: '9',
      projectName,
      date: formatDbacvDate(),
      author: 'ArrayCAD',
      projectComments: '',
      venueComments: `Converted from ${scene?.format ?? 'CAD'} by ArrayCAD.`,
      objects: result.objects,
    }
    download(writeDbacv(venue), `${projectName || 'venue'}.dbacv`, 'application/xml')
  }, [result, projectName, scene])

  /**
   * Soundvision's native scene file is encrypted, so the target here is the 3D room data
   * text format its own SketchUp and Vectorworks plug-ins write — see
   * docs/soundvision-format.md. It is converted on demand rather than alongside the live
   * ArrayCalc result: nothing on screen depends on it, and planarising twice on every
   * slider movement would halve the frame rate for a file most sessions never export.
   */
  const exportSoundvision = useCallback(() => {
    if (!scene || !settings?.transform) return
    // Rationalised areas are recomputed here rather than taken from the live ArrayCalc
    // result, because that result holds RoomObjects — already through the canonical quad
    // frame and possibly split into triangles to fit it. Soundvision wants the outline
    // whole, so it starts from the same outlines the other target did.
    const { areas: exportAreas, effective } = rationalisedAreas(scene, rationalisations, settings)
    const r = convertNodesToSoundvision(
      conversionEntries(scene, decisions, effective),
      { ...convertOptions(settings), winding: 'up' },
      exportAreas,
    )
    if (r.scene.faces.length === 0) return
    download(writeSoundvision(r.scene), `${projectName || 'venue'}.txt`, 'text/plain')
  }, [scene, decisions, settings, projectName, rationalisations])

  /**
   * EASE Focus has no geometry import at all — its guide offers typed coordinates or
   * tracing over a picture — so the project file itself is the only route in, and this
   * export writes one. Same on-demand pattern as the Soundvision export, and the same
   * reason it starts from outlines rather than the live ArrayCalc result: a zone wants
   * the plane whole, not the canonical quad frame.
   */
  const exportEaseFocus = useCallback(() => {
    if (!scene || !settings?.transform) return
    const { areas: exportAreas, effective } = rationalisedAreas(scene, rationalisations, settings)
    const r = convertNodesToEaseFocus(
      conversionEntries(scene, decisions, effective),
      convertOptions(settings),
      exportAreas,
      projectName || 'ArrayCAD export',
    )
    if (r.project.zones.length === 0) return
    download(writeEaseFocus(r.project), `${projectName || 'venue'}.fc3`, 'application/octet-stream')
  }, [scene, decisions, settings, projectName, rationalisations])

  // ---------------------------------------------------------------- render

  if (!scene || !settings) {
    return (
      <div className="app">
        <Topbar />
        <main
          className={`dropzone${dragOver ? ' over' : ''}`}
          onDragOver={(e) => {
            e.preventDefault()
            setDragOver(true)
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault()
            setDragOver(false)
            const f = e.dataTransfer.files[0]
            if (f) void load(f)
          }}
        >
          <div className="drop-inner">
            <h1>Drop a CAD model, a venue file, a PDF or a plan</h1>
            <p className="muted">
              or{' '}
              <button type="button" className="linkbtn" onClick={() => fileInput.current?.click()}>
                choose a file
              </button>
            </p>
            <input
              ref={fileInput}
              type="file"
              hidden
              accept={ALL_EXTENSIONS.join(',')}
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) void load(f)
              }}
            />
            <p className="formats">{ALL_EXTENSIONS.join('  ·  ')}</p>
            {busy && <p className="muted">Reading…</p>}
            {error && (
              <div className="error">
                <strong>{error.message}</strong>
                {error.advice && <p>{error.advice}</p>}
              </div>
            )}
            <p className="pitch">
              ArrayCAD turns a CAD model into a d&amp;b ArrayCalc venue. It merges the
              model's triangles back into flat planes, lets you throw away everything
              ArrayCalc does not need, and lets you say what each surface is — then writes a{' '}
              <code>.dbacv</code>.
            </p>
            <p className="pitch">
              No 3D model? Drop a <strong>PDF or an image of the plan</strong> instead. Set
              the scale off a dimension you know, click inside a room to detect its outline
              or trace it by hand, and type a height at each corner — level, raked, raised or
              sunk.
            </p>
            <p className="pitch">
              Already have a venue? Drop an ArrayCalc <code>.dbacv</code>, an L-Acoustics
              Soundvision 3D room data <code>.txt</code> or an EASE Focus 3 project{' '}
              <code>.fc3</code> and <strong>convert between the three</strong> — any one
              opens here, and any one comes back out.
            </p>
          </div>
        </main>
      </div>
    )
  }

  const totalTris = countTriangles(scene.nodes)
  const includedIds = new Set(Object.entries(decisions).filter(([, d]) => d.include).map(([id]) => id))
  const traceSelected = selection.length === 1 && traceDoc?.regions.some((r) => r.id === selection[0])
    ? selection[0]
    : null

  return (
    <div className="app">
      <Topbar>
        <span className="file-chip">
          {scene.format} · {scene.sourceName}
        </span>
        <button type="button" onClick={() => fileInput.current?.click()}>
          Open another…
        </button>
        <input
          ref={fileInput}
          type="file"
          hidden
          accept={ALL_EXTENSIONS.join(',')}
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) void load(f)
          }}
        />
        <span className="spacer" />
        <input
          className="project-name"
          value={projectName}
          onChange={(e) => setProjectName(e.target.value)}
          aria-label="Project name"
        />
        {/*
          The "experimental" tag came off on 2026-08-02: a file written by this code was
          imported into Soundvision 3.18.0.15 and every surface read back with the exact
          coordinates written, a six-point polygon staying one surface. See
          docs/soundvision-format.md section 6.

          The tooltip still carries a warning, and that is not leftover hedging — it names a
          DIFFERENT risk. Geometry landing correctly and a surface returning a mapping result
          are separate claims, and a backwards surface fails the second one silently. Keep
          this caveat until a prediction has actually been run over an imported surface.
        */}
        {/*
          Verified against EASE Focus 3.1.260 on 2026-08-03: files from this writer load,
          re-save with every zone value intact, and register their areas for mapping. The
          caveat in the tooltip is the reduction, not the format: EASE Focus has only
          rectangular zones, so this export is the lossiest of the three targets.
        */}
        <button
          type="button"
          onClick={exportEaseFocus}
          disabled={!result || result.objects.length === 0}
          title={
            'EASE Focus 3 project — audience (Listening) planes only, each reduced to an ' +
            'oriented rectangular zone with a height profile. EASE Focus has no geometry ' +
            'import, so opening this file IS the way in.\n\n' +
            'Walls, stages and ceilings have no equivalent in EASE Focus and are left out.'
          }
        >
          Export .fc3
        </button>
        <button
          type="button"
          onClick={exportSoundvision}
          disabled={!result || result.objects.length === 0}
          title={
            'Soundvision 3D room data — import with 3D room data > Import 3D room data.\n\n' +
            'Geometry is confirmed to import correctly into Soundvision 3.18.0.15. Not yet ' +
            'confirmed: that an imported surface returns a mapping result — a face wound the ' +
            'wrong way predicts nothing, silently. Check a mapping before trusting a design.'
          }
        >
          Export .txt
        </button>
        <button
          type="button"
          className="primary"
          onClick={exportFile}
          disabled={!result || result.objects.length === 0}
        >
          Export .dbacv
        </button>
      </Topbar>

      <div className="layout">
        <aside className={traceDoc ? 'left tracing' : 'left'}>
          {traceDoc ? (
            <TracePanel
              doc={traceDoc}
              onChange={patchDoc}
              selected={traceSelected}
              onSelect={(id) => setSelection(id ? [id] : [])}
              decisions={decisions}
              onUpdateDecisions={updateDecisions}
              detect={detect}
              onDetect={(p) => setDetect((d) => ({ ...d, ...p }))}
              wand={wand}
              onWand={(p) => setWand((w) => ({ ...w, ...p }))}
              onPage={(i) => void loadPage(i)}
              ramp={ramp}
              onRamp={(p) => setRamp((r) => ({ ...r, ...p }))}
            />
          ) : (
            <Panel title="Objects">
              <Tree
                nodes={scene.nodes}
                decisions={decisions}
                selection={selection}
                onSelect={select}
                onUpdate={updateDecisions}
                subtreeIds={subtreeIds}
              />
            </Panel>
          )}
        </aside>

        <main className="centre">
          <div className="view-toolbar">
            {traceDoc ? (
              <Segmented
                value={traceView}
                onChange={setTraceView}
                options={[
                  { value: 'drawing', label: 'Drawing' },
                  { value: 'model', label: '3D' },
                  { value: 'both', label: 'Both' },
                ]}
              />
            ) : (
              <Segmented
                value={view}
                onChange={setView}
                options={[
                  { value: 'source', label: 'Source' },
                  { value: 'converted', label: 'Planes' },
                  { value: 'both', label: 'Both' },
                ]}
              />
            )}
            <span className="spacer" />
            {(!traceDoc || traceView !== 'drawing') && (
              <Segmented
                value={preset}
                onChange={(p) => {
                  setPreset(p)
                  setPresetNonce((n) => n + 1)
                }}
                options={[
                  { value: 'iso', label: 'Iso' },
                  { value: 'plan', label: 'Plan' },
                  { value: 'section', label: 'Section' },
                  { value: 'front', label: 'Front' },
                ]}
              />
            )}
          </div>

          <div className={`stage${traceDoc && traceView === 'both' ? ' split' : ''}`}>
            {traceDoc && traceView !== 'model' && (
              <TraceEditor
                doc={traceDoc}
                onChange={patchDoc}
                tool={traceTool}
                onTool={setTraceTool}
                selected={traceSelected}
                onSelect={(id) => setSelection(id ? [id] : [])}
                detect={detect}
                wand={wand}
                planeTypeOf={(id) => decisions[id]?.planeType ?? traceDoc.regions.find((r) => r.id === id)!.planeType}
                includedIds={includedIds}
              />
            )}
            {(!traceDoc || traceView !== 'drawing') && (
              <Viewport
                nodes={scene.nodes}
                decisions={decisions}
                converted={result?.objects ?? []}
                transform={settings.transform}
                view={traceDoc ? 'converted' : view}
                selection={selection}
                onSelect={select}
                preset={preset}
                presetNonce={presetNonce}
                tool={tool}
                onPickOrigin={takeOrigin}
                onMarquee={marqueeSelect}
                onAreaPoints={setDrawnPoints}
                onAreaDone={createFromArea}
              />
            )}
          </div>

          <div className="stats">
            <Stat
              label={traceDoc ? 'traced corners' : 'source triangles'}
              value={
                traceDoc
                  ? traceDoc.regions.reduce((n, r) => n + r.vertices.length, 0).toLocaleString()
                  : totalTris.toLocaleString()
              }
            />
            <Stat label="flat regions found" value={(result?.stats.regionsFound ?? 0).toLocaleString()} />
            <Stat
              label="ArrayCalc objects"
              value={running ? '…' : (result?.stats.objectsOut ?? 0).toLocaleString()}
              tone={(result?.stats.objectsOut ?? 0) > 300 ? 'warn' : 'ok'}
            />
            {(result?.stats.quadsSplit ?? 0) > 0 && (
              <Stat
                label="split into triangles"
                value={(result?.stats.quadsSplit ?? 0).toLocaleString()}
                tone="warn"
              />
            )}
          </div>
        </main>

        <aside className="right">
          <Panel title="Selection">
            <Inspector
              selection={selection}
              nodesById={nodesById}
              decisions={decisions}
              onUpdate={updateDecisions}
              onSelectMatchingTag={selectMatchingTag}
            />
          </Panel>

          {/* A traced drawing has nothing to prepare: the user drew exactly the regions they
              wanted, so there is no clutter to leave out and nothing repeated to gather. */}
          {traceDoc || !prepared ? null : (
            <Panel title="Prepare">
              <PreparePanel prepared={prepared} busy={busy} onChange={rerunPreparation} />
            </Panel>
          )}

          {/* Tracing draws its regions directly, so there is nothing scattered to gather up
              — the tracer never produces one object per seat in the first place. */}
          {traceDoc ? null : (
            <Panel title="Rationalise">
              <RationalisePanel
                rationalisations={rationalisations}
                statsById={areaStats}
                selectionCount={selection.length}
                drawingPoints={drawnPoints.length}
                tool={tool === 'marquee' || tool === 'area' ? tool : null}
                onTool={(t) => setTool(t)}
                onCreateFromSelection={createFromSelection}
                onUpdate={updateRationalisation}
                onRemove={removeRationalisation}
                onSelectMembers={setSelection}
              />
            </Panel>
          )}

          <Panel title="Placement">
            {traceDoc ? (
              <p className="hint">
                A traced drawing is already in metres with Z up — the scale is set on the
                drawing itself. Heading, offset and mirror below still apply, and are how the
                room gets aimed down the venue +X axis.
              </p>
            ) : (
              <>
                <Field label="Source units" hint="What one unit in the source file means.">
                  <select
                    value={settings.transform.unitsPerMetre}
                    onChange={(e) =>
                      patchSettings({
                        transform: { ...settings.transform, unitsPerMetre: Number(e.target.value) },
                      })
                    }
                  >
                    {UNIT_PRESETS.map((u) => (
                      <option key={u.label} value={u.unitsPerMetre}>
                        {u.label}
                      </option>
                    ))}
                  </select>
                </Field>
                {scene.unitsPerMetre === undefined && (
                  <p className="hint warn-text">
                    This format does not declare its units — the value above is a guess from the
                    model's overall size. Check it against a dimension you know.
                  </p>
                )}

                <Field label="Up axis" hint="Which source axis points up. ArrayCalc is Z-up.">
                  <Segmented
                    value={settings.transform.upAxis}
                    onChange={(v) => patchSettings({ transform: { ...settings.transform, upAxis: v } })}
                    options={[
                      { value: 'z', label: 'Z up' },
                      { value: 'y', label: 'Y up' },
                    ]}
                  />
                </Field>
              </>
            )}

            <Field label="Heading" hint="Rotate about the vertical so the audience faces +X.">
              <NumberInput
                value={settings.transform.headingDeg}
                step={5}
                suffix="°"
                onChange={(v) => patchSettings({ transform: { ...settings.transform, headingDeg: v } })}
              />
            </Field>

            <div className="origin-head">
              <span className="field-label">Origin</span>
              <button
                type="button"
                className={`tool${tool === 'origin' ? ' on' : ''}`}
                disabled={!modelVisible}
                onClick={() => setTool((t) => (t === 'origin' ? null : 'origin'))}
                title={
                  modelVisible
                    ? 'Click a point on the model in the 3D view to put the venue origin there.'
                    : 'Show the 3D view to pick an origin — the drawing has its own Set origin tool.'
                }
              >
                {tool === 'origin' ? 'Click a point…' : 'Pick in view'}
              </button>
            </div>
            {tool === 'origin' ? (
              <p className="hint">
                Click any point on the model and it becomes 0, 0, 0 — the axes move there.
                Near a corner it snaps to the corner and the marker turns blue. Esc cancels.
                Set <strong>Heading</strong> first: turning the room afterwards swings it
                about the model's own datum and carries the origin off zero.
              </p>
            ) : (
              <p className="hint">
                Where the model sits relative to the venue origin. Type it, or pick a point
                off the model itself.
              </p>
            )}

            <div className="row3">
              <Field label="Offset X">
                <NumberInput
                  value={settings.transform.offset.x}
                  step={0.5}
                  suffix="m"
                  onChange={(v) =>
                    patchSettings({
                      transform: { ...settings.transform, offset: { ...settings.transform.offset, x: v } },
                    })
                  }
                />
              </Field>
              <Field label="Y">
                <NumberInput
                  value={settings.transform.offset.y}
                  step={0.5}
                  suffix="m"
                  onChange={(v) =>
                    patchSettings({
                      transform: { ...settings.transform, offset: { ...settings.transform.offset, y: v } },
                    })
                  }
                />
              </Field>
              <Field label="Z">
                <NumberInput
                  value={settings.transform.offset.z}
                  step={0.5}
                  suffix="m"
                  onChange={(v) =>
                    patchSettings({
                      transform: { ...settings.transform, offset: { ...settings.transform.offset, z: v } },
                    })
                  }
                />
              </Field>
            </div>

            <label className="check">
              <input
                type="checkbox"
                checked={settings.transform.flipX}
                onChange={(e) =>
                  patchSettings({ transform: { ...settings.transform, flipX: e.target.checked } })
                }
              />
              Mirror along X (stage came out at the wrong end)
            </label>
          </Panel>

          <Panel title="Simplification">
            <Field label="Fit" hint="How each flat region becomes ArrayCalc geometry.">
              <Segmented
                value={settings.fit}
                onChange={(v) => patchSettings({ fit: v })}
                options={[
                  { value: 'exact', label: 'Follow outline' },
                  { value: 'rect', label: 'Rectangle' },
                ]}
              />
            </Field>
            <p className="hint">
              {settings.fit === 'rect'
                ? 'Every region becomes one rectangle, aligned to the level direction of its own plane so it is always writable as a single ArrayCalc quad. Usually what you want for seating blocks.'
                : 'Outlines are kept and split into quads and triangles. Faithful, but a ragged CAD outline makes many objects.'}
            </p>
            {(result?.stats.quadsSplit ?? 0) > 0 && (
              <p className="hint warn-text">
                {result!.stats.quadsSplit} face(s) could not be written as an ArrayCalc quad
                and became two triangles each. ArrayCalc quads must be symmetric trapezoids
                with level edges; anything else has to be split. Rectangle fit avoids most
                of it.
              </p>
            )}

            <Field label="Merge angle" hint="How far a triangle's normal may sit from the region's.">
              <NumberInput
                value={settings.planarize.angleTolerance}
                step={1}
                min={0.5}
                max={45}
                suffix="°"
                onChange={(v) => patchSettings({ planarize: { ...settings.planarize, angleTolerance: v } })}
              />
            </Field>

            <Field label="Merge offset" hint="How far off the region plane a triangle may sit.">
              <NumberInput
                value={settings.planarize.offsetTolerance}
                step={0.01}
                min={0}
                suffix="m"
                onChange={(v) => patchSettings({ planarize: { ...settings.planarize, offsetTolerance: v } })}
              />
            </Field>

            <Field label="Outline tolerance" hint="How much detail to shave off the recovered outline.">
              <NumberInput
                value={settings.simplifyTolerance}
                step={0.01}
                min={0}
                suffix="m"
                onChange={(v) => patchSettings({ simplifyTolerance: v })}
              />
            </Field>

            <Field label="Drop regions under" hint="Small stray facets: fixings, trim, noise.">
              <NumberInput
                value={settings.planarize.minArea}
                step={0.05}
                min={0}
                suffix="m²"
                onChange={(v) => patchSettings({ planarize: { ...settings.planarize, minArea: v } })}
              />
            </Field>

            <Field label="Max objects per source object" hint="0 for no limit. Keeps the largest regions.">
              <NumberInput
                value={settings.maxObjectsPerNode}
                step={1}
                min={0}
                onChange={(v) => patchSettings({ maxObjectsPerNode: Math.max(0, Math.round(v)) })}
              />
            </Field>
          </Panel>

          {(scene.warnings.length > 0 || (result?.warnings.length ?? 0) > 0) && (
            <Panel title="Notes">
              <ul className="warnings">
                {scene.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
                {[...new Set(result?.warnings ?? [])].slice(0, 8).map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </Panel>
          )}
        </aside>
      </div>
    </div>
  )
}

function Topbar({ children }: { children?: React.ReactNode }) {
  return (
    <header className="topbar">
      <span className="brand">
        ArrayCAD <em>CAD → ArrayCalc</em>
      </span>
      {children}
      {/* Opens the shared About dialog — see public/about.js, which delegates
          this attribute from the document, so nothing needs importing here.
          Inside Topbar rather than at each call site, so it is on both screens. */}
      <button type="button" className="topbar-about" data-stoatworks-about>
        About
      </button>
    </header>
  )
}
