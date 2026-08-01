# The `.dbacv` venue file, reverse-engineered

Everything here was derived from a single real export, `test/fixtures/theatre.dbacv`,
written by **ArrayCalc 12.8.2** (`<Venue Version="9">`). There is no published schema.
Claims are marked as **observed** (seen in the file) or **inferred** (deduced, could be
wrong).

The reader and writer in `src/lib/dbacv/` reproduce that file **byte for byte**, which is
the strongest evidence available that the structural claims below are right. It says
nothing about whether the *semantic* claims — what `PlaneType 4` means — are right.

---

## 1. Container

**Observed.** Plain UTF-8 XML, LF line endings, trailing newline, 4-space indent.

```xml
<!DOCTYPE ArrayCalc>
<ArrayCalc Version="12.8.2">
    <Project Name="Untitled">
        <Date>01.08.2026</Date>
        <Author>allansargeant</Author>
        <Comments></Comments>
    </Project>
    <Venue Version="9">
        <Comments></Comments>
        <RoomObject …>…</RoomObject>
        …
    </Venue>
</ArrayCalc>
```

`<Date>` is `DD.MM.YYYY`. The two `Version` attributes are independent: the app version on
the root, the venue schema version on `<Venue>`.

Empty elements are written as an open/close pair (`<Comments></Comments>`), never
self-closed. Geometry elements are self-closed with **no space** before `/>`.

## 2. Number formatting

**Observed.** Every number is `printf("%.17g")` — 17 significant digits, trailing zeros
stripped, scientific notation outside `[1e-4, 1e17)`.

That is why the file is full of values like `5.4050000000000002` and
`-8.8817841970012523e-16`. Those are not precision bugs; they are the exact decimal
expansions of the nearest double. `g17()` in `write.ts` reproduces this, and the test
suite pins it against 19 literals taken from the fixture.

## 3. `<RoomObject>`

Attributes are written in **alphabetical order** (observed). The full set seen:

| Attribute | Type | Notes |
|---|---|---|
| `Name` | string | Free text. Groups get `RoomObjectGroup: {uuid}`. |
| `Shape` | int | Geometry kind — see §4. |
| `PlaneType` | int | What it is acoustically — see §5. |
| `ListenerHeight` | double | Metres. Can be the literal `nan` on groups. |
| `Enabled`, `Locked`, `Transparent` | `0`/`1` | |
| `ObjectGroup` | `true` | **Only on groups**, and it is the string `true`, not `1`. |
| `Color`, `PrintColor` | uint32 | ARGB packed. `PrintColor` is `4294945280` on every object in the fixture. |
| `OrderIndex` | int | ArrayCalc's display order, unrelated to document order. Groups sit at 101+. |
| `ParentVenueObjectId` | int | See §6. |
| `InnerRadiusA/B`, `OuterRadiusA/B`, `InnerZ`, `OuterZ`, `StartAngle`, `SpanAngle` | double | **Only on `Shape=2`**, all present or all absent. |

Child elements, in order: `Origin`, `Rotation`, `Scaling`, then `P1`…`Pn`, each
`<Tag x=".." y=".." z=".."/>`. `Rotation` is in degrees.

**Groups are the exception**: a group writes its children **first**, then its own
`Origin`/`Rotation`/`Scaling`. It has no `P` elements.

## 4. `Shape`

**Observed** codes. 0 and 3 were not present.

| Code | Meaning | Points |
|---|---|---|
| 1 | Quad | `P1`…`P4` |
| 2 | Elliptical annulus sector | none — attributes only |
| 4 | Box / prism | `P1`…`P8`: bottom quad, then top quad |
| 5 | Group | none |
| 6 | Triangle | `P1`…`P3` |

### ⚠️ The canonical quad — VERIFIED BY ROUND TRIP, and it is not optional

**A `Shape=1` quad must be written in ArrayCalc's own local frame.** This was confirmed
the hard way: a probe venue was written with quads whose origin was the centroid and whose
points were spread symmetrically around it — the obvious encoding, which round-trips
perfectly through this project's own reader. **ArrayCalc 12.8.2 imported every one of them
and collapsed it to zero depth.** A 4 × 3 m plane became a 3 m line. No error was shown.

