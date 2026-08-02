/**
 * The 3D viewport.
 *
 * Shows the imported geometry and the converted ArrayCalc planes in the same space, so
 * the planarizer's output can be checked against its input by eye. That comparison is the
 * only honest way to know whether a tolerance setting is right for a given model.
 *
 * ArrayCalc's convention is Z-up with the audience towards +X, so the camera's up vector
 * is Z and the grid is rotated into the XY plane.
 */

import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { type RoomObject, PlaneType, Shape } from '../lib/dbacv/types.ts'
import { type ImportedNode } from '../lib/import/index.ts'
import { applyTransform, type TransformOptions } from '../lib/geom/transform.ts'
import type { ViewMode } from '../state.ts'
import { PLANE_UI_HEX as PLANE_HEX } from './planeColours.ts'

export type CameraPreset = 'iso' | 'plan' | 'section' | 'front'

/**
 * How near the cursor has to be, in screen pixels, for a pick to snap to a corner.
 *
 * Screen pixels rather than metres: the point of snapping is that the corner you can see
 * under the cursor is the one you get, and that is a statement about the screen. A metre
 * threshold would snap from across the room in a plan view and never snap close up.
 */
const SNAP_PX = 14

/** Free point on a surface, and a snapped corner. Different colours, because they are
 *  different claims about what you are about to get. */
const PICK_FREE_HEX = 0xffd166
const PICK_SNAP_HEX = 0x4cc9f0

interface Props {
  nodes: ImportedNode[]
  decisions: Record<string, { include: boolean; planeType: PlaneType; name: string }>
  converted: RoomObject[]
  transform: TransformOptions
  view: ViewMode
  selection: string[]
  onSelect: (id: string, additive: boolean) => void
  preset: CameraPreset
  presetNonce: number
  /** While true a click sets the venue origin instead of selecting an object. */
  pickOrigin?: boolean
  /** The picked point, in venue space — feed it to `withOriginAt`. */
  onPickOrigin?: (p: { x: number; y: number; z: number }) => void
}

/** Flat triangle list -> a BufferGeometry with normals, ready to render. */
function geometryFrom(positions: Float64Array): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3))
  g.computeVertexNormals()
  return g
}

/** Tessellate a converted RoomObject tree for display. Origin + local points, no rotation. */
function convertedGeometry(objects: RoomObject[]): { positions: number[]; edges: number[] } {
  const positions: number[] = []
  const edges: number[] = []
  const walk = (os: RoomObject[]) => {
    for (const o of os) {
      const p = o.points.map((q) => [q.x + o.origin.x, q.y + o.origin.y, q.z + o.origin.z])
      if (o.shape === Shape.Triangle && p.length >= 3) {
        positions.push(...p[0], ...p[1], ...p[2])
      } else if (o.shape === Shape.Quad && p.length >= 4) {
        positions.push(...p[0], ...p[1], ...p[2], ...p[0], ...p[2], ...p[3])
      }
      for (let i = 0; i < p.length; i++) {
        edges.push(...p[i], ...p[(i + 1) % p.length])
      }
      walk(o.children)
    }
  }
  walk(objects)
  return { positions, edges }
}

