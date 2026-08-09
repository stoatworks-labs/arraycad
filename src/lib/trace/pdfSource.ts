/**
 * A PDF page -> a trace document. Loaded on demand.
 *
 * Split out from source.ts purely so pdf.js is a **dynamic import**: it is 400 kB that
 * nobody dropping a DXF, a glTF or a photograph of a plan should ever have to download.
 * source.ts imports this module only once it has seen a `.pdf`.
 *
 * A page is read twice over: rasterised for the user to look at, and walked as an operator
 * list for the vector lines to snap to. When there are no vector lines — a scan, a
 * flattened export — outlines are recovered from the pixels by the caller instead.
 */

import * as pdfjs from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { ImportError } from '../import/types.ts'
import { type DetectedPath, type Raster, type TraceDocument, DEFAULT_CALIBRATION } from './types.ts'
import { type Mat, pathsFromOperatorList } from './pdfPaths.ts'

// Same-origin worker: the CSP has no external script source, so a CDN default would be
// blocked and every PDF would fail with a message about the worker, not about the file.
pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

export interface PdfLoadOptions {
  pageIndex: number
  targetPx: number
  /** Recover outlines from the rendered pixels, for a page with no vector line work. */
  contoursOf: (raster: Raster, warnings: string[]) => DetectedPath[]
}

export async function loadPdf(file: File, opts: PdfLoadOptions): Promise<TraceDocument> {
  const data = new Uint8Array(await file.arrayBuffer())
  const loadingTask = pdfjs.getDocument({ data })
  let pdf: pdfjs.PDFDocumentProxy
  try {
    pdf = await loadingTask.promise
  } catch (e) {
    throw new ImportError(
      `Could not read "${file.name}" as a PDF.`,
      (e as Error).message +
        '\n\nA password-protected or damaged PDF cannot be traced. Re-export it, or print it ' +
        'to a new PDF first.',
    )
  }

  try {
    const warnings: string[] = []
    const pageCount = pdf.numPages
    const pageIndex = Math.max(0, Math.min(pageCount - 1, opts.pageIndex))
    const page = await pdf.getPage(pageIndex + 1)
    const unit = page.getViewport({ scale: 1 })
    const scale = Math.min(opts.targetPx / Math.max(unit.width, unit.height), 8)
    const viewport = page.getViewport({ scale })

    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(viewport.width))
    canvas.height = Math.max(1, Math.round(viewport.height))
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) throw new ImportError('This browser would not give ArrayCAD a 2D canvas to render the PDF into.')
    // PDFs have no background of their own; without this the page renders onto transparent
    // black and every unfilled area reads as solid ink.
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    await page.render({ canvas, canvasContext: ctx, viewport }).promise
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height)
    const raster: Raster = { width: img.width, height: img.height, data: img.data }

    let paths: DetectedPath[] = []
    try {
      const opList = await page.getOperatorList()
      const r = pathsFromOperatorList(
        opList,
        pdfjs.OPS as unknown as Parameters<typeof pathsFromOperatorList>[1],
        viewport.transform as Mat,
      )
      paths = r.paths
      warnings.push(...r.warnings)
    } catch (e) {
      warnings.push(
        `The vector lines in this page could not be read (${(e as Error).message}), so snapping ` +
          'uses outlines detected from the rendered pixels instead.',
      )
    }
    if (paths.length === 0) paths = opts.contoursOf(raster, warnings)

    return {
      format: pageCount > 1 ? `PDF page ${pageIndex + 1} of ${pageCount}` : 'PDF',
      sourceName: file.name,
      raster,
      paths,
      // No scale is claimed from the PDF itself: the paper scale is printed in the title
      // block, and reading it is the user's job. The UI offers calibrateByPaperScale once
      // they say what it is.
      calibration: DEFAULT_CALIBRATION(raster),
      regions: [],
      page: { index: pageIndex, count: pageCount, pixelsPerPagePoint: scale },
      warnings,
    }
  } finally {
    // Releases the worker's copy of the document. In `finally` because a render that
    // throws half way would otherwise leak it for the life of the tab. Via the loading
    // task since pdf.js 6 — PDFDocumentProxy.destroy is gone.
    void loadingTask.destroy()
  }
}
