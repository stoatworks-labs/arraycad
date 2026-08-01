/**
 * IFC importer, via web-ifc.
 *
 * IFC is the only input format that carries real semantics. An IfcSlab is a floor, an
 * IfcCovering is usually a ceiling, an IfcWall is a wall — so unlike every other importer
 * this one can suggest an ArrayCalc plane type instead of leaving every object unassigned.
 * That is most of the value of supporting it.
 */

import { PlaneType } from '../dbacv/types.ts'
import { type ImportedNode, type ImportedScene, ImportError } from './types.ts'

let seq = 0
const nextId = () => `ifc${++seq}`

/**
 * IFC entity type -> the plane type it probably is.
 *
 * A suggestion, never a decision: the user still confirms in the inspector. An IfcSlab is
 * a floor slab, which in an auditorium is as likely to be a raked seating deck as a
 * walking surface, and only a person looking at it can say which.
 */
const TYPE_SUGGESTIONS: { match: RegExp; planeType: PlaneType }[] = [
  { match: /IFCSLAB|IFCFLOOR/i, planeType: PlaneType.Audience },
  { match: /IFCCOVERING|IFCROOF|IFCCEILING/i, planeType: PlaneType.Surface },
  { match: /IFCWALL|IFCCURTAINWALL|IFCRAILING|IFCBEAM|IFCCOLUMN|IFCPLATE/i, planeType: PlaneType.Surface },
  { match: /IFCSTAIR|IFCRAMP/i, planeType: PlaneType.Surface },
  { match: /IFCFURNI|IFCCHAIR|IFCSEAT/i, planeType: PlaneType.Audience },
]

function suggestFor(typeName: string): PlaneType | undefined {
  for (const s of TYPE_SUGGESTIONS) if (s.match.test(typeName)) return s.planeType
  return undefined
}

/**
 * web-ifc needs to fetch its own .wasm at runtime. Resolving the URL through
 * `import.meta.url` lets Vite rewrite it to the hashed asset path, so it keeps working
 * from `dist/` and stays same-origin — which matters, because the CSP has no external
 * script or connect source and a CDN default would be blocked.
 */
async function createApi() {
  const { IfcAPI } = await import('web-ifc')
  const api = new IfcAPI()
  const wasmUrl = new URL('web-ifc/web-ifc.wasm', import.meta.url)
  const dir = wasmUrl.href.slice(0, wasmUrl.href.lastIndexOf('/') + 1)
  api.SetWasmPath(dir, true)
  await api.Init()
  return api
}

export async function importIfc(buffer: ArrayBuffer, filename: string): Promise<ImportedScene> {
  const warnings: string[] = []
  let api: Awaited<ReturnType<typeof createApi>>
  try {
    api = await createApi()
  } catch (e) {
    throw new ImportError(
      `The IFC engine could not start: ${(e as Error).message}`,
      'This needs WebAssembly. If the page is served with a Content-Security-Policy that ' +
        "omits 'wasm-unsafe-eval', IFC import fails here and nowhere else.",
    )
  }

  let modelId: number
  try {
    modelId = api.OpenModel(new Uint8Array(buffer))
  } catch (e) {
    throw new ImportError(`Could not open this IFC file: ${(e as Error).message}`)
  }

  try {
    // Group by IFC entity type. That is the axis a person prunes along — "drop all the
    // furniture", "keep the slabs" — and it is exactly what carries the type suggestion.
    const byType = new Map<string, { tris: number[]; suggestion?: PlaneType }>()

    api.StreamAllMeshes(modelId, (mesh) => {
      const geometries = mesh.geometries
      for (let i = 0; i < geometries.size(); i++) {
        const placed = geometries.get(i)
        const geom = api.GetGeometry(modelId, placed.geometryExpressID)
        const verts = api.GetVertexArray(geom.GetVertexData(), geom.GetVertexDataSize())
        const idx = api.GetIndexArray(geom.GetIndexData(), geom.GetIndexDataSize())
        const m = placed.flatTransformation

        let typeName = 'IFC object'
        try {
          const line = api.GetLine(modelId, mesh.expressID)
          typeName = api.GetNameFromTypeCode(line.type) || 'IFC object'
        } catch {
          // A malformed line should cost us one object's label, not the import.
        }

        let bucket = byType.get(typeName)
        if (!bucket) {
          bucket = { tris: [], suggestion: suggestFor(typeName) }
          byType.set(typeName, bucket)
        }

        // web-ifc packs 6 floats per vertex: position xyz then normal xyz.
        for (let k = 0; k < idx.length; k++) {
          const v = idx[k] * 6
          const x = verts[v]
          const y = verts[v + 1]
          const z = verts[v + 2]
          // flatTransformation is a column-major 4x4.
          bucket.tris.push(
            m[0] * x + m[4] * y + m[8] * z + m[12],
            m[1] * x + m[5] * y + m[9] * z + m[13],
            m[2] * x + m[6] * y + m[10] * z + m[14],
          )
        }
        geom.delete()
      }
    })

    const nodes: ImportedNode[] = []
    for (const [typeName, bucket] of [...byType].sort((a, b) => a[0].localeCompare(b[0]))) {
      if (bucket.tris.length === 0) continue
      nodes.push({
        id: nextId(),
        name: typeName,
        tags: [`ifc:${typeName}`],
        positions: new Float64Array(bucket.tris),
        suggestedPlaneType: bucket.suggestion,
        children: [],
      })
    }

    if (nodes.length === 0) {
      throw new ImportError(
        'That IFC file opened but contains no geometry.',
        'It may be a coordination or property-only export. Re-export with geometry included.',
      )
    }

    const unassigned = nodes.filter((n) => !n.suggestedPlaneType).length
    if (unassigned > 0) {
      warnings.push(
        `${unassigned} IFC type(s) had no obvious plane type and are unassigned — set them in the inspector.`,
      )
    }

    return {
      format: 'IFC',
      sourceName: filename.replace(/\.[^.]+$/, ''),
      // IFC geometry from web-ifc comes out in metres, and IFC is Z-up.
      unitsPerMetre: 1,
      upAxis: 'z',
      nodes,
      warnings,
    }
  } finally {
    api.CloseModel(modelId)
  }
}
