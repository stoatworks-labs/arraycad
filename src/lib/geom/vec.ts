/**
 * Minimal 3D vector maths.
 *
 * Deliberately independent of three.js: everything from here down to the .dbacv writer is
 * pure and runs in node, so the whole conversion pipeline is unit-testable without a DOM
 * or a WebGL context. three.js appears only in the viewport.
 */

import type { Vec3 } from '../dbacv/types.ts'

export type { Vec3 }

export const v3 = (x: number, y: number, z: number): Vec3 => ({ x, y, z })
export const add = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z })
export const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z })
export const scale = (a: Vec3, s: number): Vec3 => ({ x: a.x * s, y: a.y * s, z: a.z * s })
export const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z
export const cross = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
})
export const len = (a: Vec3): number => Math.sqrt(dot(a, a))

export function normalize(a: Vec3): Vec3 {
  const l = len(a)
  return l > 0 ? scale(a, 1 / l) : v3(0, 0, 0)
}

export const dist = (a: Vec3, b: Vec3): number => len(sub(a, b))

/** A plane as a unit normal and a point on it. */
export interface Plane {
  normal: Vec3
  point: Vec3
}

export const signedDistanceToPlane = (p: Vec3, pl: Plane): number => dot(sub(p, pl.point), pl.normal)

/**
 * An orthonormal basis for a plane, for projecting to 2D and back.
 *
 * The `u` axis is picked from whichever world axis is least aligned with the normal, so it
 * never degenerates. That makes the 2D frame arbitrary but stable — fine, because every
 * consumer projects and unprojects with the same basis.
 */
export interface Basis {
  origin: Vec3
  u: Vec3
  v: Vec3
  n: Vec3
}

export function planeBasis(pl: Plane): Basis {
  const n = normalize(pl.normal)
  const ax = Math.abs(n.x)
  const ay = Math.abs(n.y)
  const az = Math.abs(n.z)
  const seed = ax <= ay && ax <= az ? v3(1, 0, 0) : ay <= az ? v3(0, 1, 0) : v3(0, 0, 1)
  const u = normalize(cross(seed, n))
  const v = cross(n, u)
  return { origin: pl.point, u, v, n }
}

export function toPlane2D(p: Vec3, b: Basis): [number, number] {
  const d = sub(p, b.origin)
  return [dot(d, b.u), dot(d, b.v)]
}

export function fromPlane2D(x: number, y: number, b: Basis): Vec3 {
  return add(b.origin, add(scale(b.u, x), scale(b.v, y)))
}

/** Twice the signed area of a 2D polygon. Positive is counter-clockwise. */
export function signedArea2(poly: [number, number][]): number {
  let a = 0
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    a += poly[j][0] * poly[i][1] - poly[i][0] * poly[j][1]
  }
  return a
}

/** Area of the triangle a-b-c in 3D. */
export function triArea(a: Vec3, b: Vec3, c: Vec3): number {
  return 0.5 * len(cross(sub(b, a), sub(c, a)))
}

/** Unit normal of triangle a-b-c, or the zero vector when degenerate. */
export function triNormal(a: Vec3, b: Vec3, c: Vec3): Vec3 {
  return normalize(cross(sub(b, a), sub(c, a)))
}