export function Viewport(props: Props) {
  const mount = useRef<HTMLDivElement>(null)
  const state = useRef<{
    renderer: THREE.WebGLRenderer
    scene: THREE.Scene
    camera: THREE.PerspectiveCamera
    controls: OrbitControls
    sourceGroup: THREE.Group
    convertedGroup: THREE.Group
    raycaster: THREE.Raycaster
    marker: THREE.Mesh
  } | null>(null)

  const propsRef = useRef(props)
  propsRef.current = props

  // --- one-time scene setup -------------------------------------------------
  useEffect(() => {
    const el = mount.current
    if (!el) return

    const renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    el.appendChild(renderer.domElement)

    const scene = new THREE.Scene()
    scene.background = new THREE.Color(0x0a1420)

    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 5000)
    // Z-up, to match ArrayCalc. Without this the orbit controls gimbal around the wrong
    // axis and every venue looks as though it is lying on its side.
    camera.up.set(0, 0, 1)
    camera.position.set(-30, -30, 20)

    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true

    scene.add(new THREE.AmbientLight(0xffffff, 1.4))
    const key = new THREE.DirectionalLight(0xffffff, 1.6)
    key.position.set(-1, -1, 2)
    scene.add(key)
    const fill = new THREE.DirectionalLight(0x88aacc, 0.7)
    fill.position.set(1, 1, 0.5)
    scene.add(fill)

    const grid = new THREE.GridHelper(100, 100, 0x2d5070, 0x18293c)
    grid.rotation.x = Math.PI / 2
    scene.add(grid)

    // Venue axes: +X runs towards the audience, which is the one orientation fact a user
    // has to get right, so it is drawn rather than described.
    const axes = new THREE.Group()
    const axisLine = (to: [number, number, number], hex: number) => {
      const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(...to)])
      return new THREE.Line(g, new THREE.LineBasicMaterial({ color: hex }))
    }
    axes.add(axisLine([8, 0, 0], 0xef5d5d))
    axes.add(axisLine([0, 8, 0], 0x5ec98a))
    axes.add(axisLine([0, 0, 6], 0x4cc9f0))
    scene.add(axes)

    const sourceGroup = new THREE.Group()
    const convertedGroup = new THREE.Group()
    scene.add(sourceGroup, convertedGroup)

    // The origin picker's hover marker. `depthTest: false` deliberately: the point under
    // the cursor is often on a far wall seen through a nearer surface, and a marker that
    // disappears exactly when you aim at the back of the room looks like a broken tool.
    // It is sized per frame instead of in world units — see the tick.
    const marker = new THREE.Mesh(
      new THREE.SphereGeometry(1, 16, 12),
      new THREE.MeshBasicMaterial({ color: PICK_FREE_HEX, depthTest: false, transparent: true, opacity: 0.9 }),
    )
    marker.renderOrder = 999
    marker.visible = false
    scene.add(marker)

    const raycaster = new THREE.Raycaster()
    state.current = { renderer, scene, camera, controls, sourceGroup, convertedGroup, raycaster, marker }

    const resize = () => {
      const w = el.clientWidth
      const h = el.clientHeight
      if (w === 0 || h === 0) return
      renderer.setSize(w, h, false)
      camera.aspect = w / h
      camera.updateProjectionMatrix()
    }
    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(el)

    let raf = 0
    const tick = () => {
      raf = requestAnimationFrame(tick)
      controls.update()
      // Hold the marker at a constant size on screen. A fixed world radius is either a
      // speck across a 60 m room or a boulder up against a seating block, and the marker's
      // only job is to say precisely which point is about to be taken.
      if (marker.visible) {
        const s = camera.position.distanceTo(marker.position) * 0.008
        marker.scale.setScalar(Math.max(s, 1e-4))
      }
      renderer.render(scene, camera)
    }
    tick()

    /** Raycast whatever is currently on screen, snapping to a corner when there is one near. */
    const pickAt = (ev: MouseEvent): { point: THREE.Vector3; snapped: boolean } | null => {
      const rect = renderer.domElement.getBoundingClientRect()
      const px = ev.clientX - rect.left
      const py = ev.clientY - rect.top
      const ndc = new THREE.Vector2((px / rect.width) * 2 - 1, -(py / rect.height) * 2 + 1)
      raycaster.setFromCamera(ndc, camera)

      // Raycast what the user can actually see. In "Planes" view the source meshes are
      // hidden, and picking a point off an invisible surface is picking blind — the
      // converted planes are in the same venue space, so they answer the same question.
      const targets: THREE.Object3D[] = []
      if (sourceGroup.visible) targets.push(...sourceGroup.children)
      if (convertedGroup.visible) {
        targets.push(...convertedGroup.children.filter((o) => (o as THREE.Mesh).isMesh))
      }
      const hit = raycaster.intersectObjects(targets, true)[0]
      if (!hit) return null
      return nearestCorner(hit, camera, rect, px, py) ?? { point: hit.point.clone(), snapped: false }
    }

    // OrbitControls has no click event of its own, so releasing a drag fires one here.
    // Without this guard an orbit that ends over the model selects it — and, once the
    // origin picker existed, moved the whole venue.
    let downAt: { x: number; y: number } | null = null
    const onPointerDown = (ev: PointerEvent) => {
      downAt = { x: ev.clientX, y: ev.clientY }
    }
    const dragged = (ev: MouseEvent) =>
      downAt !== null && Math.hypot(ev.clientX - downAt.x, ev.clientY - downAt.y) > 4

    const onMove = (ev: PointerEvent) => {
      if (!propsRef.current.pickOrigin) return
      const p = pickAt(ev)
      marker.visible = p !== null
      if (p) {
        marker.position.copy(p.point)
        ;(marker.material as THREE.MeshBasicMaterial).color.setHex(
          p.snapped ? PICK_SNAP_HEX : PICK_FREE_HEX,
        )
      }
    }
    const onLeave = () => {
      marker.visible = false
    }

    const onClick = (ev: MouseEvent) => {
      if (dragged(ev)) return
      if (propsRef.current.pickOrigin) {
        const p = pickAt(ev)
        // Picking is modal: a click that lands on nothing must not fall through and change
        // the selection instead, or the model moves when you meant to aim.
        if (p) propsRef.current.onPickOrigin?.({ x: p.point.x, y: p.point.y, z: p.point.z })
        return
      }
      const rect = renderer.domElement.getBoundingClientRect()
      const ndc = new THREE.Vector2(
        ((ev.clientX - rect.left) / rect.width) * 2 - 1,
        -((ev.clientY - rect.top) / rect.height) * 2 + 1,
      )
      raycaster.setFromCamera(ndc, camera)
      const hits = raycaster.intersectObjects(sourceGroup.children, true)
      const id = hits[0]?.object.userData.nodeId as string | undefined
      if (id) propsRef.current.onSelect(id, ev.shiftKey || ev.metaKey)
    }
    renderer.domElement.addEventListener('click', onClick)
    renderer.domElement.addEventListener('pointerdown', onPointerDown)
    renderer.domElement.addEventListener('pointermove', onMove)
    renderer.domElement.addEventListener('pointerleave', onLeave)

    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      renderer.domElement.removeEventListener('click', onClick)
      renderer.domElement.removeEventListener('pointerdown', onPointerDown)
      renderer.domElement.removeEventListener('pointermove', onMove)
      renderer.domElement.removeEventListener('pointerleave', onLeave)
      marker.geometry.dispose()
      ;(marker.material as THREE.Material).dispose()
      renderer.dispose()
      el.removeChild(renderer.domElement)
      state.current = null
    }
  }, [])

  // Leaving the picker with the cursor still over the canvas would otherwise strand the
  // marker on screen, pointing at a venue origin that is no longer being chosen.
  useEffect(() => {
    const s = state.current
    if (s && !props.pickOrigin) s.marker.visible = false
  }, [props.pickOrigin])

  // --- source geometry ------------------------------------------------------
  const sourceKey = useMemo(
    () => props.nodes.map((n) => n.id).join(',') + JSON.stringify(props.transform),
    [props.nodes, props.transform],
  )

  /**
   * Everything about the placement EXCEPT the offset.
   *
   * A change to any of it resizes, reshapes or re-aims the model and wants the camera
   * re-fitted. A change to the offset alone only slides the whole model through the venue,
   * and re-fitting there would undo the very thing an origin pick is for: the model would
   * jump back under the crosshair instead of the axes moving to the point that was picked.
   */
  const placementKey =
    props.nodes.map((n) => n.id).join(',') +
    `|${props.transform.unitsPerMetre}|${props.transform.upAxis}|${props.transform.headingDeg}|${props.transform.flipX}`
  const lastPlacement = useRef<string | null>(null)
  const lastOffset = useRef(props.transform.offset)

  useEffect(() => {
    const s = state.current
    if (!s) return
    // Dispose before clearing: three does not free GPU buffers when an object leaves the
    // graph, and re-importing a few large models otherwise walks the tab into a crash.
    s.sourceGroup.traverse((o) => {
      const m = o as THREE.Mesh
      if (m.geometry) m.geometry.dispose()
    })
    s.sourceGroup.clear()

    const walk = (nodes: ImportedNode[]) => {
      for (const n of nodes) {
        if (n.positions.length > 0) {
          const geom = geometryFrom(applyTransform(n.positions, props.transform))
          const mat = new THREE.MeshLambertMaterial({
            color: 0x7f9bb5,
            side: THREE.DoubleSide,
            transparent: true,
            opacity: 0.85,
          })
          const mesh = new THREE.Mesh(geom, mat)
          mesh.userData.nodeId = n.id
          s.sourceGroup.add(mesh)
        }
        walk(n.children)
      }
    }
    walk(props.nodes)

    const off = props.transform.offset
    if (lastPlacement.current !== placementKey) {
      fitCamera(s.camera, s.controls, s.sourceGroup)
    } else {
      // Carry the camera along with the model, so the room stays where it was on screen
      // and the axes gizmo is what visibly moves to the new origin.
      const d = new THREE.Vector3(
        off.x - lastOffset.current.x,
        off.y - lastOffset.current.y,
        off.z - lastOffset.current.z,
      )
      s.camera.position.add(d)
      s.controls.target.add(d)
      s.controls.update()
    }
    lastPlacement.current = placementKey
    lastOffset.current = off
  }, [sourceKey]) // eslint-disable-line react-hooks/exhaustive-deps

  // --- per-frame appearance: colour, visibility, selection -------------------
  useEffect(() => {
    const s = state.current
    if (!s) return
    const showSource = props.view === 'source' || props.view === 'both'
    s.sourceGroup.visible = showSource
    s.convertedGroup.visible = props.view === 'converted' || props.view === 'both'

    for (const child of s.sourceGroup.children) {
      const mesh = child as THREE.Mesh
      const id = mesh.userData.nodeId as string
      const d = props.decisions[id]
      const selected = props.selection.includes(id)
      const mat = mesh.material as THREE.MeshLambertMaterial
      if (!d?.include) {
        // Excluded geometry stays visible but ghosted. Hiding it makes it impossible to
        // notice you have pruned something you needed.
        mat.color.setHex(0x334455)
        mat.opacity = 0.15
      } else {
        mat.color.setHex(selected ? 0xffffff : PLANE_HEX[d.planeType] ?? 0x8899aa)
        mat.opacity = props.view === 'both' ? 0.35 : 0.9
      }
      mat.needsUpdate = true
    }
    // `sourceKey` is in here because a rebuild makes new materials in the default colour and
    // nothing else would repaint them: every placement change used to wash the whole model
    // to one pale grey until the next click on the tree. Declared after the rebuild effect,
    // so it runs after it.
  }, [props.decisions, props.selection, props.view, sourceKey])

  // --- converted planes -----------------------------------------------------
  useEffect(() => {
    const s = state.current
    if (!s) return
    s.convertedGroup.traverse((o) => {
      const m = o as THREE.Mesh
      if (m.geometry) m.geometry.dispose()
    })
    s.convertedGroup.clear()

    const { positions, edges } = convertedGeometry(props.converted)
    if (positions.length) {
      const g = new THREE.BufferGeometry()
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3))
      g.computeVertexNormals()
      s.convertedGroup.add(
        new THREE.Mesh(
          g,
          new THREE.MeshLambertMaterial({
            color: 0x4cc9f0,
            side: THREE.DoubleSide,
            transparent: true,
            opacity: 0.55,
          }),
        ),
      )
    }
    if (edges.length) {
      const g = new THREE.BufferGeometry()
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(edges), 3))
      s.convertedGroup.add(new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0x9fe8ff })))
    }
  }, [props.converted])

  // --- camera presets -------------------------------------------------------
  useEffect(() => {
    const s = state.current
    if (!s) return
    const box = new THREE.Box3().setFromObject(s.sourceGroup)
    if (box.isEmpty()) return
    const c = box.getCenter(new THREE.Vector3())
    const r = Math.max(box.getSize(new THREE.Vector3()).length() * 0.6, 5)
    const at: Record<CameraPreset, [number, number, number]> = {
      iso: [c.x - r, c.y - r, c.z + r * 0.7],
      plan: [c.x, c.y, c.z + r * 1.6],
      section: [c.x, c.y - r * 1.8, c.z],
      front: [c.x - r * 1.8, c.y, c.z],
    }
    const p = at[props.preset]
    s.camera.position.set(p[0], p[1], p[2])
    // A plan view looking straight down has an ambiguous up vector; nudging it to +X keeps
    // the stage at the left of the screen instead of wherever the last orbit left it.
    if (props.preset === 'plan') s.camera.up.set(1, 0, 0)
    else s.camera.up.set(0, 0, 1)
    s.controls.target.copy(c)
    s.controls.update()
  }, [props.preset, props.presetNonce])

  return <div className={`viewport${props.pickOrigin ? ' picking' : ''}`} ref={mount} />
}

