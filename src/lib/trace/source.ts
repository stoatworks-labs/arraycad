/**
 * Loading a PDF or an image into a trace document.
 *
 * The only module under lib/trace that needs a browser — canvases and ImageBitmap — the
 * same exception import/mesh.ts gets for the three.js loaders. Everything it produces is
 * the plain `Raster`/`DetectedPath` data the rest of trace/ works on, so the detector, the
 * calibration and the scene builder all still run in node under test.
 *
 * pdf.js lives behind a **dynamic import** in pdfSource.ts: 400 kB that nobody dropping a
 * DXF or a photograph of a plan should have to download.
 */

import { ImportError } from '../import/types.ts'
import { type DetectedPath, type Raster, type TraceDocument, DEFAULT_CALIBRATION } from './types.ts'
import { type InkMaskOptions, inkFraction, inkMask } from './raster.ts'
import { traceContours } from './detect.ts'

export const TRACE_EXTENSIONS = ['.pdf', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'] as const

export function isTraceFile(name: string): boolean {
  const i = name.lastIndexOf('.')
  const ext = i === -1 ? '' : name.slice(i).toLowerCase()
  return (TRACE_EXTENSIONS as readonly string[]).includes(ext)
}

export interface LoadTraceOptions extends InkMaskOptions {
  /** 0-based page, for a multi-page PDF. */
  pageIndex?: number
  /**
   * Longest edge of the rasterised page, in pixels.
   *
   * 2400 puts an A1 sheet at about 100 dpi, which is enough to see a seating layout and
   * to flood fill between walls, and keeps the mask under 10 MB. Detection accuracy is
   * bounded by this, so the page-scale readout in the UI quotes it.
   */
  targetPx?: number
}

export const DEFAULT_LOAD: Required<LoadTraceOptions> = {
  pageIndex: 0,
  targetPx: 2400,
  threshold: 'auto',
  invert: false,
  ignoreColour: false,
  lineThickenPx: 1,
}

export async function loadTraceSource(file: File, options: LoadTraceOptions = {}): Promise<TraceDocument> {
  const opts = { ...DEFAULT_LOAD, ...options }
  if (file.name.toLowerCase().endsWith('.pdf')) {
    const { loadPdf } = await import('./pdfSource.ts')
    return loadPdf(file, {
      pageIndex: opts.pageIndex,
      targetPx: opts.targetPx,
      contoursOf: (raster, warnings) => contoursOf(raster, opts, warnings),
    })
  }
  return loadImage(file, opts)
}

// ---------------------------------------------------------------------- image

async function loadImage(file: File, opts: Required<LoadTraceOptions>): Promise<TraceDocument> {
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch (e) {
    throw new ImportError(
      `Could not decode "${file.name}" as an image.`,
      (e as Error).message + '\n\nSupported: PNG, JPEG, WebP, GIF and BMP.',
    )
  }

  const scale = Math.min(1, opts.targetPx / Math.max(bitmap.width, bitmap.height))
  const w = Math.max(1, Math.round(bitmap.width * scale))
  const h = Math.max(1, Math.round(bitmap.height * scale))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new ImportError('This browser would not give ArrayCAD a 2D canvas to read the image with.')
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, w, h)
  ctx.drawImage(bitmap, 0, 0, w, h)
  bitmap.close()

  const img = ctx.getImageData(0, 0, w, h)
  const raster: Raster = { width: w, height: h, data: img.data }
  const warnings: string[] = []
  if (scale < 1) {
    warnings.push(
      `The image was scaled to ${w}x${h} for tracing. Detection is only as accurate as that, ` +
        'so measure the scale across the longest dimension on the sheet.',
    )
  }

  return {
    format: 'Image',
    sourceName: file.name,
    raster,
    paths: contoursOf(raster, opts, warnings),
    calibration: DEFAULT_CALIBRATION(raster),
    regions: [],
    warnings,
  }
}

// ---------------------------------------------------------------------- shared

function contoursOf(raster: Raster, opts: Required<LoadTraceOptions>, warnings: string[]): DetectedPath[] {
  const mask = inkMask(raster, opts)
  const ink = inkFraction(mask)
  if (ink < 0.0005) {
    warnings.push('Almost nothing was detected as a drawn line. Try inverting, or set the threshold by hand.')
    return []
  }
  if (ink > 0.6) {
    warnings.push(
      'Most of this image reads as a drawn line, so region select will not work. It is ' +
        'probably a dark drawing that needs inverting, or a photograph rather than a plan.',
    )
  }
  return traceContours(mask)
}
