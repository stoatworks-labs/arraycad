/**
 * Pixels -> metres. The one place the trace document's scale is applied.
 *
 * Same rule as geom/transform.ts: everything upstream stays in the source's own
 * coordinates and only this module knows what they are worth. A traced outline is stored
 * in pixels for the life of the document, so re-measuring the scale bar after an hour of
 * work re-scales the whole venue and moves nothing relative to the drawing.
 *
 * ## The Y flip
 *
 * Raster rows run DOWNWARDS: y = 0 is the top of the page. ArrayCalc is Z-up and
 * right-handed, so venue Y has to run UP the page. Venue Y is therefore `origin.y - py`,
 * not `py - origin.y`.
 *
 * Getting that wrong does not look wrong. The drawing still renders, the room is still
 * the right size, and every symmetric venue looks fine — the auditorium is simply mirrored
 * left for right, which nobody notices until the delays are hung on the wrong side. There
 * is a winding test for it in trace.test.ts, and build.ts forces every area to wind
 * counter-clockwise in venue space so its normal points up regardless of which way round
 * the user clicked.
 */

import type { Calibration, Px } from './types.ts'

/** PDF user space is 1/72 inch. */
const METRES_PER_POINT = 0.0254 / 72

/** Metres per pixel. */
export const metresPerPixel = (cal: Calibration): number => 1 / cal.pixelsPerMetre

/** A pixel on the drawing -> venue XY in metres. */
export function pxToVenue(p: Px, cal: Calibration): { x: number; y: number } {
  const s = 1 / cal.pixelsPerMetre
  return { x: (p[0] - cal.origin[0]) * s, y: (cal.origin[1] - p[1]) * s }
}

/** Venue XY in metres -> a pixel on the drawing. The exact inverse of pxToVenue. */
export function venueToPx(x: number, y: number, cal: Calibration): Px {
  const s = cal.pixelsPerMetre
  return [x * s + cal.origin[0], cal.origin[1] - y * s]
}

/** A length in pixels -> a length in metres. Rotation-free, so it works on any direction. */
export function pxLengthToMetres(px: number, cal: Calibration): number {
  return px / cal.pixelsPerMetre
}

/** Distance between two pixels, in pixels. */
export function pxDistance(a: Px, b: Px): number {
  return Math.hypot(b[0] - a[0], b[1] - a[1])
}

/**
 * Calibrate from a dimension the user knows: click each end, type the real length.
 *
 * The honest default, and the only one available for a photograph or a scan. Accuracy is
 * whatever the click accuracy is over the length measured, so the UI tells the user to
 * pick the LONGEST dimension on the sheet, not the handiest one.
 */
export function calibrateByDistance(from: Px, to: Px, metres: number): Calibration | null {
  const px = pxDistance(from, to)
  if (!(px > 0) || !(metres > 0) || !Number.isFinite(metres)) return null
  return {
    pixelsPerMetre: px / metres,
    origin: [from[0], from[1]],
    source: { kind: 'known-distance', from, to, metres },
  }
}

/**
 * Calibrate a vector PDF from its stated paper scale, e.g. 1:50.
 *
 * Exact, with no clicking: the page is in points, a point is 1/72 inch of paper, and at
 * 1:`denominator` one metre of paper is `denominator` metres of building. The only thing
 * that can be wrong is the number printed on the drawing, which is also the only thing a
 * person can check.
 *
 * `pixelsPerPagePoint` is the scale the page was rasterised at — pdf.js's viewport scale.
 */
export function calibrateByPaperScale(
  denominator: number,
  pixelsPerPagePoint: number,
  origin: Px,
): Calibration | null {
  if (!(denominator > 0) || !(pixelsPerPagePoint > 0)) return null
  const metresPerPixel = (METRES_PER_POINT * denominator) / pixelsPerPagePoint
  return {
    pixelsPerMetre: 1 / metresPerPixel,
    origin,
    source: { kind: 'paper-scale', denominator, pixelsPerPagePoint },
  }
}

/** Move the venue origin without touching the scale. */
export function withOrigin(cal: Calibration, origin: Px): Calibration {
  return { ...cal, origin }
}

/**
 * A round scale-bar length that comes out between `minPx` and `maxPx` on screen, and its
 * label. 1-2-5 steps, so the bar reads 5 m or 10 m rather than 7.3 m.
 */
export function scaleBarStep(metresPerScreenPx: number, minPx = 60, maxPx = 200): {
  metres: number
  px: number
} {
  const steps = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500]
  for (const m of steps) {
    const px = m / metresPerScreenPx
    if (px >= minPx && px <= maxPx) return { metres: m, px }
  }
  // Off the end of the table in either direction: clamp rather than return nothing.
  const m = metresPerScreenPx * minPx > steps[steps.length - 1] ? steps[steps.length - 1] : steps[0]
  return { metres: m, px: m / metresPerScreenPx }
}
