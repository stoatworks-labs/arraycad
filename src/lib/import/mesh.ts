/**
 * Mesh-format importers, all via three.js loaders.
 *
 * OBJ, STL, PLY, glTF/GLB, FBX, Collada and 3DS. Every one of them ends the same way:
 * walk the Object3D tree, bake each mesh's world matrix into its vertices, and hand back
 * triangle soup in the file's own units. No unit or axis guessing here — see types.ts.
 */

import * as THREE from 'three'
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js'
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js'
import { ColladaLoader } from 'three/examples/jsm/loaders/ColladaLoader.js'
import { TDSLoader } from 'three/examples/jsm/loaders/TDSLoader.js'
import { type ImportedNode, type ImportedScene, ImportError } from './types.ts'

let seq = 0
const nextId = () => `imp${++seq}`

/**
 * Bake an Object3D's world transform into a flat triangle array.
 *
 * `updateWorldMatrix` first: several loaders return a tree whose matrices have never been
 * composed, and an un-updated matrixWorld is the identity, so a model assembled from
 * instanced blocks silently collapses into a heap at the origin.
 */
function meshToTriangles(mesh: THREE.Mesh): Float64Array {
  mesh.updateWorldMatrix(true, false)
  const geom = mesh.geometry
  const pos = geom.getAttribute('position') as THREE.BufferAttribute | undefined
  if (!pos) return new Float64Array(0)

  const index = geom.getIndex()
  const count = index ? index.count : pos.count
  const out = new Float64Array(count * 3)
  const v = new THREE.Vector3()

  for (let i = 0; i < count; i++) {
    const vi = index ? index.getX(i) : i
    v.fromBufferAttribute(pos, vi).applyMatrix4(mesh.matrixWorld)
    out[i * 3] = v.x
    out[i * 3 + 1] = v.y
    out[i * 3 + 2] = v.z
  }
  // A geometry with a stray vertex count is not a triangle list; truncate rather than
  // read past the end and produce a triangle out of whatever follows.
  const tris = Math.floor(out.length / 9)
  if (tris * 9 === out.length) return out
  const trimmed = new Float64Array(tris * 9)
  trimmed.set(out.subarray(0, tris * 9))
  return trimmed
}

/**
 * Convert a three scene graph to ImportedNodes.
 *
 * Named parents become groups so the CAD tree survives; a mesh with no useful name inherits
 * one from its parent, because "Object_017" is not a name anyone can prune by.
 */
function sceneToNodes(root: THREE.Object3D, fallbackName: string): ImportedNode[] {
  const build = (obj: THREE.Object3D, inherited: string): ImportedNode | null => {
    const name = obj.name?.trim() || inherited
    const children: ImportedNode[] = []
    for (const c of obj.children) {
      const n = build(c, name)
      if (n) children.push(n)
    }

    // Annotated: an un-annotated `new Float64Array(0)` narrows to Float64Array<ArrayBuffer>,
    // which the loader's ArrayBufferLike result then will not assign to.
    let positions: Float64Array = new Float64Array(0)
    if ((obj as THREE.Mesh).isMesh) positions = meshToTriangles(obj as THREE.Mesh)

    if (positions.length === 0 && children.length === 0) return null
    // Collapse a group that exists only to hold one child — CAD exporters emit chains of
    // these and they make the tree three times deeper than the model actually is.
    if (positions.length === 0 && children.length === 1) return children[0]

    const tags: string[] = []
    const mat = (obj as THREE.Mesh).material
    if (mat && !Array.isArray(mat) && mat.name) tags.push(mat.name)

    return { id: nextId(), name: name || fallbackName, tags, positions, children }
  }

  const top = build(root, fallbackName)
  if (!top) return []
  // The loader's own wrapper root is not interesting; hoist its children.
  return top.positions.length === 0 && top.children.length > 0 ? top.children : [top]
}

type MeshFormat = 'obj' | 'stl' | 'ply' | 'gltf' | 'glb' | 'fbx' | 'dae' | '3ds'

export async function importMesh(
  buffer: ArrayBuffer,
  filename: string,
  format: MeshFormat,
): Promise<ImportedScene> {
  const warnings: string[] = []
  const base = filename.replace(/\.[^.]+$/, '')
  let root: THREE.Object3D

  try {
    switch (format) {
      case 'obj': {
        root = new OBJLoader().parse(new TextDecoder().decode(buffer))
        warnings.push('OBJ carries no units. Check the unit setting before exporting.')
        break
      }
      case 'stl': {
        const geom = new STLLoader().parse(buffer)
        root = new THREE.Mesh(geom)
        root.name = base
        warnings.push(
          'STL has no object names and no units — the whole model arrives as one node. ' +
            'Coplanar merging still separates the surfaces, but you cannot prune by name.',
        )
        break
      }
      case 'ply': {
        const geom = new PLYLoader().parse(buffer)
        root = new THREE.Mesh(geom)
        root.name = base
        break
      }
      case 'glb':
      case 'gltf': {
        const gltf = await new Promise<{ scene: THREE.Object3D }>((resolve, reject) => {
          new GLTFLoader().parse(buffer, '', resolve as never, reject)
        })
        root = gltf.scene
        break
      }
      case 'fbx': {
        root = new FBXLoader().parse(buffer, '')
        break
      }
      case 'dae': {
        const dae = new ColladaLoader().parse(new TextDecoder().decode(buffer), '')
        root = dae.scene
        break
      }
      case '3ds': {
        root = new TDSLoader().parse(buffer, '')
        break
      }
    }
  } catch (e) {
    throw new ImportError(
      `Could not read this ${format.toUpperCase()} file: ${(e as Error).message}`,
      format === 'glb' || format === 'gltf'
        ? 'If the file uses Draco or Meshopt compression, re-export it uncompressed.'
        : 'Try re-exporting from the source application.',
    )
  }

  const nodes = sceneToNodes(root, base)
  if (nodes.length === 0) {
    throw new ImportError(
      'That file loaded but contains no triangles.',
      'It may hold only curves, lights or cameras. Meshes are needed — in the source ' +
        'application, convert or export the geometry as a mesh.',
    )
  }

  // glTF is metres and Y-up by specification, so those are facts rather than guesses. The
  // other formats declare nothing and the user has to choose.
  const isGltf = format === 'gltf' || format === 'glb'
  return {
    format: format.toUpperCase(),
    sourceName: base,
    unitsPerMetre: isGltf ? 1 : undefined,
    upAxis: isGltf || format === 'dae' || format === 'fbx' ? 'y' : undefined,
    nodes,
    warnings,
  }
}
