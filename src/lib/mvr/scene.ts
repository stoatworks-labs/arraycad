/**
 * `MvrScene` -> `ImportedNode[]`: the matrix chain, instancing, units and tagging.
 *
 * This is the part most likely to be wrong, so it is the part that must run in node. The
 * geometry decoder is injected rather than imported, which keeps three.js out of `src/lib`
 * (AGENTS.md §2) and lets the tests drive the whole thing with a stub that returns known
 * triangles — the matrix maths, the symbol instancing and the unit normalisation are then
 * checkable exactly, without a glb anywhere near them.
 *
 * Everything leaves here in MILLIMETRES, MVR's own declared distance unit. See types.ts
 * for why that is a normalisation rather than a units guess, and docs/mvr-format.md for
 * the one part of it the specification does not state.
 */

import type { ImportedNode } from '../import/types.ts'
import {
  type MvrGeometry,
  type MvrMatrix,
  type MvrObject,
  type MvrObjectType,
  type MvrScene,
  GLTF_METRES_PER_UNIT,
  IDENTITY,
  MVR_UNITS_PER_METRE,
  TDS_METRES_PER_UNIT,
  applyMatrix,
  mul,
  scaleMatrix,
} from './types.ts'

/**
 * Decode one geometry file to nodes in the FILE's own units.
 *
 * Returns an empty array for a file it cannot read; throwing would lose the whole venue
 * over one unreadable truss.
 */
export type MeshDecoder = (bytes: Uint8Array, fileName: string) => Promise<ImportedNode[]>

export interface BuildOptions {
  /** Archive members, keyed by LOWER-CASE name, as `container.readMembers` returns them. */
  files: Map<string, Uint8Array>
  decode: MeshDecoder
}

export interface BuildResult {
  nodes: ImportedNode[]
  warnings: string[]
  /** Fixtures whose geometry lives only in a `.gdtf`. Reported, not imported. */
  fixturesSkipped: number
}

let seq = 0
const nextId = () => `mvr${++seq}`

/**
 * Every archive member the scene actually references.
 *
 * The container decompresses only these, so a show MVR's textures and its one `.gdtf` per
 * fixture type — each itself a zip full of models — are never inflated. See container.ts.
 */
export function referencedFiles(scene: MvrScene): Set<string> {
  const out = new Set<string>()
  const fromGeometries = (gs: MvrGeometry[], visiting: Set<string>) => {
    for (const g of gs) {
      if (g.kind === 'file') {
        out.add(g.fileName)
        continue
      }
      const symdef = scene.symdefs.get(g.symdef)
      if (!symdef || visiting.has(g.symdef)) continue
      visiting.add(g.symdef)
      fromGeometries(symdef.geometries, visiting)
      visiting.delete(g.symdef)
    }
  }
  const fromObject = (obj: MvrObject) => {
    fromGeometries(obj.geometries, new Set())
    for (const c of obj.children) fromObject(c)
  }
  for (const layer of scene.layers) for (const obj of layer.children) fromObject(obj)
  return out
}

/**
 * Metres per unit of a referenced geometry file, from its extension.
 *
 * Spec Table 46 lists exactly two formats and constrains `.3ds` to millimetres; glTF is
 * left to its own specification, which is metres. Spec §"Node Definition: Geometry3D":
 * "If there is no extension, it will assume that the extension is 3ds."
 */
function metresPerUnitFor(fileName: string): number | null {
  const dot = fileName.lastIndexOf('.')
  if (dot === -1) return TDS_METRES_PER_UNIT
  switch (fileName.slice(dot + 1).toLowerCase()) {
    case '3ds':
      return TDS_METRES_PER_UNIT
    case 'glb':
    case 'gltf':
      return GLTF_METRES_PER_UNIT
    default:
      return null
  }
}

/**
 * MVR node types that need a plain-English word before `prepare/vocabulary.ts` can read
 * them.
 *
 * That module splits camelCase and matches whole words, so `Truss`, `Fixture` and
 * `Projector` already land on entries in its clutter list and need nothing here.
 * `Support` does not — the word is too ambiguous in a building model to put in the list
 * on its own ("ROOF SUPPORT" is structural steel, not rigging) — but MVR's `Support` is
 * unambiguously infrastructure, so the type is translated into the vocabulary's own term
 * for it. That is the importer reporting a fact the format states, not deciding anything:
 * the decision stays in `prepare/`, visible in the tree and reversible in one click.
 *
 * `VideoScreen` is absent on purpose. An LED wall is a large rigid reflector and belongs
 * in the prediction.
 */
const VOCABULARY_SYNONYM: Partial<Record<MvrObjectType, string>> = {
  Support: 'rigging',
}

