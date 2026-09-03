import { describe, expect, it } from 'vitest'
import { JSDOM } from 'jsdom'
import { strToU8, zipSync } from 'fflate'
import { readMembers, readRootFile } from './container.ts'
import { parseMatrix, parseMvr } from './read.ts'
import { type MeshDecoder, buildMvrNodes, referencedFiles } from './scene.ts'
import { IDENTITY, ROOT_FILE, mul } from './types.ts'
import { flattenNodes } from '../import/types.ts'
import { categorise } from '../prepare/vocabulary.ts'
import { ImportError } from '../import/types.ts'

// Vitest runs in node here, so supply the browser's DOMParser explicitly.
const parser = new (new JSDOM().window.DOMParser)()
const parse = (xml: string) => parseMvr(xml, parser)

/**
 * Stub geometry "files" are JSON arrays of coordinates, so a test can say exactly which
 * triangles a file holds and assert on where they end up. The real decoder is three.js
 * and belongs to `import/mesh.ts`; everything this module does happens either side of it.
 */
const stubDecode: MeshDecoder = async (bytes, fileName) => {
  const positions = JSON.parse(new TextDecoder().decode(bytes)) as number[]
  return [
    {
      id: `stub:${fileName}`,
      name: fileName,
      tags: ['stub'],
      positions: new Float64Array(positions),
      children: [],
    },
  ]
}

/** A triangle at the origin, 1 unit on a side, for tracing a transform. */
const TRI = [0, 0, 0, 1, 0, 0, 0, 1, 0]

const geometryFile = (coords: number[] = TRI) => strToU8(JSON.stringify(coords))

