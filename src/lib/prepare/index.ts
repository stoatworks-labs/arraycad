/**
 * Preparation: everything that can be settled about a model before the user is asked.
 *
 * Two halves, kept apart on purpose:
 *
 *   plan.ts      reads the model and produces DECISIONS. Nothing is destroyed.
 *   simplify.ts  re-cuts heavy objects into fewer triangles. The same shape, less of it.
 *
 * See `plan.ts` for why the first half must never touch the scene, and `simplify.ts` for
 * what the second half refuses to do.
 */

export * from './vocabulary.ts'
export * from './plan.ts'
export * from './simplify.ts'