/**
 * The corner of the hit triangle nearest the cursor on screen, if one is within `SNAP_PX`.
 *
 * Both groups are drawn already transformed into venue space and sit at the scene root, so
 * a vertex read straight off the buffer is a venue coordinate — the same numbers the
 * exporter writes. `localToWorld` is still applied rather than assumed: a group transform
 * added later would otherwise put the origin somewhere plausible and wrong.
 */
function nearestCorner(
  hit: THREE.Intersection,
  camera: THREE.PerspectiveCamera,
  rect: DOMRect,
  px: number,
  py: number,
): { point: THREE.Vector3; snapped: boolean } | null {
  const face = hit.face
  const geom = (hit.object as THREE.Mesh).geometry as THREE.BufferGeometry | undefined
  const pos = geom?.getAttribute('position')
  if (!face || !pos) return null

  let best: THREE.Vector3 | null = null
  let bestD = SNAP_PX
  for (const i of [face.a, face.b, face.c]) {
    const v = new THREE.Vector3().fromBufferAttribute(pos, i)
    hit.object.localToWorld(v)
    const ndc = v.clone().project(camera)
    const sx = ((ndc.x + 1) / 2) * rect.width
    const sy = ((1 - ndc.y) / 2) * rect.height
    const d = Math.hypot(sx - px, sy - py)
    if (d < bestD) {
      bestD = d
      best = v
    }
  }
  return best ? { point: best, snapped: true } : null
}

function fitCamera(camera: THREE.PerspectiveCamera, controls: OrbitControls, group: THREE.Group) {
  const box = new THREE.Box3().setFromObject(group)
  if (box.isEmpty()) return
  const c = box.getCenter(new THREE.Vector3())
  const r = Math.max(box.getSize(new THREE.Vector3()).length() * 0.6, 5)
  camera.position.set(c.x - r, c.y - r, c.z + r * 0.7)
  camera.near = Math.max(r / 1000, 0.01)
  camera.far = r * 100
  camera.updateProjectionMatrix()
  controls.target.copy(c)
  controls.update()
}
