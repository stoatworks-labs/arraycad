/**
 * Parse a .dbacv venue file.
 *
 * Uses DOMParser, which exists in the browser and in jsdom. Vitest runs these tests in
 * node, so read.test.ts pulls in jsdom explicitly rather than this module depending on it.
 */

import {
  type ArcParams,
  type RoomObject,
  type Vec3,
  type VenueFile,
  PlaneType,
  Shape,
} from './types.ts'

export class DbacvParseError extends Error {}

let nextId = 0
function makeId(): string {
  return `ro${++nextId}`
}

function num(el: Element, attr: string, fallback: number): number {
  const raw = el.getAttribute(attr)
  if (raw === null) return fallback
  const v = Number(raw)
  // ArrayCalc writes bare `nan` for ListenerHeight on some groups. Number('nan') is NaN
  // (only 'NaN' parses), and either way NaN must not reach the geometry.
  return Number.isFinite(v) ? v : fallback
}

function bool(el: Element, attr: string, fallback: boolean): boolean {
  const raw = el.getAttribute(attr)
  if (raw === null) return fallback
  return raw === '1' || raw === 'true'
}

function vec(parent: Element, tag: string, fallback: Vec3): Vec3 {
  const el = parent.querySelector(`:scope > ${tag}`)
  if (!el) return fallback
  return { x: num(el, 'x', 0), y: num(el, 'y', 0), z: num(el, 'z', 0) }
}

const ARC_ATTRS = [
  'InnerRadiusA',
  'InnerRadiusB',
  'OuterRadiusA',
  'OuterRadiusB',
  'InnerZ',
  'OuterZ',
  'StartAngle',
  'SpanAngle',
] as const

function readArc(el: Element): ArcParams | undefined {
  if (!ARC_ATTRS.every((a) => el.hasAttribute(a))) return undefined
  return {
    innerRadiusA: num(el, 'InnerRadiusA', 0),
    innerRadiusB: num(el, 'InnerRadiusB', 0),
    outerRadiusA: num(el, 'OuterRadiusA', 0),
    outerRadiusB: num(el, 'OuterRadiusB', 0),
    innerZ: num(el, 'InnerZ', 0),
    outerZ: num(el, 'OuterZ', 0),
    startAngle: num(el, 'StartAngle', 0),
    spanAngle: num(el, 'SpanAngle', 0),
  }
}

function readRoomObject(el: Element): RoomObject {
  const shape = num(el, 'Shape', Shape.Quad) as Shape

  // P1..P8 in order. Stop at the first gap rather than assuming a count from Shape, so a
  // file that disagrees with our shape table still round-trips its actual points.
  const points: Vec3[] = []
  for (let i = 1; i <= 8; i++) {
    const p = el.querySelector(`:scope > P${i}`)
    if (!p) break
    points.push({ x: num(p, 'x', 0), y: num(p, 'y', 0), z: num(p, 'z', 0) })
  }

  const children: RoomObject[] = []
  for (const child of Array.from(el.children)) {
    if (child.tagName === 'RoomObject') children.push(readRoomObject(child))
  }

  const lhRaw = el.getAttribute('ListenerHeight')
  const lhFinite = lhRaw !== null && Number.isFinite(Number(lhRaw))

  return {
    id: makeId(),
    name: el.getAttribute('Name') ?? 'Unnamed',
    shape,
    planeType: num(el, 'PlaneType', PlaneType.Audience) as PlaneType,
    listenerHeight: num(el, 'ListenerHeight', 1.2),
    ...(lhRaw !== null && !lhFinite ? { listenerHeightRaw: lhRaw } : {}),
    enabled: bool(el, 'Enabled', true),
    locked: bool(el, 'Locked', false),
    transparent: bool(el, 'Transparent', false),
    color: num(el, 'Color', 0xff888888),
    printColor: num(el, 'PrintColor', 0xffffa500),
    orderIndex: num(el, 'OrderIndex', 0),
    origin: vec(el, 'Origin', { x: 0, y: 0, z: 0 }),
    rotation: vec(el, 'Rotation', { x: 0, y: 0, z: 0 }),
    scaling: vec(el, 'Scaling', { x: 1, y: 1, z: 1 }),
    points,
    arc: readArc(el),
    children,
  }
}

function textOf(root: Element | null, tag: string): string {
  if (!root) return ''
  const el = root.querySelector(`:scope > ${tag}`)
  return el?.textContent ?? ''
}

export function parseDbacv(xml: string, parser: DOMParser = new DOMParser()): VenueFile {
  const doc = parser.parseFromString(xml, 'application/xml')

  // DOMParser signals failure with a <parsererror> element in the output rather than
  // throwing, and the element is namespaced differently across engines — check for the
  // tag name anywhere rather than matching a namespace.
  const err = doc.getElementsByTagName('parsererror')[0]
  if (err) throw new DbacvParseError(`Not valid XML: ${err.textContent?.trim().slice(0, 200)}`)

  const root = doc.documentElement
  if (!root || root.tagName !== 'ArrayCalc') {
    throw new DbacvParseError(
      `Expected an <ArrayCalc> root element, found <${root?.tagName ?? 'nothing'}>.`,
    )
  }

  const project = root.querySelector(':scope > Project')
  const venue = root.querySelector(':scope > Venue')
  if (!venue) throw new DbacvParseError('No <Venue> element — this file has no venue geometry.')

  const objects: RoomObject[] = []
  for (const child of Array.from(venue.children)) {
    if (child.tagName === 'RoomObject') objects.push(readRoomObject(child))
  }

  return {
    appVersion: root.getAttribute('Version') ?? '12.8.2',
    venueVersion: venue.getAttribute('Version') ?? '9',
    projectName: project?.getAttribute('Name') ?? 'Untitled',
    date: textOf(project, 'Date'),
    author: textOf(project, 'Author'),
    projectComments: textOf(project, 'Comments'),
    venueComments: textOf(venue, 'Comments'),
    objects,
  }
}