The real form, matching all 26 quads in the reference venue and reproduced exactly by
`canonicalQuad()`:

```
origin    at the MIDPOINT OF THE NEAR EDGE, not the centroid
rotation  about Z only (no quad in the reference venue rotates about X or Y)

P1 = (0,      +wNear/2, 0)        P2 = (depth, +wFar/2, rise)
P4 = (0,      -wNear/2, 0)        P3 = (depth, -wFar/2, rise)
```

So a quad is a **symmetric trapezoid**: near and far edges both level and parallel, both
bisected by the local X axis, with the far edge free to sit at a different height.

| Property | Holds on all 26 reference quads |
|---|---|
| `P1.x == P4.x == 0` | ✅ |
| `P2.x == P3.x` (a single depth) | ✅ |
| `P1.y == -P4.y`, `P2.y == -P3.y` | ✅ |
| `P1.z == P4.z`, `P2.z == P3.z` | ✅ |
| `depth >= 0` | ✅ (6 of them exactly 0) |

**`depth` may be zero.** That is how ArrayCalc stores a **vertical** plane: every rail
front in the reference venue is a quad with `depth = 0` and a negative `rise`. So
horizontal, vertical and raked planes are all expressible.

**`rise` is what rakes seating.** `STALLS - MAIN 1` has its far edge 0.4 m higher than its
near edge — the quad is genuinely non-planar in the sense that it is not axis-aligned, but
it is still a valid ruled surface in this parameterisation.

What **cannot** be expressed: a sheared parallelogram, an asymmetric trapezoid, or a quad
with no level edge at all. Emit two **triangles** for those — `Shape=6` has no such
constraint and ArrayCalc returned every triangle in the probe byte-identical.

### `Shape=2` is a rake, not a flat ring

The inner and outer ellipses each have their own semi-axes **and their own z**. On the
fixture's curved tiers `InnerZ` and `OuterZ` differ by the rise of the tier, so
interpolating z from inner to outer across the ring is what makes the seating raked.
Angles are degrees; `StartAngle` is measured from +X.

## 5. `PlaneType` — partly verified

Two names now come from ArrayCalc itself. Importing a `PlaneType=5` quad that was not
rectangular produced this dialog:

> *"Positioning areas need to be rectangles, but plane 'A13 …' is not rectangular. Click
> 'Ok' to transform the plane or 'Cancel' to change the plane type to 'Listening'."*

So **`PlaneType 5` is a "Positioning area"** and one of the other types is called
**"Listening"** — almost certainly 1, which is the only type that keeps a custom
`ListenerHeight`.

| Code | Status | Meaning | Evidence |
|---|---|---|---|
| 0 | inferred | none / group | Only ever on groups. |
| 1 | **strongly supported** | **Listening** | All the seating blocks. The ONLY type that keeps a user-set `ListenerHeight` (see §5a). |
| 2 | inferred | Surface / obstacle | Ceilings, rails, bridges. `ListenerHeight` forced to 0.01. |
| 3 | **unknown** | — | Not present in any sample. Still untested. |
| 4 | inferred | Stage | `STAGE`, `STAGE - FRONT`, the three `PROS -` objects. `ListenerHeight` forced to 0.01. |
| 5 | **VERIFIED** | **Positioning area** | Named by ArrayCalc's own dialog. Must be a **rectangle**. En-Scene teal `#00C0AE`. |

### 5a. `ListenerHeight` is NOT simply derived — it depends on the plane type

**Verified by round trip.** A probe wrote deliberately wrong values and ArrayCalc's export
shows what it did with them:

| Sent | Returned | Conclusion |
|---|---|---|
| `PlaneType 1`, `ListenerHeight 0.77` | **`0.77`** | Kept. Type 1 has a user-settable listener height. |
| `PlaneType 2`, `ListenerHeight 1.55` | **`0.01`** | **Silently reset.** Type 2 forces 0.01. |

So write whatever height the user wants on type 1, and do not bother fighting types 2/4/5.

### 5b. `Color` is respected

