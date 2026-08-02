/**
 * Reader for the Soundvision 3D room data text format.
 *
 * This exists mostly to prove the writer: parsing a real Vectorworks export and writing it
 * straight back has to reproduce the file byte for byte, the same standard
 * `dbacv.test.ts` holds the ArrayCalc writer to. It is also what makes an existing
 * Soundvision room usable as an import source.
 */

import type { Vec3 } from '../geom/vec.ts'
import type { SoundvisionFace, SoundvisionScene } from './types.ts'

const LABEL = /^"Label","(.*)"$/
const COORD = /^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/

export interface ReadResult {
  scene: SoundvisionScene
  warnings: string[]
}

export function readSoundvision(text: string): ReadResult {
  // Tolerate CRLF even though the plug-ins write LF: a file that has been through Windows
  // or a mail client should still import rather than fail on an invisible byte.
  const lines = text.split(/\r?\n/)

  const header: string[] = []
  const faces: SoundvisionFace[] = []
  const warnings: string[] = []

  let current: SoundvisionFace | null = null
  let started = false
  let ignored = 0

  const close = () => {
    if (!current) return
    if (current.points.length >= 3) faces.push(current)
    else if (current.points.length > 0) {
      warnings.push(`Dropped "${current.label}": ${current.points.length} point(s), need at least 3.`)
    }
    current = null
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line === '') continue

    const label = LABEL.exec(line)
    if (label) {
      // An unterminated face is not worth rejecting the file over — close it and move on.
      if (current) close()
      started = true
      current = { label: label[1], points: [] }
      continue
    }

    if (line.startsWith('";')) {
      // Before the first face every comment is header and is kept verbatim so the file can
      // be written back unchanged. After it, `";"` is the terminator and anything else is a
      // stray comment we simply skip.
      if (!started) header.push(line)
      else if (line === '";"') close()
      else ignored++
      continue
    }

    const coord = COORD.exec(line)
    if (!coord) {
      ignored++
      continue
    }
    if (!current) {
      warnings.push(`Line ${i + 1}: coordinates outside any face were skipped.`)
      continue
    }
    const p: Vec3 = { x: Number(coord[1]), y: Number(coord[2]), z: Number(coord[3]) }
    current.points.push(p)
  }

  close()

  if (ignored > 0) warnings.push(`${ignored} unrecognised line(s) were skipped.`)
  if (faces.length === 0) {
    warnings.push('No faces were found. Is this a Soundvision 3D room data export?')
  }

  return { scene: { header, faces }, warnings }
}
