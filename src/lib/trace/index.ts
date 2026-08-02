/**
 * Tracing a venue off a drawing.
 *
 *   source.ts    PDF / image  -> raster + vector paths        (the only browser-bound part)
 *   raster.ts    pixels       -> ink mask
 *   detect.ts    ink mask     -> region outlines, snap index
 *   calibrate.ts pixels       -> metres
 *   heights.ts   typed depths -> a fitted surface
 *   build.ts     regions      -> ImportedScene, and from there the ordinary pipeline
 *
 * source.ts is deliberately NOT re-exported here: importing it pulls in pdf.js and a DOM,
 * and the point of the split is that everything else runs in node under test.
 */

export * from './types.ts'
export * from './raster.ts'
export * from './detect.ts'
export * from './calibrate.ts'
export * from './heights.ts'
export * from './build.ts'
export * from './pdfPaths.ts'
