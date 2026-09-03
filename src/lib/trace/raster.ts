/**
 * Raster preparation: RGBA pixels -> the ink mask everything else works on.
 *
 * A venue plan is line art. Once it is a boolean "is this pixel drawn on?" mask, region
 * detection is a flood fill and outline detection is a contour walk — both exact, both
 * fast, both testable in node on a hand-built mask.
 *
 * The only judgement call is the threshold, and it is made by Otsu's method rather than a
 * constant: a CAD PDF rendered white-on-black, a grey photocopy and a phone photo of a
 * printout all have completely different ink levels, and a fixed 50% turns two of the
 * three into either a blank page or a solid block.
 */

import type { Raster } from './types.ts'

/** Rec.709 luminance, one byte per pixel. Alpha is composited over white. */
export function luminance(r: Raster): Uint8ClampedArray {
  const n = r.width * r.height
  const out = new Uint8ClampedArray(n)
  const d = r.data
  for (let i = 0; i < n; i++) {
    const o = i * 4
    const a = d[o + 3] / 255
    // Over white, because a transparent PDF background is paper, not ink. Composite the
    // other way and every unfilled area of a vector PDF reads as solid black.
    const rr = d[o] * a + 255 * (1 - a)
    const gg = d[o + 1] * a + 255 * (1 - a)
    const bb = d[o + 2] * a + 255 * (1 - a)
    out[i] = 0.2126 * rr + 0.7152 * gg + 0.0722 * bb
  }
  return out
}

/**
 * Otsu's threshold: the grey level that minimises within-class variance.
 *
 * Returns the level such that `lum <= t` is one class. On a uniform image every split has
 * the same (zero) between-class variance, so the answer is arbitrary; 127 is returned so
 * a blank page comes out as no ink rather than all ink.
 */
export function otsuThreshold(lum: Uint8ClampedArray): number {
  const hist = new Float64Array(256)
  for (let i = 0; i < lum.length; i++) hist[lum[i]]++
  const total = lum.length
  if (total === 0) return 127

  let sum = 0
  for (let t = 0; t < 256; t++) sum += t * hist[t]

  let sumB = 0
  let wB = 0
  let best = -1
  let bestT = -1
  for (let t = 0; t < 256; t++) {
    wB += hist[t]
    if (wB === 0) continue
    const wF = total - wB
    if (wF === 0) break
    sumB += t * hist[t]
    const mB = sumB / wB
    const mF = (sum - sumB) / wF
    const between = wB * wF * (mB - mF) * (mB - mF)
    if (between > best) {
      best = between
      bestT = t
    }
  }
  return bestT < 0 ? 127 : bestT
}

export interface BinariseOptions {
  /** 0..255, or 'auto' for Otsu. */
  threshold: number | 'auto'
  /**
   * True when the drawing is light lines on a dark background (a CAD screenshot). The mask
   * always means "ink", so inverting here keeps every downstream module ignorant of it.
   */
  invert: boolean
  /**
   * Count only black and grey as ink. A CAD plot puts its annotation — loudspeakers,
   * labels, cable runs, dimensions — on coloured layers and the architecture in black, so
   * this leaves exactly the walls to detect, and a coloured line drawn across a room no
   * longer cuts it in two. Off by default: a scan or a photograph can put colour into a
   * black line from the paper and the lens.
   */
  ignoreColour?: boolean
}

export const DEFAULT_BINARISE: BinariseOptions = { threshold: 'auto', invert: false, ignoreColour: false }

/**
 * Above this chroma (max minus min of RGB), a pixel is a drawn colour rather than ink.
 * Black and grey ink stays under about 40 even at anti-aliased edges and through JPEG; a
 * colour at any printable saturation is well over 100.
 */
const GREY_CHROMA_MAX = 64

