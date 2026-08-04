/**
 * The `.fc3` container: framing, SOAP-serialised hashtables, and guids.
 *
 * A file is, in order:
 *
 *   1. a .NET `BinaryWriter` string — 7-bit varint byte length, then that many bytes —
 *      holding **base64 of a SOAP envelope**: a `Hashtable` with `EASEFocusVersion`,
 *      `EASEFocusProjectVersion` and an opaque `AdditionalS4Data…` byte array
 *   2. the byte `0x02`
 *   3. int32 LE: byte length of the gzip stream that follows
 *   4. int32 LE: byte length of that stream once inflated
 *   5. a gzip stream holding a second SOAP envelope — a `Hashtable` of string keys to
 *      values, keys being property paths (`Project.Title`,
 *      `Project.AudienceZoneManager.Zone[0].Area[0].Z1`, …)
 *
 * Nothing is encrypted and nothing is signed. The envelopes are what .NET's
 * `SoapFormatter` writes; the two behaviours of its that matter here are that identical
 * strings are INTERNED (first occurrence inline with an `id`, repeats as `href`), and
 * that `Guid` fields are byte arrays, not strings — Zone and Area guids are base64 of
 * .NET `Guid.ToByteArray()` (first three fields little-endian), while the
 * `MappingAudienceAreas` list refers to areas by the same guid as TEXT. Write an area
 * guid as text and EASE Focus silently regenerates it on load, orphaning every mapping
 * entry — that cost a probe cycle to find.
 */

import { gunzipSync, gzipSync, strFromU8, strToU8 } from 'fflate'

/** A hashtable value: a string, or a byte-array rendered as base64 (guids, blobs). */
export type SoapValue = string | { base64: string }

const SOAP_OPEN =
  '<SOAP-ENV:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ' +
  'xmlns:xsd="http://www.w3.org/2001/XMLSchema" ' +
  'xmlns:SOAP-ENC="http://schemas.xmlsoap.org/soap/encoding/" ' +
  'xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/" ' +
  'xmlns:clr="http://schemas.microsoft.com/soap/encoding/clr/1.0" ' +
  'SOAP-ENV:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">\n<SOAP-ENV:Body>\n'
const SOAP_CLOSE = '</SOAP-ENV:Body>\n</SOAP-ENV:Envelope>\n'

const escapeXml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const unescapeXml = (s: string) =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')

/**
 * Serialise pairs as a SoapFormatter Hashtable envelope.
 *
 * Order is preserved into the Keys/Values arrays; the deserialiser rebuilds by position,
 * so `LoadFactor`/`HashSize` only need to be plausible, not faithful.
 */
export function writeSoapHashtable(pairs: [string, SoapValue][]): string {
  const n = pairs.length
  const keyRef = (i: number) => 4 + i
  const valRef = (i: number) => 4 + n + i

  const keys: string[] = []
  const vals: string[] = []
  const extras: string[] = []
  // SoapFormatter interning, reproduced: repeats of a string become hrefs.
  const seen = new Map<string, number>()

  pairs.forEach(([k, v], i) => {
    keys.push(`<item id="ref-${keyRef(i)}" xsi:type="SOAP-ENC:string">${escapeXml(k)}</item>`)
    if (typeof v !== 'string') {
      vals.push(`<item href="#ref-${valRef(i)}"/>`)
      extras.push(`<SOAP-ENC:Array id="ref-${valRef(i)}" xsi:type="SOAP-ENC:base64">${v.base64}</SOAP-ENC:Array>`)
      return
    }
    const prior = seen.get(v)
    if (prior !== undefined) {
      vals.push(`<item href="#ref-${prior}"/>`)
      return
    }
    seen.set(v, valRef(i))
    vals.push(`<item id="ref-${valRef(i)}" xsi:type="SOAP-ENC:string">${escapeXml(v)}</item>`)
  })

  return (
    SOAP_OPEN +
    '<a1:Hashtable id="ref-1" xmlns:a1="http://schemas.microsoft.com/clr/ns/System.Collections">\n' +
    '<LoadFactor>0.72</LoadFactor>\n' +
    `<Version>${n}</Version>\n` +
    '<Comparer xsi:null="1"/>\n' +
    '<HashCodeProvider xsi:null="1"/>\n' +
    `<HashSize>${Math.max(11, 2 * n + 1)}</HashSize>\n` +
    '<Keys href="#ref-2"/>\n<Values href="#ref-3"/>\n</a1:Hashtable>\n' +
    `<SOAP-ENC:Array id="ref-2" SOAP-ENC:arrayType="xsd:anyType[${n}]">\n${keys.join('\n')}\n</SOAP-ENC:Array>\n` +
    `<SOAP-ENC:Array id="ref-3" SOAP-ENC:arrayType="xsd:anyType[${n}]">\n${vals.join('\n')}\n</SOAP-ENC:Array>\n` +
    (extras.length > 0 ? `${extras.join('\n')}\n` : '') +
    SOAP_CLOSE
  )
}

const ARRAY_RE = (ref: string) =>
  new RegExp(`<SOAP-ENC:Array id="${ref}"[^>]*>([\\s\\S]*?)</SOAP-ENC:Array>`)
