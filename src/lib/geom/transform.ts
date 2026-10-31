/**
 * Source CAD space -> ArrayCalc venue space.
 *
 * ArrayCalc's convention, read off the sample file: metres, Z up, +X towards the audience.
 * In that file the stage and the Soundscape plane sit at x = -9.6 and the mix position at
 * x = +13.06, so the room runs along X with the stage at the negative end. Y is
 * left/right and is symmetric about zero for every symmetric object in the venue.
 *
 * This is the ONLY place unit and axis conversion happens. Importers hand over raw source
 * coordinates; see import/types.ts for why.
 */

import type { ImportedNode } from '../import/types.ts'

export interface TransformOptions {
  /** Metres per source unit. 1 for metres, 0.001 for mm, 0.0254 for inches. */
  unitsPerMetre: number
  /** Which source axis points up. Y-up gets rotated to ArrayCalc's Z-up. */
  upAxis: 'y' | 'z'
  /** Degrees about the venue Z axis, applied after the axis fix. Aims the room down +X. */
  headingDeg: number
  /** Metres, applied last: where the source origin lands in venue space. */
  offset: { x: number; y: number; z: number }
  /** Mirror X after everything else, for a model that came in back to front. */
  flipX: boolean
}

export const UNIT_PRESETS: { label: string; unitsPerMetre: number }[] = [
  { label: 'Metres', unitsPerMetre: 1 },
  { label: 'Centimetres', unitsPerMetre: 0.01 },
  { label: 'Millimetres', unitsPerMetre: 0.001 },
  { label: 'Feet', unitsPerMetre: 0.3048 },
  { label: 'Inches', unitsPerMetre: 0.0254 },
]

export const DEFAULT_TRANSFORM: TransformOptions = {
  unitsPerMetre: 1,
  upAxis: 'z',
  headingDeg: 0,
  offset: { x: 0, y: 0, z: 0 },
  flipX: false,
}

/** Apply a transform to a flat xyz triple stream, in place on a copy. */
export function applyTransform(positions: Float64Array, t: TransformOptions): Float64Array {
  const out = new Float64Array(positions.length)
  const s = t.unitsPerMetre
  const rad = (t.headingDeg * Math.PI) / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  const sx = t.flipX ? -1 : 1

  for (let i = 0; i + 2 < positions.length; i += 3) {
    let x = positions[i] * s
    let y = positions[i + 1] * s
    let z = positions[i + 2] * s

    if (t.upAxis === 'y') {
      // Y-up right-handed (glTF, most mesh formats) -> Z-up right-handed. Source -Z
      // becomes venue +Y, NOT +Y -> +Y: taking the lazy swap mirrors the room, and a
      // mirrored auditorium is the kind of error that survives all the way to site.
      const ny = -z
      const nz = y
      y = ny
      z = nz
    }

    const rx = x * cos - y * sin
    const ry = x * sin + y * cos

    out[i] = rx * sx + t.offset.x
    out[i + 1] = ry + t.offset.y
    out[i + 2] = z + t.offset.z
  }
  return out
}

/**
 * Put the venue origin on a point that is already in venue space.
 *
 * The numeric half of clicking a point in the viewport. The viewport draws
 * `applyTransform`'s output, so a picked point p is `f(source) + offset`; asking for the
 * origin to sit there is solving `f(source) + offset' = 0`, which is only
 * `offset' = offset - p`. Working in venue space is what keeps this indifferent to units,
 * up axis, heading and mirror — none of them has to be inverted, and a picker that does
 * invert them is a second copy of the transform waiting to drift from this one.
 *
 * Rounded to the millimetre. A picked point carries float dust from the projection, and
 * `-12.300000000000002` in a field that steps in half metres reads as a bug in a room
 * measured to the centimetre at best.
 *
 * The offset is applied LAST, so changing heading afterwards swings the model about the
 * source datum and carries the picked point away from zero. Set the heading first; the UI
 * says so.
 */
export function withOriginAt(
  t: TransformOptions,
  p: { x: number; y: number; z: number },
): TransformOptions {
  const mm = (v: number) => Math.round(v * 1000) / 1000
  return {
    ...t,
    offset: { x: mm(t.offset.x - p.x), y: mm(t.offset.y - p.y), z: mm(t.offset.z - p.z) },
  }
}

export interface Bounds {
  min: { x: number; y: number; z: number }
  max: { x: number; y: number; z: number }
}