function mvrXml(body: string, attrs = 'verMajor="1" verMinor="6" provider="Test" providerVersion="1"') {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<GeneralSceneDescription ${attrs}>${body}</GeneralSceneDescription>`
}

/** `Scene > Layers > Layer` with the given ChildList body. */
const oneLayer = (children: string, layerAttrs = 'uuid="L1" name="Stage"', layerMatrix = '') =>
  mvrXml(
    `<Scene><Layers><Layer ${layerAttrs}>${layerMatrix}<ChildList>${children}</ChildList></Layer></Layers></Scene>`,
  )

const matrix = (m: number[]) =>
  `<Matrix>{${m.slice(0, 3)}}{${m.slice(3, 6)}}{${m.slice(6, 9)}}{${m.slice(9, 12)}}</Matrix>`

/** Build the scene, run it through the stub decoder, and hand back the result. */
async function build(xml: string, files: Record<string, Uint8Array> = { 'a.3ds': geometryFile() }) {
  const scene = parse(xml)
  const map = new Map(Object.entries(files).map(([k, v]) => [k.toLowerCase(), v]))
  return buildMvrNodes(scene, { files: map, decode: stubDecode })
}

describe('MVR container', () => {
  it('reads the root file out of a DEFLATE archive', () => {
    const xml = oneLayer('')
    const zip = zipSync({ [ROOT_FILE]: strToU8(xml), 'tex.png': new Uint8Array(1000) })
    expect(readRootFile(zip)).toContain('GeneralSceneDescription')
  })

  it('reads the root file out of a STORE archive', () => {
    // The spec permits both, and exporters use both.
    const zip = zipSync({ [ROOT_FILE]: strToU8(oneLayer('')) }, { level: 0 })
    expect(readRootFile(zip)).toContain('GeneralSceneDescription')
  })

  it('refuses a zip with no GeneralSceneDescription.xml', () => {
    const zip = zipSync({ 'model.glb': new Uint8Array(4) })
    expect(() => readRootFile(zip)).toThrow(ImportError)
    expect(() => readRootFile(zip)).toThrow(/not an MVR/)
  })

  it('reads only the members asked for, keyed lower-case', () => {
    const zip = zipSync({
      [ROOT_FILE]: strToU8('<x/>'),
      'Geo1.3ds': geometryFile(),
      'Huge.gdtf': new Uint8Array(5000),
    })
    const got = readMembers(zip, ['Geo1.3ds'])
    expect([...got.keys()]).toEqual(['geo1.3ds'])
  })

  it('does not fail on a referenced file the archive does not hold', () => {
    const zip = zipSync({ [ROOT_FILE]: strToU8('<x/>') })
    expect(readMembers(zip, ['gone.3ds']).size).toBe(0)
  })
})

describe('MVR matrix parsing', () => {
  it('reads the spec\'s {u}{v}{w}{o} form', () => {
    const m = parseMatrix('{1,0,0}{0,1,0}{0,0,1}{10,20,30}')
    expect(m.o).toEqual([10, 20, 30])
    expect(m.u).toEqual([1, 0, 0])
  })

  it('reads floats in scientific notation and with negatives', () => {
    const m = parseMatrix('{-1.5,0,0}{0,2e2,0}{0,0,1}{-3.25,0,0}')
    expect(m.u[0]).toBe(-1.5)
    expect(m.v[1]).toBe(200)
    expect(m.o[0]).toBe(-3.25)
  })

  it('falls back to identity rather than half a matrix', () => {
    // A partial matrix would put the object somewhere specific and wrong; the identity at
    // least leaves it at the origin where it is visible.
    expect(parseMatrix('{1,0,0}{0,1,0}')).toEqual(IDENTITY)
    expect(parseMatrix('')).toEqual(IDENTITY)
    expect(parseMatrix(null)).toEqual(IDENTITY)
  })

  it('composes parent then child', () => {
    const translate = parseMatrix('{1,0,0}{0,1,0}{0,0,1}{10,0,0}')
    const scale = parseMatrix('{2,0,0}{0,2,0}{0,0,2}{0,0,0}')
    // Scaling inside a translation moves the child's own offset by the parent's basis.
    const m = mul(translate, scale)
    expect(m.u).toEqual([2, 0, 0])
    expect(m.o).toEqual([10, 0, 0])
  })
})

describe('MVR document', () => {
  it('reads the version and provider from the root element', () => {
    const s = parse(oneLayer(''))
    expect(s.version).toBe('1.6')
    expect(s.provider).toBe('Test')
  })

  it('rejects a document that is not an MVR', () => {
    expect(() => parse('<?xml version="1.0"?><ArrayCalc/>')).toThrow(/GeneralSceneDescription/)
  })

  it('recurses through nested ChildLists', () => {
    const s = parse(
      oneLayer(
        `<GroupObject uuid="g1" name="Set">
           <ChildList>
             <SceneObject uuid="o1" name="Deck"><Geometries/></SceneObject>
           </ChildList>
         </GroupObject>`,
      ),
    )
    expect(s.layers[0].children[0].type).toBe('GroupObject')
    expect(s.layers[0].children[0].children[0].name).toBe('Deck')
  })

  it('ignores node types that are not scene objects', () => {
    const s = parse(oneLayer('<NotAThing uuid="x"/><Truss uuid="t1" name="T"/>'))
    expect(s.layers[0].children.map((c) => c.type)).toEqual(['Truss'])
  })

  it('resolves Classing to the class name declared in AUXData', () => {
    const s = parse(
      mvrXml(
        `<Scene>
           <AUXData><Class uuid="C1" name="Audience"/></AUXData>
           <Layers><Layer uuid="L1" name="L"><ChildList>
             <SceneObject uuid="o1" name="Block"><Classing>C1</Classing></SceneObject>
           </ChildList></Layer></Layers>
         </Scene>`,
      ),
    )
    expect(s.layers[0].children[0].className).toBe('Audience')
  })
})

describe('MVR geometry placement', () => {
  it('places a triangle by the composed layer, group and object matrices', async () => {
    const xml = mvrXml(
      `<Scene><Layers><Layer uuid="L1" name="L">${matrix([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 100])}
         <ChildList>
           <GroupObject uuid="g1" name="G">${matrix([1, 0, 0, 0, 1, 0, 0, 0, 1, 10, 0, 0])}
             <ChildList>
               <SceneObject uuid="o1" name="Deck">${matrix([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 20, 0])}
                 <Geometries><Geometry3D fileName="a.3ds"/></Geometries>
               </SceneObject>
             </ChildList>
           </GroupObject>
         </ChildList></Layer></Layers></Scene>`,
    )
    const { nodes } = await build(xml)
    const deck = flattenNodes(nodes).find((n) => n.name === 'Deck')!
    // 10 + 20 + 100 applied on three separate axes: the first vertex is the sum.
    expect([...deck.positions.slice(0, 3)]).toEqual([10, 20, 100])
  })

  it('applies a scale on the Geometry3D itself', async () => {
    const xml = oneLayer(
      `<SceneObject uuid="o1" name="Deck"><Geometries>
         <Geometry3D fileName="a.3ds">${matrix([2, 0, 0, 0, 2, 0, 0, 0, 2, 0, 0, 0])}</Geometry3D>
       </Geometries></SceneObject>`,
    )
    const { nodes } = await build(xml)
    const deck = flattenNodes(nodes).find((n) => n.name === 'Deck')!
    expect([...deck.positions.slice(3, 6)]).toEqual([2, 0, 0])
  })

  it('takes an absent Matrix as the identity', async () => {
    const xml = oneLayer('<SceneObject uuid="o1" name="Deck"><Geometries><Geometry3D fileName="a.3ds"/></Geometries></SceneObject>')
    const { nodes } = await build(xml)
    const deck = flattenNodes(nodes).find((n) => n.name === 'Deck')!
    expect([...deck.positions.slice(0, 9)]).toEqual(TRI)
  })
})

describe('MVR symbols', () => {
  const symdefScene = (instances: string) =>
    mvrXml(
      `<Scene>
         <AUXData>
           <Symdef uuid="S1" name="Chair">
             <ChildList><Geometry3D fileName="a.3ds"/></ChildList>
           </Symdef>
         </AUXData>
         <Layers><Layer uuid="L1" name="L"><ChildList>${instances}</ChildList></Layer></Layers>
       </Scene>`,
    )

  it('instances one definition at two different places', async () => {
    const xml = symdefScene(
      `<SceneObject uuid="o1" name="A"><Geometries>
         <Symbol uuid="s1" symdef="S1">${matrix([1, 0, 0, 0, 1, 0, 0, 0, 1, 5, 0, 0])}</Symbol>
       </Geometries></SceneObject>
       <SceneObject uuid="o2" name="B"><Geometries>
         <Symbol uuid="s2" symdef="S1">${matrix([1, 0, 0, 0, 1, 0, 0, 0, 1, 50, 0, 0])}</Symbol>
       </Geometries></SceneObject>`,
    )
    const { nodes } = await build(xml)
    const flat = flattenNodes(nodes)
    expect(flat.find((n) => n.name === 'A')!.positions[0]).toBe(5)
    expect(flat.find((n) => n.name === 'B')!.positions[0]).toBe(50)
  })

  it('warns rather than hanging on a symbol definition that contains itself', async () => {
    const xml = mvrXml(
      `<Scene>
         <AUXData>
           <Symdef uuid="S1" name="Loop">
             <ChildList><Symbol uuid="s0" symdef="S1"/><Geometry3D fileName="a.3ds"/></ChildList>
           </Symdef>
         </AUXData>
         <Layers><Layer uuid="L1" name="L"><ChildList>
           <SceneObject uuid="o1" name="A"><Geometries><Symbol uuid="s1" symdef="S1"/></Geometries></SceneObject>
         </ChildList></Layer></Layers>
       </Scene>`,
    )
    const { nodes, warnings } = await build(xml)
    expect(warnings.some((w) => /contains itself/.test(w))).toBe(true)
    // The rest of the definition still arrives.
    expect(flattenNodes(nodes).find((n) => n.name === 'A')!.positions.length).toBe(9)
  })

  it('reports a symbol whose definition is missing', async () => {
    const xml = oneLayer(
      '<SceneObject uuid="o1" name="A"><Geometries><Symbol uuid="s1" symdef="NOPE"/></Geometries></SceneObject>',
    )
    const { warnings } = await build(xml)
    expect(warnings.some((w) => /not in the file/.test(w))).toBe(true)
  })

  it('collects only the files the scene reaches, through symdefs', () => {
    const scene = parse(
      symdefScene('<SceneObject uuid="o1" name="A"><Geometries><Symbol uuid="s1" symdef="S1"/></Geometries></SceneObject>'),
    )
    expect([...referencedFiles(scene)]).toEqual(['a.3ds'])
  })
})

describe('MVR units', () => {
  it('brings a 1 m glb and a 1000 mm 3ds in at the same size', async () => {
    const metre = [0, 0, 0, 1, 0, 0, 0, 1, 0]
    const millimetres = [0, 0, 0, 1000, 0, 0, 0, 1000, 0]
    const xml = oneLayer(
      `<SceneObject uuid="o1" name="FromGlb"><Geometries><Geometry3D fileName="a.glb"/></Geometries></SceneObject>
       <SceneObject uuid="o2" name="FromTds"><Geometries><Geometry3D fileName="b.3ds"/></Geometries></SceneObject>`,
    )
    const { nodes } = await build(xml, {
      'a.glb': geometryFile(metre),
      'b.3ds': geometryFile(millimetres),
    })
    const flat = flattenNodes(nodes)
    expect([...flat.find((n) => n.name === 'FromGlb')!.positions.slice(3, 6)]).toEqual([1000, 0, 0])
    expect([...flat.find((n) => n.name === 'FromTds')!.positions.slice(3, 6)]).toEqual([1000, 0, 0])
  })

  it('treats an extensionless fileName as 3ds, per the spec', async () => {
    const xml = oneLayer('<SceneObject uuid="o1" name="A"><Geometries><Geometry3D fileName="geo1"/></Geometries></SceneObject>')
    const { nodes, warnings } = await build(xml, { geo1: geometryFile([0, 0, 0, 1000, 0, 0, 0, 1000, 0]) })
    expect(flattenNodes(nodes)[1].positions[3]).toBe(1000)
    expect(warnings.filter((w) => /unsupported/i.test(w))).toHaveLength(0)
  })

  it('warns when the room comes out an implausible size', async () => {
    // 1 mm across: what a metres-vs-millimetres mix-up looks like from the outside.
    const xml = oneLayer('<SceneObject uuid="o1" name="A"><Geometries><Geometry3D fileName="a.3ds"/></Geometries></SceneObject>')
    const { warnings } = await build(xml, { 'a.3ds': geometryFile([0, 0, 0, 1, 0, 0, 0, 1, 0]) })
    expect(warnings.some((w) => /unlikely size/.test(w))).toBe(true)
  })

  it('says nothing about size for a room of ordinary dimensions', async () => {
    const xml = oneLayer('<SceneObject uuid="o1" name="A"><Geometries><Geometry3D fileName="a.3ds"/></Geometries></SceneObject>')
    const { warnings } = await build(xml, {
      'a.3ds': geometryFile([0, 0, 0, 20000, 0, 0, 0, 15000, 0]),
    })
    expect(warnings.some((w) => /unlikely size/.test(w))).toBe(false)
  })
})

describe('MVR tagging', () => {
  it('tags every node of a subtree with the MVR type, not just its root', async () => {
    // prepare/plan.ts judges each node alone, so a tag only on the wrapper would leave the
    // mesh under it unpruned.
    const xml = oneLayer(
      `<Truss uuid="t1" name="Sunstrip 12"><Geometries>
         <Geometry3D fileName="a.3ds"/><Geometry3D fileName="b.3ds"/>
       </Geometries></Truss>`,
    )
    const { nodes } = await build(xml, { 'a.3ds': geometryFile(), 'b.3ds': geometryFile() })
    const truss = flattenNodes(nodes).find((n) => n.name === 'Sunstrip 12')!
    expect(truss.children).toHaveLength(2)
    for (const c of truss.children) expect(c.tags).toContain('Truss')
  })

  it('makes a truss read as clutter even when its name says nothing', async () => {
    const xml = oneLayer('<Truss uuid="t1" name="Sunstrip 12"><Geometries><Geometry3D fileName="a.3ds"/></Geometries></Truss>')
    const { nodes } = await build(xml)
    const truss = flattenNodes(nodes).find((n) => n.name === 'Sunstrip 12')!
    expect(categorise(truss.name, truss.tags)).toBe('clutter')
  })

  it('translates MVR Support into the vocabulary\'s own word for it', async () => {
    const xml = oneLayer('<Support uuid="s1" name="GP1"><Geometries><Geometry3D fileName="a.3ds"/></Geometries></Support>')
    const { nodes } = await build(xml)
    const support = flattenNodes(nodes).find((n) => n.name === 'GP1')!
    expect(categorise(support.name, support.tags)).toBe('clutter')
  })

  it('leaves a video screen in — an LED wall is a reflector, not clutter', async () => {
    const xml = oneLayer('<VideoScreen uuid="v1" name="Upstage Wall"><Geometries><Geometry3D fileName="a.3ds"/></Geometries></VideoScreen>')
    const { nodes } = await build(xml)
    const screen = flattenNodes(nodes).find((n) => n.name === 'Upstage Wall')!
    expect(categorise(screen.name, screen.tags)).not.toBe('clutter')
  })

  it('carries the class name through as a tag', async () => {
    const xml = mvrXml(
      `<Scene>
         <AUXData><Class uuid="C1" name="Seating"/></AUXData>
         <Layers><Layer uuid="L1" name="L"><ChildList>
           <SceneObject uuid="o1" name="Block A"><Classing>C1</Classing>
             <Geometries><Geometry3D fileName="a.3ds"/></Geometries></SceneObject>
         </ChildList></Layer></Layers>
       </Scene>`,
    )
    const { nodes } = await build(xml)
    const block = flattenNodes(nodes).find((n) => n.name === 'Block A')!
    expect(block.tags).toContain('Seating')
    expect(categorise(block.name, block.tags)).toBe('seating')
  })
})

describe('MVR fixtures and gaps', () => {
  it('leaves out a fixture whose shape is only in its GDTF, and says how many', async () => {
    const xml = oneLayer(
      `<Fixture uuid="f1" name="Mac Aura"><GDTFSpec>Robe@MacAura.gdtf</GDTFSpec><Geometries/></Fixture>
       <Fixture uuid="f2" name="Mac Aura"><GDTFSpec>Robe@MacAura.gdtf</GDTFSpec><Geometries/></Fixture>
       <SceneObject uuid="o1" name="Deck"><Geometries><Geometry3D fileName="a.3ds"/></Geometries></SceneObject>`,
    )
    const { nodes, warnings, fixturesSkipped } = await build(xml)
    expect(fixturesSkipped).toBe(2)
    expect(warnings.some((w) => /2 lighting fixture/.test(w))).toBe(true)
    expect(flattenNodes(nodes).map((n) => n.name)).not.toContain('Mac Aura')
  })

  it('keeps a fixture that does carry its own placeholder geometry', async () => {
    const xml = oneLayer(
      '<Fixture uuid="f1" name="Mac Aura"><Geometries><Geometry3D fileName="a.3ds"/></Geometries></Fixture>',
    )
    const { nodes, fixturesSkipped } = await build(xml)
    expect(fixturesSkipped).toBe(0)
    const fixture = flattenNodes(nodes).find((n) => n.name === 'Mac Aura')!
    expect(categorise(fixture.name, fixture.tags)).toBe('clutter')
  })

  it('reports a referenced geometry file the archive does not hold', async () => {
    const xml = oneLayer(
      `<SceneObject uuid="o1" name="A"><Geometries><Geometry3D fileName="gone.3ds"/></Geometries></SceneObject>
       <SceneObject uuid="o2" name="B"><Geometries><Geometry3D fileName="a.3ds"/></Geometries></SceneObject>`,
    )
    const { nodes, warnings } = await build(xml)
    expect(warnings.some((w) => /gone\.3ds/.test(w))).toBe(true)
    // Losing one object is no reason to lose the venue.
    expect(flattenNodes(nodes).some((n) => n.name === 'B')).toBe(true)
  })

  it('reports geometry in a format MVR does not allow', async () => {
    const xml = oneLayer(
      '<SceneObject uuid="o1" name="A"><Geometries><Geometry3D fileName="model.obj"/></Geometries></SceneObject>',
    )
    const { warnings } = await build(xml, { 'model.obj': geometryFile() })
    expect(warnings.some((w) => /unsupported format/.test(w))).toBe(true)
  })

  it('drops a layer that ends up with nothing in it', async () => {
    const xml = oneLayer('<FocusPoint uuid="fp1" name="Focus 1"/>')
    const { nodes } = await build(xml)
    expect(nodes).toHaveLength(0)
  })
})
