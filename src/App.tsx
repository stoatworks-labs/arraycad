import { useCallback, useMemo, useRef, useState } from 'react'
import { type VenueFile } from './lib/dbacv/types.ts'
import { formatDbacvDate, writeDbacv } from './lib/dbacv/write.ts'
import {
  type ImportedNode,
  type ImportedScene,
  ACCEPTED_EXTENSIONS,
  ImportError,
  countTriangles,
  flattenNodes,
  importFile,
} from './lib/import/index.ts'
import { UNIT_PRESETS } from './lib/geom/transform.ts'
import {
  type Settings,
  type ViewMode,
  seedDecisions,
  settingsForScene,
  subtreeIds,
  useConversion,
} from './state.ts'
import { type CameraPreset, Viewport } from './components/Viewport.tsx'
import { Tree } from './components/Tree.tsx'
import { Inspector } from './components/Inspector.tsx'
import { Field, NumberInput, Panel, Segmented, Stat } from './components/ui.tsx'
import type { Decisions, NodeDecision } from './state.ts'

export default function App() {
  const [scene, setScene] = useState<ImportedScene | null>(null)
  const [decisions, setDecisions] = useState<Decisions>({})
  const [settings, setSettings] = useState<Settings | null>(null)
  const [selection, setSelection] = useState<string[]>([])
  const [view, setView] = useState<ViewMode>('both')
  const [preset, setPreset] = useState<CameraPreset>('iso')
  const [presetNonce, setPresetNonce] = useState(0)
  const [error, setError] = useState<{ message: string; advice: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const [projectName, setProjectName] = useState('Untitled')

  const nodesById = useMemo(() => {
    const m = new Map<string, ImportedNode>()
    if (scene) for (const n of flattenNodes(scene.nodes)) m.set(n.id, n)
    return m
  }, [scene])

  const { result, running } = useConversion(scene, decisions, settings)

  const load = useCallback(async (file: File) => {
    setBusy(true)
    setError(null)
    try {
      const s = await importFile(file)
      setScene(s)
      setDecisions(seedDecisions(s))
      setSettings(settingsForScene(s))
      setSelection([])
      setProjectName(s.sourceName || 'Untitled')
      setPresetNonce((n) => n + 1)
    } catch (e) {
      if (e instanceof ImportError) setError({ message: e.message, advice: e.advice })
      else setError({ message: (e as Error).message, advice: '' })
      setScene(null)
    } finally {
      setBusy(false)
    }
  }, [])

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

  const exportFile = useCallback(() => {
    if (!result || result.objects.length === 0) return
    const venue: VenueFile = {
      // The version this format was reverse-engineered from. ArrayCalc reads its own older
      // files, so claiming the version we actually understand is the honest choice.
      appVersion: '12.8.2',
      venueVersion: '9',
      projectName,
      date: formatDbacvDate(),
      author: 'Venue Forge',
      projectComments: '',
      venueComments: `Converted from ${scene?.format ?? 'CAD'} by Venue Forge.`,
      objects: result.objects,
    }
    const blob = new Blob([writeDbacv(venue)], { type: 'application/xml' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${projectName || 'venue'}.dbacv`
    a.click()
    URL.revokeObjectURL(url)
  }, [result, projectName, scene])

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
            <h1>Drop a CAD model</h1>
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
              accept={ACCEPTED_EXTENSIONS.join(',')}
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) void load(f)
              }}
            />
            <p className="formats">{ACCEPTED_EXTENSIONS.join('  ·  ')}</p>
            {busy && <p className="muted">Reading…</p>}
            {error && (
              <div className="error">
                <strong>{error.message}</strong>
                {error.advice && <p>{error.advice}</p>}
              </div>
            )}
            <p className="pitch">
              Venue Forge turns a CAD model into a d&amp;b ArrayCalc venue. It merges the
              model's triangles back into flat planes, lets you throw away everything
              ArrayCalc does not need, and lets you say what each surface is — then writes a{' '}
              <code>.dbacv</code>.
            </p>
          </div>
        </main>
      </div>
    )
  }

  const totalTris = countTriangles(scene.nodes)

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
          accept={ACCEPTED_EXTENSIONS.join(',')}
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
        <aside className="left">
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
        </aside>

        <main className="centre">
          <div className="view-toolbar">
            <Segmented
              value={view}
              onChange={setView}
              options={[
                { value: 'source', label: 'Source' },
                { value: 'converted', label: 'Planes' },
                { value: 'both', label: 'Both' },
              ]}
            />
            <span className="spacer" />
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
          </div>

          <Viewport
            nodes={scene.nodes}
            decisions={decisions}
            converted={result?.objects ?? []}
            transform={settings.transform}
            view={view}
            selection={selection}
            onSelect={select}
            preset={preset}
            presetNonce={presetNonce}
          />

          <div className="stats">
            <Stat label="source triangles" value={totalTris.toLocaleString()} />
            <Stat label="flat regions found" value={(result?.stats.regionsFound ?? 0).toLocaleString()} />
            <Stat
              label="ArrayCalc objects"
              value={running ? '…' : (result?.stats.objectsOut ?? 0).toLocaleString()}
              tone={(result?.stats.objectsOut ?? 0) > 300 ? 'warn' : 'ok'}
            />
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

          <Panel title="Placement">
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

            <Field label="Heading" hint="Rotate about the vertical so the audience faces +X.">
              <NumberInput
                value={settings.transform.headingDeg}
                step={5}
                suffix="°"
                onChange={(v) => patchSettings({ transform: { ...settings.transform, headingDeg: v } })}
              />
            </Field>

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
                ? 'Every region collapses to its smallest enclosing rectangle — one quad each. Usually what you want for seating blocks.'
                : 'Outlines are kept and split into quads and triangles. Faithful, but a ragged CAD outline makes many objects.'}
            </p>

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
        Venue&nbsp;Forge <em>CAD → ArrayCalc</em>
      </span>
      {children}
    </header>
  )
}