export function boundsOf(nodes: ImportedNode[]): Bounds | null {
  let minX = Infinity
  let minY = Infinity
  let minZ = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  let maxZ = -Infinity
  let any = false

  const walk = (ns: ImportedNode[]) => {
    for (const n of ns) {
      const p = n.positions
      for (let i = 0; i + 2 < p.length; i += 3) {
        any = true
        if (p[i] < minX) minX = p[i]
        if (p[i] > maxX) maxX = p[i]
        if (p[i + 1] < minY) minY = p[i + 1]
        if (p[i + 1] > maxY) maxY = p[i + 1]
        if (p[i + 2] < minZ) minZ = p[i + 2]
        if (p[i + 2] > maxZ) maxZ = p[i + 2]
      }
      walk(n.children)
    }
  }
  walk(nodes)
  if (!any) return null
  return { min: { x: minX, y: minY, z: minZ }, max: { x: maxX, y: maxY, z: maxZ } }
}

/**
 * Guess the source unit from the model's overall size.
 *
 * A venue is 10-200 m across. If the raw numbers say 30000, the file is in millimetres.
 * Only ever a starting guess, and the UI says so — an 80-foot room and a 24-metre room
 * are both plausible readings of the same bounding box.
 */
export function guessUnits(b: Bounds): number {
  const span = Math.max(b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z)
  if (span > 5000) return 0.001
  if (span > 500) return 0.01
  if (span > 150) return 0.3048
  return 1
}

/**
 * Guess which source axis is up, for a format that does not say.
 *
 * OBJ, STL, PLY and 3DS state nothing, and the default of Z is wrong for most of what turns
 * up as OBJ: Blender, three.js and media-server stage models (disguise's stock theatre
 * among them) are Y-up, and arrive lying on their backs — a 14 m high room reported as 42 m
 * high, with its floor standing up as a wall.
 *
 * The surfaces say which way is up. A venue's largest surfaces are horizontal — floor,
 * ceiling, stage, every tread of a rake — so the axis that the most surface area FACES
 * along is the vertical one. Area-weighted and sign-free, because a CAD floor wound
 * downwards is as horizontal as one wound up. Walls face both horizontal axes and split
 * their area between them, which is why one long wall rarely outvotes the floor.
 *
 * Only a decisive answer is taken. When neither axis leads clearly the overall shape
 * breaks the tie — a venue is wider than it is tall — and when that is close too, the old
 * default stands. Like `guessUnits`, a starting point the UI labels as a guess.
 */
export function guessUpAxis(nodes: ImportedNode[]): 'y' | 'z' {
  let facingY = 0
  let facingZ = 0
  const walk = (ns: ImportedNode[]) => {
    for (const n of ns) {
      const p = n.positions
      for (let i = 0; i + 8 < p.length; i += 9) {
        const ux = p[i + 3] - p[i]
        const uy = p[i + 4] - p[i + 1]
        const uz = p[i + 5] - p[i + 2]
        const vx = p[i + 6] - p[i]
        const vy = p[i + 7] - p[i + 1]
        const vz = p[i + 8] - p[i + 2]
        // |n_y| and |n_z| of the cross product, which is twice the area projected onto the
        // plane perpendicular to that axis. The factor of two cancels in the comparison.
        facingY += Math.abs(uz * vx - ux * vz)
        facingZ += Math.abs(ux * vy - uy * vx)
      }
      walk(n.children)
    }
  }
  walk(nodes)

  const DECISIVE = 1.25
  if (facingY > facingZ * DECISIVE) return 'y'
  if (facingZ > facingY * DECISIVE) return 'z'

  const b = boundsOf(nodes)
  if (!b) return 'z'
  const spanY = b.max.y - b.min.y
  const spanZ = b.max.z - b.min.z
  if (spanZ > spanY * DECISIVE) return 'y'
  return 'z'
}

/** What `squareToWalls` read off the walls. */
export interface Squareness {
  /** Degrees to ADD to the heading to put the walls on the venue axes, in [-45, 45). */
  turnDeg: number
  /**
   * 0 to 1: how strongly the walls agree on one set of right angles. The concentration of
   * their folded facings (the mean resultant length), so a scanner's scatter costs little —
   * 8 mm of noise on 10 cm triangles still reads above 0.8 — while a round or octagonal room,
   * which has no one set, reads near 0.
   */
  agreement: number
  /** m² of wall the answer was read from. */
  wallArea: number
}

/** A surface is a wall if its normal is within this of level. Wide, for a scan's noise. */
const WALL_TILT = Math.sin((20 * Math.PI) / 180)
/** Less wall than this, in m², says nothing about which way the room runs. */
const MIN_WALL_AREA = 0.5

