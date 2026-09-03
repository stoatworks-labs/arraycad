/**
 * Parse `GeneralSceneDescription.xml` into an `MvrScene`.
 *
 * Uses DOMParser, which exists in the browser and in jsdom. Vitest runs these tests in
 * node, so the tests pull in jsdom explicitly rather than this module depending on it —
 * same arrangement as `dbacv/read.ts`.
 *
 * This is a translation and nothing more: no geometry, no units, no decisions. It reads
 * the document exactly as the spec describes it and hands the result to `scene.ts`.
 */

import {
  type MvrGeometry,
  type MvrLayer,
  type MvrMatrix,
  type MvrObject,
  type MvrObjectType,
  type MvrScene,
  type MvrSymdef,
  IDENTITY,
  OBJECT_TYPES,
} from './types.ts'

export class MvrParseError extends Error {}

const OBJECT_TYPE_SET = new Set<string>(OBJECT_TYPES)

/** `:scope > Tag`, as an array. */
function childrenNamed(parent: Element, tag: string): Element[] {
  return Array.from(parent.children).filter((c) => c.tagName === tag)
}

function firstNamed(parent: Element, tag: string): Element | null {
  return childrenNamed(parent, tag)[0] ?? null
}

function textOf(parent: Element, tag: string): string | undefined {
  const el = firstNamed(parent, tag)
  const text = el?.textContent?.trim()
  return text ? text : undefined
}

/**
 * `{u1,u2,u3}{v1,v2,v3}{w1,w2,w3}{o1,o2,o3}` -> `MvrMatrix`.
 *
 * Anything that does not yield twelve finite numbers falls back to the identity, which is
 * what the spec says a missing Matrix means. A half-parsed matrix is worse than no matrix:
 * it puts the object somewhere specific and wrong, where the identity at least leaves it
 * visible at the origin for the user to notice.
 */
export function parseMatrix(raw: string | null | undefined): MvrMatrix {
  if (!raw) return IDENTITY
  const nums = raw.match(/-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g)
  if (!nums || nums.length < 12) return IDENTITY
  const n = nums.slice(0, 12).map(Number)
  if (!n.every(Number.isFinite)) return IDENTITY
  return {
    u: [n[0], n[1], n[2]],
    v: [n[3], n[4], n[5]],
    w: [n[6], n[7], n[8]],
    o: [n[9], n[10], n[11]],
  }
}

function matrixOf(parent: Element): MvrMatrix {
  return parseMatrix(firstNamed(parent, 'Matrix')?.textContent)
}

/** `Geometries` -> the `Geometry3D` and `Symbol` entries it holds, in document order. */
function readGeometries(parent: Element): MvrGeometry[] {
  const container = firstNamed(parent, 'Geometries')
  if (!container) return []
  const out: MvrGeometry[] = []
  for (const el of Array.from(container.children)) {
    if (el.tagName === 'Geometry3D') {
      const fileName = el.getAttribute('fileName')?.trim()
      if (!fileName) continue
      out.push({ kind: 'file', fileName, matrix: matrixOf(el) })
    } else if (el.tagName === 'Symbol') {
      const symdef = el.getAttribute('symdef')?.trim()
      if (!symdef) continue
      out.push({ kind: 'symbol', symdef, matrix: matrixOf(el) })
    }
  }
  return out
}

function readObject(el: Element, classNames: Map<string, string>): MvrObject | null {
  if (!OBJECT_TYPE_SET.has(el.tagName)) return null

  const classing = textOf(el, 'Classing')
  const children: MvrObject[] = []
  const childList = firstNamed(el, 'ChildList')
  if (childList) {
    for (const c of Array.from(childList.children)) {
      const child = readObject(c, classNames)
      if (child) children.push(child)
    }
  }

  return {
    uuid: el.getAttribute('uuid') ?? '',
    name: el.getAttribute('name')?.trim() ?? '',
    type: el.tagName as MvrObjectType,
    matrix: matrixOf(el),
    geometries: readGeometries(el),
    className: classing ? classNames.get(classing) : undefined,
    gdtfSpec: textOf(el, 'GDTFSpec'),
    children,
  }
}