/** Deep-copy a node tree, so one Symdef can be instanced at several matrices. */
function cloneNodes(nodes: ImportedNode[]): ImportedNode[] {
  return nodes.map((n) => ({
    ...n,
    id: nextId(),
    tags: [...n.tags],
    positions: n.positions.slice(),
    children: cloneNodes(n.children),
  }))
}

function transformNodes(nodes: ImportedNode[], m: MvrMatrix): void {
  for (const n of nodes) {
    applyMatrix(n.positions, m)
    transformNodes(n.children, m)
  }
}

/**
 * Push tags onto every node of a subtree, not just its root.
 *
 * `prepare/plan.ts` judges each node on its own name and tags — it does not look at
 * ancestors — so a `Truss` wrapper whose children came in from a glb named `Mesh_0` would
 * be pruned while the mesh under it survived. The fact that these triangles are a truss is
 * known here and nowhere else, so it is stamped on all of them here.
 */
function tagSubtree(nodes: ImportedNode[], tags: string[]): void {
  if (tags.length === 0) return
  for (const n of nodes) {
    for (const t of tags) if (!n.tags.includes(t)) n.tags.push(t)
    tagSubtree(n.children, tags)
  }
}

class Builder {
  warnings: string[] = []
  fixturesSkipped = 0
  private missing = new Set<string>()
  private unsupported = new Set<string>()
  /** Decoded once per file, in MVR millimetres, then cloned per reference. */
  private decoded = new Map<string, ImportedNode[]>()

  constructor(
    private scene: MvrScene,
    private opts: BuildOptions,
  ) {}

  private async decodeFile(fileName: string): Promise<ImportedNode[]> {
    const key = fileName.toLowerCase()
    const cached = this.decoded.get(key)
    if (cached) return cached

    const metresPerUnit = metresPerUnitFor(fileName)
    if (metresPerUnit === null) {
      this.unsupported.add(fileName)
      this.decoded.set(key, [])
      return []
    }
    const bytes = this.opts.files.get(key)
    if (!bytes) {
      this.missing.add(fileName)
      this.decoded.set(key, [])
      return []
    }

    let nodes: ImportedNode[] = []
    try {
      nodes = await this.opts.decode(bytes, fileName)
    } catch (e) {
      this.warnings.push(`Could not read "${fileName}": ${(e as Error).message}`)
      this.decoded.set(key, [])
      return []
    }

    // Into MVR millimetres, once, here — so every matrix downstream composes in one unit.
    const s = metresPerUnit / MVR_UNITS_PER_METRE
    if (s !== 1) transformNodes(nodes, scaleMatrix(s))
    this.decoded.set(key, nodes)
    return nodes
  }

  /**
   * Resolve a list of `Geometry3D`/`Symbol` entries into nodes, placed by `parent`.
   *
   * `visiting` is the chain of Symdef uuids currently being resolved. A Symdef that
   * instances itself — directly or through another — would otherwise recurse until the
   * stack gives out, and a malformed file should not be able to hang the tab.
   */
  private async resolve(
    geometries: MvrGeometry[],
    parent: MvrMatrix,
    visiting: Set<string>,
  ): Promise<ImportedNode[]> {
    const out: ImportedNode[] = []
    for (const g of geometries) {
      const m = mul(parent, g.matrix)
      if (g.kind === 'file') {
        const decoded = await this.decodeFile(g.fileName)
        if (decoded.length === 0) continue
        const copy = cloneNodes(decoded)
        transformNodes(copy, m)
        out.push(...copy)
        continue
      }

      const symdef = this.scene.symdefs.get(g.symdef)
      if (!symdef) {
        this.warnings.push(`A symbol refers to a definition ${g.symdef} that is not in the file.`)
        continue
      }
      if (visiting.has(g.symdef)) {
        this.warnings.push(
          `The symbol definition "${symdef.name || g.symdef}" contains itself; ` +
            'the repeat was left out.',
        )
        continue
      }
      visiting.add(g.symdef)
      out.push(...(await this.resolve(symdef.geometries, m, visiting)))
      visiting.delete(g.symdef)
    }
    return out
  }