/**
 * The turn that squares a room to the venue axes, read off its walls.
 *
 * A scan arrives at whatever heading the phone happened to face, and a drawing at whatever
 * angle the building sits on its site. ArrayCalc wants the room down +X with Y symmetric about
 * zero, and typing the heading by eye leaves it a degree or two out: every plane then goes
 * into ArrayCalc turned 1.7° or 23.09°, and none of its numbers reads as a length or a width.
 * (A turned wall is still one quad — `canonicalQuad` takes any rotation about Z — so this is
 * about the venue a designer works in, not the object count.)
 *
 * A room's walls mostly face four ways at right angles. So each wall's facing is taken four
 * times over (4φ, which folds those four onto one), the area-weighted histogram of that is
 * smoothed, and its peak refined by mean shift over the walls near it. The peak, not the
 * mean: a fan-shaped auditorium's splayed side walls are a minority that a mean would follow
 * and a peak ignores. Only the ANGLE mod 90° is found. Which of the four ways the audience
 * faces is the user's to say, which is why this returns the smallest turn.
 *
 * Read in venue space under `t`, so the turn is relative to the heading already set, but
 * before the mirror, which is applied after the heading and would reverse its sense.
 */
export function squareToWalls(nodes: ImportedNode[], t: TransformOptions): Squareness | null {
  const unmirrored: TransformOptions = { ...t, flipX: false, offset: { x: 0, y: 0, z: 0 } }
  const angles: number[] = []
  const weights: number[] = []
  const walk = (ns: ImportedNode[]) => {
    for (const n of ns) {
      const p = applyTransform(n.positions, unmirrored)
      for (let i = 0; i + 8 < p.length; i += 9) {
        const ux = p[i + 3] - p[i]
        const uy = p[i + 4] - p[i + 1]
        const uz = p[i + 5] - p[i + 2]
        const vx = p[i + 6] - p[i]
        const vy = p[i + 7] - p[i + 1]
        const vz = p[i + 8] - p[i + 2]
        const nx = uy * vz - uz * vy
        const ny = uz * vx - ux * vz
        const nz = ux * vy - uy * vx
        const twice = Math.hypot(nx, ny, nz)
        if (twice === 0 || Math.abs(nz) > WALL_TILT * twice) continue
        angles.push(4 * Math.atan2(ny, nx))
        weights.push(twice / 2)
      }
      walk(n.children)
    }
  }
  walk(nodes)
  return squareness(angles, weights)
}

/** The fold-by-four histogram and mean shift behind `squareToWalls`, on 4φ in radians. */
function squareness(angles: number[], weights: number[]): Squareness | null {
  let wallArea = 0
  for (const w of weights) wallArea += w
  if (wallArea < MIN_WALL_AREA) return null

  const BINS = 360
  const hist = new Float64Array(BINS)
  const bin = (a: number) => (((Math.floor((a * 180) / Math.PI) % BINS) + BINS) % BINS)
  angles.forEach((a, i) => (hist[bin(a)] += weights[i]))
  // ±10° of 4φ is ±2.5° of facing: wide enough that a scan's scattered normals make one
  // hill rather than a comb.
  let peak = 0
  let best = -1
  for (let b = 0; b < BINS; b++) {
    let s = 0
    for (let k = -10; k <= 10; k++) s += hist[(b + k + BINS) % BINS]
    if (s > best) {
      best = s
      peak = b
    }
  }

  const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a))
  // ±10° of facing. Half that left a scan with 8 mm of noise 0.08° rms off over eight seeds,
  // this 0.04°; a fan's 15° splay is still outside it.
  const WINDOW = (40 * Math.PI) / 180
  let c = ((peak + 0.5) * Math.PI) / 180
  for (let iter = 0; iter < 8; iter++) {
    let s = 0
    let co = 0
    angles.forEach((a, i) => {
      const d = wrap(a - c)
      if (Math.abs(d) > WINDOW) return
      s += weights[i] * Math.sin(d)
      co += weights[i] * Math.cos(d)
    })
    if (co <= 0) break
    const step = Math.atan2(s, co)
    c += step
    if (Math.abs(step) < 1e-9) break
  }

  let along = 0
  let across = 0
  angles.forEach((a, i) => {
    along += weights[i] * Math.cos(a - c)
    across += weights[i] * Math.sin(a - c)
  })
  // The walls face φ = c/4 (mod 90°); turning by -φ puts them on the axes.
  const facing = ((c * 180) / Math.PI / 4) % 90
  let turnDeg = -facing
  while (turnDeg < -45) turnDeg += 90
  while (turnDeg >= 45) turnDeg -= 90
  return { turnDeg, agreement: Math.hypot(along, across) / wallArea, wallArea }
}
