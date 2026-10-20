/**
 * Preparation: everything that can be settled about a model before the user is asked.
 *
 * Two halves, kept apart on purpose:
 *
 *   plan.ts      reads the model and produces DECISIONS. Nothing is destroyed.
 *   split.ts     cuts a one-piece model into rakes, floor, ceiling and walls. The same
 *                triangles, in parts a person can prune and the plan can read.
 *   simplify.ts  re-cuts heavy objects into fewer triangles. The same shape, less of it.
 *
 * See `plan.ts` for why the first half must never touch the scene, and `split.ts` and
 * `simplify.ts` for what the second half is allowed to change and what it refuses to.
 */

export * from './vocabulary.ts'
export * from './plan.ts'
export * from './split.ts'
export * from './simplify.ts'