ArrayCalc returned every colour exactly as written — it does not impose a palette per
plane type.

## 6. `ParentVenueObjectId` — derived, never stored

**VERIFIED by an ArrayCalc round trip.** A probe venue whose group sat at document index
14 came back with both its children still saying `ParentVenueObjectId="14"`.

There is no `id` attribute anywhere in the file.
`ParentVenueObjectId` is the parent's **1-based position in a depth-first walk of the
document**, and `0` at the top level.

Confirmed across all 112 objects in the fixture: the first group is document object 6 and
each of its five children says `ParentVenueObjectId="6"`; the next group is 12 and its
eleven children say `12`; and so on.

The practical consequence is the useful part: **the id is recomputed on every write**, so
deleting an object automatically renumbers everything after it. That is what makes pruning
safe, and it is tested.

## 7. Group transforms compose

**Inferred, with strong evidence.** Group `Origin` is not decoration — child coordinates
are relative to it.

- The `STAGE` group sits at `x=-4.8` and its `STAGE` child at another `-4.8`. Composed,
  the stage deck starts at `x=-9.6` — exactly where the `SOUNDSCAPE` plane starts.
- Two groups have an origin that cancels their first child to precisely `0`
  (`7.6594242016350362` + `-7.6594242016350362`).
- A third pair sums to exactly `2.25`.

Three independent clean numbers is not coincidence. Every group in the fixture has
`Rotation` 0 and `Scaling` 1, so rotation composition is **untested** — the code composes
rotations additively and scales multiplicatively, which is the obvious reading, but no
sample exercises it.

## 8. Venue coordinate system

**Inferred from the fixture's layout.** Metres, Z up, right-handed.

- **+X runs towards the audience.** Stage and Soundscape plane at `x=-9.6`, mix position
  at `x=+13.06`.
- **Y is left/right**, symmetric about 0 — every symmetric object in the venue spans
  `±y`.
- **Z is height**, with the stalls floor slightly negative (`-1.05`) and the top tier
  around `+10`.

There is no unit declaration in the file. Metres is inferred from the magnitudes being
right for a theatre and from ArrayCalc being a metric tool throughout.

## 8a. What an ArrayCalc round trip settled

A diagnostic venue (`scripts/make_probe_venue.py`) was opened in ArrayCalc 12.8.2, saved
and exported. Results:

| Question | Answer |
|---|---|
| Is `%.17g` the right number format? | **Yes.** `0.77000000000000002`, `1.4999999999999996`, `-135.00000000000017` all reproduced exactly. |
| Is `ParentVenueObjectId` depth-first document order? | **Yes.** |
| Does ArrayCalc keep our `Color`? | **Yes.** |
| Does it keep `ListenerHeight`? | **Only on PlaneType 1.** Type 2 is reset to 0.01. |
| Does it keep `OrderIndex`? | **No** — it renumbers freely. Treat ours as a hint. |
| Do triangles survive? | **Yes, byte-identical.** Centroid origin and all. |
| Do `Shape=4` boxes survive? | **Yes, byte-identical.** |
| Do `Shape=2` arcs survive? | **Yes, byte-identical.** |
| Do centroid-framed quads survive? | **NO — every one collapsed to zero depth.** See §4. |

Still open, pending a second probe: what `PlaneType 3` is, whether group **rotation** and
**scaling** compose onto children, and whether a group containing a single object survives.

## 9. What this project does NOT know

- The meaning of `PlaneType` 3.
- Whether the labels for 1, 2 and 4 are what d&b calls them. Only 5 ("Positioning area")
  and the existence of "Listening" come from ArrayCalc itself.
- Whether `Shape` 0 or 3 exist.
- Whether any other top-level section (loudspeaker systems, sources, positions) can appear
  inside `<ArrayCalc>` — the fixture is a venue-only export and contains just `<Project>`
  and `<Venue>`.
- How ArrayCalc reacts to a venue with several hundred objects, which is what a
  CAD conversion can easily produce.
- Whether group `Rotation`/`Scaling` compose the way this code assumes (§7). Group
  TRANSLATION survived a round trip untouched, but no sample or probe has yet exercised a
  rotated or scaled group.