/** Chroma per pixel — how far from grey — composited over white like `luminance`. */
export function chroma(r: Raster): Uint8ClampedArray {
  const n = r.width * r.height
  const out = new Uint8ClampedArray(n)
  const d = r.data
  for (let i = 0; i < n; i++) {
    const o = i * 4
    const a = d[o + 3] / 255
    const rr = d[o] * a + 255 * (1 - a)
    const gg = d[o + 1] * a + 255 * (1 - a)
    const bb = d[o + 2] * a + 255 * (1 - a)
    out[i] = Math.max(rr, gg, bb) - Math.min(rr, gg, bb)
  }
  return out
}

export interface Mask {
  width: number
  height: number
  /** 1 where there is ink (a drawn line), 0 where there is paper. */
  data: Uint8Array
  /** The level actually used, so the UI can show what 'auto' decided. */
  threshold: number
}

export function binarise(r: Raster, opts: BinariseOptions = DEFAULT_BINARISE): Mask {
  const lum = luminance(r)
  const t = opts.threshold === 'auto' ? otsuThreshold(lum) : opts.threshold
  const chr = opts.ignoreColour ? chroma(r) : null
  const data = new Uint8Array(r.width * r.height)
  for (let i = 0; i < data.length; i++) {
    const dark = lum[i] <= t
    let ink = opts.invert ? !dark : dark
    if (chr && chr[i] > GREY_CHROMA_MAX) ink = false
    data[i] = ink ? 1 : 0
  }
  return { width: r.width, height: r.height, data, threshold: t }
}

/**
 * Thicken the ink by `radius` pixels (Chebyshev, i.e. a square structuring element).
 *
 * Plans are drawn with hairlines, and a hairline that renders as a broken 1 px trail lets
 * a flood fill leak out of the room it was meant to fill and swallow the whole page.
 * Closing those gaps before the fill costs one pass and is the difference between "select
 * the stalls" working and returning the entire drawing.
 *
 * Separable: two 1D passes, so the cost is O(pixels * radius) not O(pixels * radius^2).
 */
export function dilate(mask: Mask, radius: number): Mask {
  if (radius <= 0) return mask
  const { width: w, height: h } = mask
  const tmp = new Uint8Array(w * h)
  const out = new Uint8Array(w * h)

  for (let y = 0; y < h; y++) {
    const row = y * w
    for (let x = 0; x < w; x++) {
      let v = 0
      const x0 = Math.max(0, x - radius)
      const x1 = Math.min(w - 1, x + radius)
      for (let i = x0; i <= x1 && !v; i++) v = mask.data[row + i]
      tmp[row + x] = v
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let v = 0
      const y0 = Math.max(0, y - radius)
      const y1 = Math.min(h - 1, y + radius)
      for (let i = y0; i <= y1 && !v; i++) v = tmp[i * w + x]
      out[y * w + x] = v
    }
  }
  return { width: w, height: h, data: out, threshold: mask.threshold }
}

export interface InkMaskOptions extends Partial<BinariseOptions> {
  /**
   * Close hairline gaps by thickening the ink this many pixels before anything reads it.
   * One pixel is enough for a rendered PDF; a photocopy or a photograph may need two or
   * three.
   */
  lineThickenPx?: number
}

export const DEFAULT_INK_MASK: Required<InkMaskOptions> = {
  threshold: 'auto',
  invert: false,
  ignoreColour: false,
  lineThickenPx: 1,
}

/** The mask every detector works on: binarise, then close the hairlines. */
export function inkMask(r: Raster, opts: InkMaskOptions = {}): Mask {
  const o = { ...DEFAULT_INK_MASK, ...opts }
  return dilate(
    binarise(r, { threshold: o.threshold, invert: o.invert, ignoreColour: o.ignoreColour }),
    o.lineThickenPx,
  )
}

/** Fraction of the mask that is ink. A sanity check: 0 or 1 means the threshold is wrong. */
export function inkFraction(mask: Mask): number {
  let n = 0
  for (let i = 0; i < mask.data.length; i++) n += mask.data[i]
  return mask.data.length === 0 ? 0 : n / mask.data.length
}
