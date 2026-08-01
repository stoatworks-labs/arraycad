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

### Quads need not be planar

**Observed, and important.** `STALLS - MAIN 1` is a `Shape=1` quad whose `P2` and `P3` sit
0.4 m higher than `P1` and `P4`. That is how ArrayCalc rakes a seating block. Any exporter
may therefore express a warped quad directly and does not need to split it into triangles.

### `Shape=2` is a rake, not a flat ring

The inner and outer ellipses each have their own semi-axes **and their own z**. On the
fixture's curved tiers `InnerZ` and `OuterZ` differ by the rise of the tier, so
interpolating z from inner to outer across the ring is what makes the seating raked.
Angles are degrees; `StartAngle` is measured from +X.

## 5. `PlaneType` — ⚠️ INFERRED

**These labels are not verified against ArrayCalc's UI.** They are deductions from the
names, colours and listener heights in one file. The app always shows the numeric code
next to the label so a wrong guess stays visible.

| Code | Inferred meaning | Evidence |
|---|---|---|
| 0 | none / group | Only ever on groups. |
| 1 | Audience | All the seating blocks; `ListenerHeight` 1.2 (seated) or 1.7 (standing, at the mix position). |
| 2 | Surface / obstacle | Ceilings, rails, lighting bridges; `ListenerHeight` 0.01. |
| 3 | **unknown** | Not present in the sample. |
| 4 | Stage | `STAGE`, `STAGE - FRONT`, the three `PROS -` objects. |
| 5 | Soundscape | Exactly one object, named `SOUNDSCAPE`, in ArrayCalc's En-Scene teal `#00C0AE`. |

`ListenerHeight` tracks the plane type closely enough that it is almost certainly derived
from it, so the app defaults it accordingly.

## 6. `ParentVenueObjectId` — derived, never stored

**Observed, and verified by round-trip.** There is no `id` attribute anywhere in the file.
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

## 9. What this project does NOT know

- The meaning of `PlaneType` 3, or whether the labels for 1/2/4/5 are what d&b calls them.
- Whether `Shape` 0 or 3 exist.
- Whether any other top-level section (loudspeaker systems, sources, positions) can appear
  inside `<ArrayCalc>` — the fixture is a venue-only export and contains just `<Project>`
  and `<Venue>`.
- How ArrayCalc reacts to a venue with several hundred objects, which is what a
  CAD conversion can easily produce.
- Whether group `Rotation`/`Scaling` compose the way this code assumes (§7).
