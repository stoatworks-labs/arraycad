/**
 * Vector paths out of a PDF page.
 *
 * A PDF exported from CAD still contains the real lines. Recovering them means a traced
 * corner can land on the actual drawn intersection rather than on whichever pixel it
 * rasterised to, so a plan at 1:100 stays accurate to the millimetre instead of to the
 * 25 mm a 150 dpi render is worth.
 *
 * This module is pure: it takes an already-fetched operator list and the numeric opcode
 * map, and returns polylines in pixel space. pdf.js itself is loaded in pdfSource.ts. That
 * split is what lets the transform stack, the Bézier flattening and the version guard be
 * tested in node against a hand-built operator list.
 *
 * ## Version fragility, and what happens when it bites
 *
 * `OPS` is part of pdf.js's public API. The *shape of the arguments* to `constructPath`
 * is not: v5 packs a whole subpath into one Float32Array of interleaved drawing opcodes
 * and coordinates, and earlier versions did something else. So the buffer is validated
 * before it is walked, and anything unrecognised returns no paths plus a warning rather
 * than silently producing wrong geometry. Tracing then falls back to the rasterised
 * outlines from detect.ts, which always work and are merely less exact.
 *
 * If a pdfjs-dist major bump makes every PDF report "no vector geometry", this is the
 * file — check DrawOP below against `DrawOPS` in pdf.worker.mjs.
 */

import type { DetectedPath, Px } from './types.ts'

/** A PDF/canvas affine matrix [a, b, c, d, e, f]. */
export type Mat = [number, number, number, number, number, number]

export const IDENTITY: Mat = [1, 0, 0, 1, 0, 0]

/** `mul(m1, m2)` applies m2 first, then m1 — the same convention as pdf.js Util.transform. */
export function mul(m1: Mat, m2: Mat): Mat {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ]
}

export function apply(m: Mat, x: number, y: number): Px {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]
}

/**
 * pdf.js's internal path opcodes (`DrawOPS` in pdf.worker.mjs). Not exported by the
 * package, so they are pinned here and checked by `looksLikePathBuffer`.
 */
const DrawOP = { moveTo: 0, lineTo: 1, curveTo: 2, quadraticCurveTo: 3, closePath: 4 } as const

/** The opcodes this module needs. Pass pdf.js's own exported `OPS`. */
export interface OpCodes {
  save: number
  restore: number
  transform: number
  constructPath: number
  paintFormXObjectBegin: number
  paintFormXObjectEnd: number
}

export interface OperatorList {
  fnArray: ArrayLike<number>
  argsArray: ArrayLike<unknown>
}

export interface PathExtractOptions {
  /** Stop once this many points have been produced. A hatched plan can run to millions. */
  maxPoints: number
  /** Target chord length when flattening a curve, in pixels. */
  curveChordPx: number
  /** Drop subpaths shorter than this in pixels: dot leaders, hatch stipple, punctuation. */
  minLengthPx: number
}

export const DEFAULT_PATH_EXTRACT: PathExtractOptions = {
  maxPoints: 200000,
  curveChordPx: 3,
  minLengthPx: 3,
}

export interface PathExtractResult {
  paths: DetectedPath[]
  warnings: string[]
}

/** True when `v` is the interleaved opcode/coordinate buffer v5 produces. */
function looksLikePathBuffer(v: unknown): v is ArrayLike<number> {
  return (
    (v instanceof Float32Array || v instanceof Float64Array || Array.isArray(v)) &&
    (v as ArrayLike<number>).length > 0
  )
}

/**
 * Walk an operator list and return every drawn path, in pixel space.
 *
 * `base` is the page viewport transform — PDF user space to canvas pixels, including the
 * y flip — so the output is in the same pixel coordinates as the rendered raster and can
 * be snapped to directly.
 */