  async buildObject(obj: MvrObject, parent: MvrMatrix): Promise<ImportedNode | null> {
    const world = mul(parent, obj.matrix)
    const own = await this.resolve(obj.geometries, world, new Set())

    const children: ImportedNode[] = []
    for (const c of obj.children) {
      const n = await this.buildObject(c, world)
      if (n) children.push(n)
    }

    if (own.length === 0 && children.length === 0) {
      // A fixture whose geometry is only in its GDTF is the common case here, and it is
      // not a loss: ArrayCalc places its own sources, and a venue full of surfaces shaped
      // like lanterns is exactly what `prepare/` spends its time removing. Unzipping a
      // GDTF to import one would be work done in order to throw the result away.
      if (obj.type === 'Fixture' || obj.gdtfSpec) this.fixturesSkipped++
      return null
    }

    // The MVR node type is the reliable signal in a visualiser model — a truss is as
    // likely to be named "Sunstrip 12" as "TRUSS 1" — so it goes on every node, and the
    // class name with it, being the axis MVR users actually organise by.
    const tags: string[] = [obj.type]
    if (obj.className) tags.push(obj.className)
    const synonym = VOCABULARY_SYNONYM[obj.type]
    if (synonym) tags.push(synonym)
    tagSubtree(own, tags)

    const name = obj.name || obj.className || obj.type

    // One decoded node under one MVR object is the same object twice. Collapse it, the way
    // mesh.ts collapses a group that exists only to hold one child, and keep the MVR name:
    // "STAGE DECK" beats the "Mesh_0" the exporter put inside the glb.
    if (own.length === 1 && own[0].children.length === 0 && children.length === 0) {
      return { ...own[0], name, tags: [...new Set([...tags, ...own[0].tags])] }
    }

    return {
      id: nextId(),
      name,
      tags,
      positions: new Float64Array(0),
      children: [...own, ...children],
    }
  }

  finish(): void {
    if (this.missing.size > 0) {
      this.warnings.push(
        `${this.missing.size} geometry file(s) referenced by the scene are not in the ` +
          `archive and were skipped: ${[...this.missing].slice(0, 5).join(', ')}` +
          `${this.missing.size > 5 ? ', …' : ''}.`,
      )
    }
    if (this.unsupported.size > 0) {
      this.warnings.push(
        `Skipped geometry in an unsupported format: ${[...this.unsupported].slice(0, 5).join(', ')}. ` +
          'MVR allows only .3ds and glTF (.glb/.gltf).',
      )
    }
    if (this.fixturesSkipped > 0) {
      this.warnings.push(
        `Left out ${this.fixturesSkipped} lighting fixture(s) whose shape lives in a GDTF ` +
          'file. ArrayCalc places its own sources, so imported lanterns would only need ' +
          'pruning again.',
      )
    }
  }
}

/**
 * Millimetres, the largest extent of the whole scene.
 *
 * The units check below is deliberately about the WHOLE scene rather than per object: one
 * mis-scaled truss is a modelling error and none of this tool's business, whereas a room
 * that is 40 mm or 40 km across is the glTF-units question having been answered wrongly,
 * and that is worth saying out loud.
 */
function largestExtent(nodes: ImportedNode[]): number {
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  const walk = (ns: ImportedNode[]) => {
    for (const n of ns) {
      const p = n.positions
      for (let i = 0; i + 2 < p.length; i += 3) {
        for (let a = 0; a < 3; a++) {
          if (p[i + a] < min[a]) min[a] = p[i + a]
          if (p[i + a] > max[a]) max[a] = p[i + a]
        }
      }
      walk(n.children)
    }
  }
  walk(nodes)
  if (min[0] === Infinity) return 0
  return Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2])
}

/** Metres. A room smaller than this, or larger than MAX, is reported as suspect. */
const PLAUSIBLE_MIN_METRES = 1
const PLAUSIBLE_MAX_METRES = 1000

export async function buildMvrNodes(
  scene: MvrScene,
  opts: BuildOptions,
): Promise<BuildResult> {
  const builder = new Builder(scene, opts)
  const nodes: ImportedNode[] = []

  for (const layer of scene.layers) {
    const children: ImportedNode[] = []
    for (const obj of layer.children) {
      // Spec: a Layer's Matrix may only carry elevation, but composing it in full costs
      // nothing and is right for a file that ignores that restriction.
      const n = await builder.buildObject(obj, mul(IDENTITY, layer.matrix))
      if (n) children.push(n)
    }
    if (children.length === 0) continue
    nodes.push({
      id: nextId(),
      name: layer.name || 'Layer',
      tags: ['Layer'],
      positions: new Float64Array(0),
      children,
    })
  }

  builder.finish()

  const extentMetres = largestExtent(nodes) * MVR_UNITS_PER_METRE
  if (extentMetres > 0 && (extentMetres < PLAUSIBLE_MIN_METRES || extentMetres > PLAUSIBLE_MAX_METRES)) {
    builder.warnings.push(
      `This scene measures ${extentMetres.toPrecision(3)} m across, which is an unlikely ` +
        'size for a venue. MVR states its own unit as millimetres but does not state the ' +
        'unit of the 3D files inside it, so a file written to a different assumption ' +
        'arrives 1000x out. Check the size against the source and change the unit setting ' +
        'if it is wrong.',
    )
  }

  return { nodes, warnings: builder.warnings, fixturesSkipped: builder.fixturesSkipped }
}