const ITEM_RE = /<item(?:\s+id="(ref-\d+)")?(?:\s+xsi:type="[^"]*")?(?:\s+href="#(ref-\d+)")?\s*(?:\/>|>([\s\S]*?)<\/item>)/g

/**
 * Parse a SoapFormatter Hashtable envelope back to pairs.
 *
 * Resolves `href` items against every `id` in the document — string items AND base64
 * arrays — because a real file interns aggressively: in a default project three zone
 * `Type` values are hrefs to the fourth, and every guid is an href to a byte array.
 */
export function readSoapHashtable(xml: string): Map<string, SoapValue> {
  const byId = new Map<string, SoapValue>()
  for (const m of xml.matchAll(/<item\s+id="(ref-\d+)"[^>]*>([\s\S]*?)<\/item>/g)) {
    byId.set(m[1], unescapeXml(m[2]))
  }
  for (const m of xml.matchAll(/<SOAP-ENC:Array id="(ref-\d+)" xsi:type="SOAP-ENC:base64">([\s\S]*?)<\/SOAP-ENC:Array>/g)) {
    byId.set(m[1], { base64: m[2].trim() })
  }

  const readItems = (ref: string): SoapValue[] => {
    const body = ARRAY_RE(ref).exec(xml)?.[1] ?? ''
    const out: SoapValue[] = []
    for (const m of body.matchAll(ITEM_RE)) {
      if (m[2]) out.push(byId.get(m[2]) ?? '')
      else out.push(m[3] !== undefined ? unescapeXml(m[3]) : '')
    }
    return out
  }

  const keys = readItems('ref-2')
  const values = readItems('ref-3')
  const map = new Map<string, SoapValue>()
  keys.forEach((k, i) => {
    if (typeof k === 'string') map.set(k, values[i] ?? '')
  })
  return map
}

// ------------------------------------------------------------------ guids

/** Lowercase text form of a random guid, plus its .NET `Guid.ToByteArray()` base64. */
export function newGuid(): { text: string; base64: string } {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0'))
  const text = `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10).join('')}`
  // .NET layout: Data1..Data3 little-endian, Data4 as-is.
  const le = new Uint8Array([
    bytes[3], bytes[2], bytes[1], bytes[0],
    bytes[5], bytes[4],
    bytes[7], bytes[6],
    ...bytes.slice(8),
  ])
  return { text, base64: bytesToBase64(le) }
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

// ------------------------------------------------------------------ framing

function write7BitLength(n: number): number[] {
  const out: number[] = []
  do {
    let b = n & 0x7f
    n >>>= 7
    if (n > 0) b |= 0x80
    out.push(b)
  } while (n > 0)
  return out
}

function read7BitLength(bytes: Uint8Array, pos: number): { value: number; pos: number } {
  let value = 0
  let shift = 0
  for (;;) {
    const b = bytes[pos++]
    if (b === undefined) throw new Error('EASE Focus file: truncated length prefix.')
    value |= (b & 0x7f) << shift
    if ((b & 0x80) === 0) return { value, pos }
    shift += 7
  }
}

/** Frame header + payload envelopes into the bytes of a `.fc3` file. */
export function frameFc3(headerXml: string, payloadXml: string): Uint8Array {
  const headerB64 = strToU8(bytesToBase64(strToU8(headerXml)))
  const payload = strToU8(payloadXml)
  const gz = gzipSync(payload)

  const out = new Uint8Array(write7BitLength(headerB64.length).length + headerB64.length + 9 + gz.length)
  let pos = 0
  for (const b of write7BitLength(headerB64.length)) out[pos++] = b
  out.set(headerB64, pos)
  pos += headerB64.length
  out[pos++] = 0x02
  new DataView(out.buffer).setInt32(pos, gz.length, true)
  new DataView(out.buffer).setInt32(pos + 4, payload.length, true)
  pos += 8
  out.set(gz, pos)
  return out
}

/** Split a `.fc3` file back into its header and payload envelopes. */
export function unframeFc3(bytes: Uint8Array): { headerXml: string; payloadXml: string } {
  const head = read7BitLength(bytes, 0)
  const headerB64 = strFromU8(bytes.subarray(head.pos, head.pos + head.value))
  const headerXml = strFromU8(base64ToBytes(headerB64))

  let pos = head.pos + head.value
  if (bytes[pos] !== 0x02) {
    throw new Error(`EASE Focus file: expected block marker 0x02 at ${pos}, found ${bytes[pos]}.`)
  }
  pos += 1
  const view = new DataView(bytes.buffer, bytes.byteOffset)
  const gzLength = view.getInt32(pos, true)
  pos += 8 // the second int32 is the inflated length; gunzip discovers it itself
  const payloadXml = strFromU8(gunzipSync(bytes.subarray(pos, pos + gzLength)))
  return { headerXml, payloadXml }
}

/**
 * Does this look like an `.fc3`? The base64 of `<SOAP-ENV` is a fixed prefix
 * (`PFNPQVAtRU5W`), so its appearance right after a short varint is as good a magic
 * number as this container has.
 */
export function isEaseFocusFile(bytes: Uint8Array): boolean {
  const prefix = strFromU8(bytes.subarray(0, 24))
  return prefix.includes('PFNPQVAtRU5W')
}