export function pathsFromOperatorList(
  list: OperatorList,
  ops: OpCodes,
  base: Mat,
  opts: PathExtractOptions = DEFAULT_PATH_EXTRACT,
): PathExtractResult {
  const paths: DetectedPath[] = []
  const warnings: string[] = []
  let ctm: Mat = IDENTITY
  const stack: Mat[] = []
  let points = 0
  let unknownBuffers = 0
  let truncated = false

  const emit = (pts: Px[], closed: boolean) => {
    if (pts.length < 2) return
    let length = 0
    for (let i = 1; i < pts.length; i++) length += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1])
    if (length < opts.minLengthPx) return
    paths.push({ points: pts, closed })
    points += pts.length
  }

  for (let i = 0; i < list.fnArray.length && !truncated; i++) {
    const fn = list.fnArray[i]
    const args = list.argsArray[i] as unknown[]

    if (fn === ops.save) {
      stack.push(ctm)
      continue
    }
    if (fn === ops.restore) {
      ctm = stack.pop() ?? IDENTITY
      continue
    }
    if (fn === ops.transform) {
      const m = args as unknown as ArrayLike<number>
      if (m && m.length >= 6) ctm = mul(ctm, [m[0], m[1], m[2], m[3], m[4], m[5]])
      continue
    }
    if (fn === ops.paintFormXObjectBegin) {
      stack.push(ctm)
      const m = args?.[0] as ArrayLike<number> | undefined
      if (m && m.length >= 6) ctm = mul(ctm, [m[0], m[1], m[2], m[3], m[4], m[5]])
      continue
    }
    if (fn === ops.paintFormXObjectEnd) {
      ctm = stack.pop() ?? IDENTITY
      continue
    }
    if (fn !== ops.constructPath) continue

    // v5: [drawingOp, [buffer], minMax]. The buffer interleaves DrawOP codes with the
    // coordinates each one consumes.
    const bufferHolder = args?.[1]
    const buffer = Array.isArray(bufferHolder) ? bufferHolder[0] : bufferHolder
    if (!looksLikePathBuffer(buffer)) {
      unknownBuffers++
      continue
    }

    const m = mul(base, ctm)
    let sub: Px[] = []
    let cur: Px = [0, 0]
    let start: Px = [0, 0]
    let bad = false

    for (let k = 0; k < buffer.length && !bad; ) {
      const op = buffer[k++]
      switch (op) {
        case DrawOP.moveTo: {
          if (k + 2 > buffer.length) {
            bad = true
            break
          }
          emit(sub, false)
          cur = apply(m, buffer[k], buffer[k + 1])
          start = cur
          sub = [cur]
          k += 2
          break
        }
        case DrawOP.lineTo: {
          if (k + 2 > buffer.length) {
            bad = true
            break
          }
          cur = apply(m, buffer[k], buffer[k + 1])
          sub.push(cur)
          k += 2
          break
        }
        case DrawOP.curveTo: {
          if (k + 6 > buffer.length) {
            bad = true
            break
          }
          const c1 = apply(m, buffer[k], buffer[k + 1])
          const c2 = apply(m, buffer[k + 2], buffer[k + 3])
          const to = apply(m, buffer[k + 4], buffer[k + 5])
          flattenCubic(cur, c1, c2, to, opts.curveChordPx, sub)
          cur = to
          k += 6
          break
        }
        case DrawOP.quadraticCurveTo: {
          if (k + 4 > buffer.length) {
            bad = true
            break
          }
          const c = apply(m, buffer[k], buffer[k + 1])
          const to = apply(m, buffer[k + 2], buffer[k + 3])
          // A quadratic is a cubic with both controls two thirds of the way to the handle.
          const c1: Px = [cur[0] + (2 / 3) * (c[0] - cur[0]), cur[1] + (2 / 3) * (c[1] - cur[1])]
          const c2: Px = [to[0] + (2 / 3) * (c[0] - to[0]), to[1] + (2 / 3) * (c[1] - to[1])]
          flattenCubic(cur, c1, c2, to, opts.curveChordPx, sub)
          cur = to
          k += 4
          break
        }
        case DrawOP.closePath: {
          if (sub.length >= 2) {
            emit(sub, true)
            sub = [start]
            cur = start
          }
          break
        }
        default:
          bad = true
      }
    }

    if (bad) unknownBuffers++
    else emit(sub, false)

    if (points >= opts.maxPoints) truncated = true
  }

  if (unknownBuffers > 0) {
    warnings.push(
      `${unknownBuffers} PDF path(s) were in a shape this build does not recognise and were ` +
        'skipped. Snapping falls back to the outlines detected in the rendered page.',
    )
  }
  if (truncated) {
    warnings.push(
      `This page has more vector detail than snapping needs; only the first ${opts.maxPoints.toLocaleString()} ` +
        'points were kept.',
    )
  }
  if (paths.length === 0 && unknownBuffers === 0) {
    warnings.push(
      'No vector geometry in this page — it is a scan or a flattened image. Outlines are ' +
        'detected from the pixels instead.',
    )
  }

  return { paths, warnings }
}

/** Flatten a cubic Bézier, appending to `out` (excluding `p0`, which is already there). */
export function flattenCubic(p0: Px, p1: Px, p2: Px, p3: Px, chordPx: number, out: Px[]): void {
  const rough =
    Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) +
    Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) +
    Math.hypot(p3[0] - p2[0], p3[1] - p2[1])
  const n = Math.max(2, Math.min(24, Math.ceil(rough / Math.max(0.5, chordPx))))
  for (let i = 1; i <= n; i++) {
    const t = i / n
    const u = 1 - t
    const a = u * u * u
    const b = 3 * u * u * t
    const c = 3 * u * t * t
    const d = t * t * t
    out.push([
      a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0],
      a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1],
    ])
  }
}
