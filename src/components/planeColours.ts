/**
 * One palette for plane types across the whole UI.
 *
 * Deliberately NOT ArrayCalc's own colours — those are pale pastels chosen for a white
 * drawing area and they vanish on this app's navy. `PLANE_COLOURS` in geom/convert.ts is
 * the ArrayCalc palette and is what gets written into the venue file; this one is only
 * ever shown on screen. Keeping them separate is why an export looks native in ArrayCalc
 * while the tree, the viewport and the tracer stay legible here.
 */

import { PlaneType } from '../lib/dbacv/types.ts'

export const PLANE_UI_COLOUR: Record<number, string> = {
  [PlaneType.None]: '#8899aa',
  [PlaneType.Listening]: '#f0a04b',
  [PlaneType.Surface]: '#5ec98a',
  [PlaneType.Type3]: '#999999',
  [PlaneType.Stage]: '#b07be0',
  [PlaneType.PositioningArea]: '#00c0ae',
}

/** The same palette as three.js wants it. */
export const PLANE_UI_HEX: Record<number, number> = Object.fromEntries(
  Object.entries(PLANE_UI_COLOUR).map(([k, v]) => [Number(k), Number.parseInt(v.slice(1), 16)]),
)
