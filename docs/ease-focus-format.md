# The EASE Focus 3 project format (`.fc3`)

Everything known about the format, how it was established, and what is still open.
Companion to `docs/dbacv-format.md` and `docs/soundvision-format.md`; implemented in
`src/lib/easefocus/`.

**Provenance.** Reverse-engineered 2026-08-03 against **EASE Focus 3.1.260** (Windows,
AFMG). No published schema exists. Method: save a default project, decode it; then write
synthetic files from scratch, load them in the application, save them back, and diff.
The re-save is the oracle throughout — the application's own output after loading ours is
the proof of what it accepted.

## 1. Why this target exists

EASE Focus has **no geometry import**. The user guide offers manual coordinate entry
(including polar, for laser-and-inclinometer surveys) or a picture underlay to trace
over — there is no file-based route for venue geometry at all. Writing the project file
IS the import path. That also makes this exporter more useful than a converter that
merely re-serialises: ConverTool reads `.fc3` but refuses to write it.

## 2. Container

```
[7-bit varint: n] [n bytes: base64 of SOAP envelope #1]      .NET BinaryWriter string
[1 byte: 0x02]                                                block marker
[int32 LE: gzip length] [int32 LE: inflated length]
[gzip stream: SOAP envelope #2]
```

Envelope #1 (the header) is a serialised `Hashtable`: `EASEFocusVersion` (display
string), `EASEFocusProjectVersion` (`"3.0"`), `AdditionalS4Data59333950` (opaque bytes;
four zero bytes in a default project). Envelope #2 is the project: one flat `Hashtable`
of property-path keys to values — `Project.Title`,
`Project.AudienceZoneManager.Zone[0].Area[0].Z1`, and so on. Nothing is encrypted,
nothing is signed, and the gzip CRC is the only integrity check.

## 3. SOAP details that bite

- **Hash order.** The application serialises the `Hashtable` in hash order, which
  reshuffles between saves. A byte-exact round trip against the application is therefore
  IMPOSSIBLE, by design of the format, not by gap in this module — equality is asserted
  on the decoded key/value model. This is the one target of the three where the
  `theatre.dbacv` byte-for-byte standard cannot apply.
- **String interning.** `SoapFormatter` writes the first occurrence of a string inline
  with an `id` and every repeat as an `href` to it. A real default project has three of
  four zone `Type` values as hrefs. The reader resolves hrefs anywhere in the document;
  the writer reproduces the interning.
- **Guids are byte arrays.** Zone and area `Guid` values are base64 of .NET
  `Guid.ToByteArray()` — first three fields little-endian
  (`6456b104-ab86-43a3-9fbc-6d3c627c7703` ↔ `BLFWZIaro0OfvG08Ynx3Aw==`). The
  `MappingAudienceAreas[i].Guid` list refers to areas by the same guid **as text**.
  Write an area guid as text instead and the application silently regenerates it on
  load, which orphans every mapping entry — the file loads, the zones appear, and the
  Areas dropdown says "No Areas". Cost a probe cycle to find.

## 4. The venue model

No surfaces. A venue is **audience zones**: plan footprints with a height profile.

- `Zone[i].Type` — only `Rectangle` is written or read here. `Circular Sector` and
  `Annular Sector` exist in the application; nothing in a CAD reduction maps onto them.
- `Zone[i].X, .Y` — the zone **centre** in plan, metres.
- `Zone[i].Orientation` — degrees; `0°` = audience facing `−x` (the guide: "0 = facing
  left"), zone axis along `+x`, front edge at `x − depth/2`.
- `Zone[i].Width, .Depth` — across and along the axis.
- `Zone[i].Area[j]` — profile segments: `D1/D2` metres along the axis from the front
  edge, `Z1/Z2` heights. `Zone[i].ReferencePoint.Z` is a base offset; this writer keeps
  it 0 and writes absolute heights into the areas.
- `Project.MappingAudienceAreas[*]` — which areas are enabled for mapping; this writer
  lists every area, matching a project built by hand.

Anchor semantics were established with a screen ruler: the axis glyph in Top View sits at
the world origin, and zones written at known coordinates land centred on (X, Y) with `+y`
up. See §6.

### The 2 m minimum is on WIDTH, and it is applied silently

AFMG's documented limits are "2 m" and "45°". A real venue put the first one to the test:
`theatre.dbacv`'s 57 audience planes were exported, loaded, and saved back by the
application. **45 of the 57 zones came back at exactly 2 m wide**, having been written
narrower — centres unmoved, no dialog, no error, nothing in the UI to say it happened.
Depth under 2 m was **not** touched (zones 1.16–1.52 m deep survived exactly), and
orientation, X, Y, D2, Z1 and Z2 were byte-identical across all 57.

So the rule as the application actually implements it is: **width clamps up to 2 m about
the zone centre; depth does not clamp.** This matters because seating rows modelled
individually are routinely under 2 m wide — every one of them silently grows, and the
prediction then covers seats that are not in the room. The exporter does not clamp (the
file should still say what the room is) and warns naming width.

The 45° slope limit has not been probed and is documented-only.

## 5. Open questions

- **Orientation sign.** `0° = facing −x` is verified; whether positive degrees rotate
  counter-clockwise (assumed, mathematical convention) has not yet been pinned by a
  probe. A wrong sign mirrors angled zones about the x-axis and is a one-line fix in
  `convert.ts`/`easefocusScene.ts`.
- `Zone[i].ReferencePoint.DisplayCoordinatesRelativeToReference` and `EarHeightValue`
  are written with their default-project values; their semantics are untested.
- `.fc2` (EASE Focus 2) is a different, older container and is refused with advice to
  re-save in EASE Focus 3.
- The sector zone types are readable in principle but skipped with a warning.

## 6. Evidence log (all against 3.1.260, Parallels VM)

1. **Default save decoded** — container grammar, key inventory, `GlobalFilter` blob.
2. **Patched default re-loaded** — title and zone geometry edits appear in the UI;
   format is writable at all. (`[synth.fc3]` in the title bar, zone rendered.)
3. **From-scratch multi-zone file loaded and re-saved** — every zone's X/Y/Orientation/
   Width/Depth/D1/D2/Z1/Z2 came back exactly as written. The re-save is
   `test/fixtures/ruler_resaved.fc3`; the default save is `test/fixtures/default.fc3`.
4. **Screen ruler** — zones at (0,0) and (0,20) with the axis glyph at the origin:
   centre anchor, `+y` up, facing arrow `−x` at orientation 0.
5. **Guid encoding fix** — after switching area guids to byte arrays, the Areas
   dropdown reads "All Areas (2)" for a two-zone file where the string-guid version
   read "No Areas".
6. **A real venue, end to end** — `test/fixtures/theatre.dbacv` (a real ArrayCalc 12.8.2
   export) through the ordinary pipeline to 57 zones, loaded and re-saved by the
   application: 57 zones back, all 57 labels intact, every field identical except the
   width clamp above. The application also **re-sorts zones alphabetically by label** on
   save, so any comparison against its output has to match by label, not by index.

## 7. What the exporter does with a venue

Only **Listening** planes convert; everything else has no representation in EASE Focus
and is skipped with one summary warning. Each plane's outline (shared reduction,
`geom/outline.ts`) becomes one zone: axis along the slope (front at the low edge,
audience facing downslope), or for a flat plane the min-area rectangle's axis with the
front on the side nearest the venue origin. One profile segment per zone, front height
to back height. Holes are filled; outlines beyond the rectangle are lost. It is the
lossiest of the three targets because the format is the smallest of the three.