function readSymdefs(aux: Element | null, classNames: Map<string, string>): Map<string, MvrSymdef> {
  const out = new Map<string, MvrSymdef>()
  if (!aux) return out
  for (const el of childrenNamed(aux, 'Symdef')) {
    const uuid = el.getAttribute('uuid')
    if (!uuid) continue
    // A Symdef's geometry hangs off its ChildList, not off a Geometries element — the one
    // place in the format where those two node names swap roles (spec Table 10).
    const childList = firstNamed(el, 'ChildList')
    const geometries: MvrGeometry[] = []
    if (childList) {
      for (const c of Array.from(childList.children)) {
        if (c.tagName === 'Geometry3D') {
          const fileName = c.getAttribute('fileName')?.trim()
          if (fileName) geometries.push({ kind: 'file', fileName, matrix: matrixOf(c) })
        } else if (c.tagName === 'Symbol') {
          const symdef = c.getAttribute('symdef')?.trim()
          if (symdef) geometries.push({ kind: 'symbol', symdef, matrix: matrixOf(c) })
        }
      }
    }
    // Some exporters put a Geometries element on a Symdef as well. Reading both costs
    // nothing and means neither shape arrives empty.
    geometries.push(...readGeometries(el))
    out.set(uuid, { uuid, name: el.getAttribute('name')?.trim() ?? '', geometries })
  }
  // Classes are hoisted here too: they live alongside Symdefs in AUXData and objects refer
  // to them by uuid, so the name has to be resolved while the whole document is in hand.
  for (const el of childrenNamed(aux, 'Class')) {
    const uuid = el.getAttribute('uuid')
    const name = el.getAttribute('name')?.trim()
    if (uuid && name) classNames.set(uuid, name)
  }
  return out
}

export function parseMvr(xml: string, parser: DOMParser = new DOMParser()): MvrScene {
  const doc = parser.parseFromString(xml, 'application/xml')

  // DOMParser signals failure with a <parsererror> element rather than throwing, and the
  // element is namespaced differently across engines — check the tag name anywhere.
  const err = doc.getElementsByTagName('parsererror')[0]
  if (err) throw new MvrParseError(`Not valid XML: ${err.textContent?.trim().slice(0, 200)}`)

  const root = doc.documentElement
  if (!root || root.tagName !== 'GeneralSceneDescription') {
    throw new MvrParseError(
      `Expected a <GeneralSceneDescription> root element, found <${root?.tagName ?? 'nothing'}>.`,
    )
  }

  const scene = firstNamed(root, 'Scene')
  if (!scene) throw new MvrParseError('No <Scene> element — this file has no scene to read.')

  // Classes are filled in by readSymdefs before any object is read, because an object's
  // Classing is a uuid that only AUXData can turn into a name.
  const classNames = new Map<string, string>()
  const symdefs = readSymdefs(firstNamed(scene, 'AUXData'), classNames)

  const layers: MvrLayer[] = []
  const layersEl = firstNamed(scene, 'Layers')
  for (const el of layersEl ? childrenNamed(layersEl, 'Layer') : []) {
    const childList = firstNamed(el, 'ChildList')
    const children: MvrObject[] = []
    if (childList) {
      for (const c of Array.from(childList.children)) {
        const child = readObject(c, classNames)
        if (child) children.push(child)
      }
    }
    layers.push({
      uuid: el.getAttribute('uuid') ?? '',
      name: el.getAttribute('name')?.trim() ?? '',
      matrix: matrixOf(el),
      children,
    })
  }

  const major = root.getAttribute('verMajor') ?? '1'
  const minor = root.getAttribute('verMinor') ?? '0'
  return {
    version: `${major}.${minor}`,
    provider: root.getAttribute('provider') ?? '',
    providerVersion: root.getAttribute('providerVersion') ?? '',
    symdefs,
    layers,
  }
}
