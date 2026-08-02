/**
 * The trace document: a 2D drawing plus the regions a user has drawn on it.
 *
 * A PDF or an image is not a model — it is a picture of one, with no units, no origin and
 * no third dimension. Everything that turns it into venue geometry is a decision the user
 * makes here: what one pixel is worth (`Calibration`), which outlines matter
 * (`TraceRegion`), and how high each corner sits (`TraceVertex.z`).
 *
 * Regions are stored in PIXEL space, not metres. That is deliberate: re-calibrating after
 * an hour of tracing must not move any outline relative to the drawing it was traced from.
 * The pixel -> metre map is applied once, in calibrate.ts, exactly as unit conversion for
 * 3D imports happens once in geom/transform.ts.
 */

import type { PlaneType } from '../dbacv/types.ts'

/** A point in raster pixel space: x right, y DOWN, origin top-left, as the image is stored. */
export type Px = [number, number]

/**
 * Decoded pixels, RGBA, row-major. The same shape as a canvas ImageData, but a plain object
 * so the whole detector runs in node.
 */
export interface Raster {
  width: number
  height: number
  /** length === width * height * 4 */
  data: Uint8ClampedArray
}

/**
 * How pixels become metres.
 *
 * `origin` is the pixel that lands at venue (0, 0). Venue Y is flipped relative to image Y
 * because image rows run downwards and a right-handed Z-up venue has Y running up the
 * page — see calibrate.ts, which has a determinant test for it.
 */
export interface Calibration {
  pixelsPerMetre: number
  origin: Px
  /** How the scale was arrived at, shown in the UI so a guess never passes for a measurement. */
  source: CalibrationSource
}

export type CalibrationSource =
  /** The user drew a line on a known dimension and typed its real length. */
  | { kind: 'known-distance'; from: Px; to: Px; metres: number }
  /** A vector PDF at a stated paper scale — exact, no clicking. */
  | { kind: 'paper-scale'; denominator: number; pixelsPerPagePoint: number }
  /** Nothing has been set yet: the drawing is being shown at an arbitrary 1 px = 1 cm. */
  | { kind: 'unset' }

/** How a region's per-vertex heights become 3D geometry. */
export type HeightMode =
  /**
   * Fit one plane through the vertex heights and put every vertex on it. Always yields a
   * single flat surface, which is what ArrayCalc wants; a flat floor and a constant rake
   * are both exactly representable, anything else gets moved and the residual is reported.
   */
  | 'plane'
  /**
   * Use the typed heights exactly and triangulate. Faithful to a stepped or dished
   * surface, but the result is not planar, so the planarizer will break it into several
   * ArrayCalc objects.
   */
  | 'free'

export interface TraceVertex {
  /** Pixel position on the drawing. */
  p: Px
  /** Height in metres above the venue datum. Negative for a pit or a recess. */
  z: number
}

export interface TraceRegion {
  id: string
  name: string
  /** Seeds the node's plane type on first build; the user's choice afterwards lives in Decisions. */
  planeType: PlaneType
  vertices: TraceVertex[]
  /**
   * Enclosed voids: a column in the stalls, a lift shaft through a balcony. Geometry only —
   * hole corners take their height from the region's fitted plane, because a hole is a gap
   * in a surface rather than a surface of its own.
   */
  holes: Px[][]
  heightMode: HeightMode
  /** Set false to keep a region in the document but out of the venue. */
  visible: boolean
  /** Where the outline came from, for the UI to explain itself. */
  origin: 'drawn' | 'detected' | 'vector'
}

/** A polyline recovered from the drawing: PDF vector paths, or traced raster contours. */
export interface DetectedPath {
  points: Px[]
  closed: boolean
}

export interface TraceDocument {
  /** For display: 'PDF page 2 of 5', 'PNG'. */
  format: string
  sourceName: string
  raster: Raster
  /**
   * Geometry recovered from the source, used for snapping and for one-click region select.
   * Empty for a photograph; exact for a vector PDF.
   */
  paths: DetectedPath[]
  calibration: Calibration
  regions: TraceRegion[]
  /**
   * PDF only. `pixelsPerPagePoint` is the rasterisation scale, which is what turns a paper
   * scale printed in the title block into a pixel scale.
   */
  page?: { index: number; count: number; pixelsPerPagePoint: number }
  warnings: string[]
}

export const DEFAULT_CALIBRATION = (raster: { width: number; height: number }): Calibration => ({
  // 1 px = 1 cm is an arbitrary starting scale, but a useful one: a 2000 px wide drawing
  // comes out 20 m across, so the room is visible and roughly venue-sized before the user
  // calibrates. `source: unset` is what the UI keys its "not calibrated yet" warning off.
  pixelsPerMetre: 100,
  origin: [raster.width / 2, raster.height / 2],
  source: { kind: 'unset' },
})

let seq = 0
export const nextRegionId = (): string => `region${++seq}`

/** Reset the region id counter. Tests only — ids must be stable within a session. */
export function resetRegionIds(): void {
  seq = 0
}
