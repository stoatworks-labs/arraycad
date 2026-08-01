/**
 * Import dispatcher. One entry point, extension-driven.
 */

import { type ImportedScene, ImportError } from './types.ts'
import { importMesh } from './mesh.ts'
import { type DxfOptions, importDxf } from './dxf.ts'
import { importIfc } from './ifc.ts'
import { importDbacvAsScene } from './dbacvScene.ts'

export * from './types.ts'
export { DEFAULT_DXF_OPTIONS } from './dxf.ts'
export { importDbacvExact } from './dbacvScene.ts'

export const ACCEPTED_EXTENSIONS = [
  '.dxf',
  '.obj',
  '.stl',
  '.ply',
  '.gltf',
  '.glb',
  '.fbx',
  '.dae',
  '.3ds',
  '.ifc',
  '.dbacv',
] as const

/**
 * Formats we are asked for and cannot read, with the route that does work.
 *
 * These are closed binary formats with no public specification. Refusing them clearly and
 * saying what to export instead is far more useful than letting a parser fail with
 * "unexpected byte 0x1f", which reads like a bug in this tool.
 */
const CLOSED_FORMATS: Record<string, { name: string; advice: string }> = {
  '.vwx': {
    name: 'Vectorworks',
    advice:
      'Vectorworks files are a closed binary format with no public specification — nothing ' +
      'outside Vectorworks can read one. Export from Vectorworks instead, best first:\n\n' +
      '1. glTF (.glb) — keeps object names and the class/layer tree, so pruning here works ' +
      'by the names you already use.\n' +
      '2. IFC — keeps semantics, so plane types can be suggested automatically.\n' +
      '3. DXF 3D — universal, but arrives as one lump per layer.\n\n' +
      'Export only the classes you need (seating, stage, walls, ceiling) and leave lighting, ' +
      'rigging and dimensions behind — it saves most of the pruning.',
  },
  '.dwg': {
    name: 'AutoCAD DWG',
    advice:
      'DWG is a closed binary format. In AutoCAD use SAVEAS and choose DXF (R2013 ASCII is ' +
      'safest), or run the free ODA File Converter to turn DWG into DXF, then drop the DXF here.',
  },
  '.skp': {
    name: 'SketchUp',
    advice:
      'SketchUp files need SketchUp to read. Use File > Export > 3D Model and choose Collada ' +
      '(.dae) or glTF, then drop that here. Collada keeps the group and component names.',
  },
  '.rvt': {
    name: 'Revit',
    advice: 'Export IFC from Revit (File > Export > IFC) and drop the .ifc here — it keeps the ' +
      'element types, so plane types get suggested for you.',
  },
  '.3dm': {
    name: 'Rhino',
    advice: 'Export from Rhino as OBJ, glTF or DXF and drop that here.',
  },
  '.max': { name: '3ds Max', advice: 'Export as FBX, glTF or OBJ and drop that here.' },
  '.blend': { name: 'Blender', advice: 'Export as glTF (.glb) and drop that here.' },
}

export interface ImportOptions {
  dxf?: Partial<DxfOptions>
}

function extensionOf(filename: string): string {
  const i = filename.lastIndexOf('.')
  return i === -1 ? '' : filename.slice(i).toLowerCase()
}

export async function importFile(
  file: File,
  options: ImportOptions = {},
): Promise<ImportedScene> {
  const ext = extensionOf(file.name)

  const closed = CLOSED_FORMATS[ext]
  if (closed) {
    throw new ImportError(`${closed.name} files (${ext}) cannot be read directly.`, closed.advice)
  }

  switch (ext) {
    case '.dxf':
      return importDxf(await file.text(), file.name, options.dxf)
    case '.ifc':
      return importIfc(await file.arrayBuffer(), file.name)
    case '.dbacv':
      return importDbacvAsScene(await file.text(), file.name)
    case '.obj':
    case '.stl':
    case '.ply':
    case '.gltf':
    case '.glb':
    case '.fbx':
    case '.dae':
    case '.3ds':
      return importMesh(await file.arrayBuffer(), file.name, ext.slice(1) as never)
    default:
      throw new ImportError(
        `Unrecognised file type "${ext || file.name}".`,
        `Supported: ${ACCEPTED_EXTENSIONS.join(', ')}.`,
      )
  }
}
