# ArrayCAD user guide

ArrayCAD turns a CAD venue model into a d&b ArrayCalc venue file, or an L-Acoustics Soundvision
or AFMG EASE Focus 3 project, and converts between the three in any direction.

Drop in a DWG, DXF, glTF, IFC, OBJ or something similar. ArrayCAD merges the model's triangles
back into flat planes, lets you bin everything the prediction tool doesn't need, lets you say what
each surface *is* (listening, surface, stage) and writes the file.

It runs in the browser with no backend and no upload, so the file never leaves your machine.

![The venue after preparation, with the plane tree alongside](screenshots/arraycad.png)

> **Before you rely on this:** I've checked the geometry against the applications themselves
> rather than against a description of them. A `.dbacv` it writes reproduces a real ArrayCalc
> export **byte for byte** and has been round-tripped through ArrayCalc until every object came
> back untouched, a written Soundvision file was imported into Soundvision and read back surface
> by surface, and EASE Focus opened and saved a project of 57 audience planes with all 57 labels
> and every coordinate intact. 535 tests pin the reduction, and 38 more check it against four
> real venues' own published drawings.
>
> **What none of that proves is acoustic orientation.** No prediction has been run over an
> imported surface yet, and **a surface wound the wrong way lands right where it should and then
> silently returns no mapping result.** Check a mapping before you trust a whole design to it.
>
> This codebase was created with AI assistance, directed and reviewed by a human author.

---

## Three formats, and it converts between them

| | |
| --- | --- |
| **d&b ArrayCalc** | `.dbacv` |
| **L-Acoustics Soundvision** | *3D room data* `.txt` — the format its own SketchUp and Vectorworks plug-ins write |
| **AFMG EASE Focus 3** | `.fc3` |

All three open as well, so ArrayCAD converts between the three prediction tools: drop any one
in, write any other.

EASE Focus gets the most out of it. It has no geometry import at all (you type coordinates or
trace over a picture), so writing the project file is the only way in.

---

## Coming from a lighting visualiser

If the venue's already built in Capture, Depence, WYSIWYG, grandMA3 or Vectorworks, export
**MVR** from it and drop that in. MVR is the open interchange format they all share. Their own
project files are closed, and nothing else can read them.

An MVR is a whole show, so most of it is rig. ArrayCAD deals with that: truss, fixtures,
supports and projectors are recognised by their MVR type rather than their name, so the rig
prunes itself even when a truss is called `Sunstrip 12`. Video screens are kept on purpose,
because an LED wall is a big hard reflector and belongs in the prediction. Lighting fixtures
are left out entirely, for the same reason loudspeakers always have been: the prediction places
its own.

The format states millimetres and Z-up, so the units aren't a guess. Check the size against the
drawing anyway. The spec doesn't say what units the 3D models inside the archive use, and
ArrayCAD warns you if the room comes out an implausible size.

**Export .mvr** goes back the other way, so a room can come from a visualiser, get pruned and
simplified here, and go back. It's the only export that doesn't reduce: MVR carries glTF, which
wants the triangles the coplanar merge has already made, so the visualiser gets the *simplified*
room with nothing more lost. Plane types travel as MVR classes, so the audience areas can be
toggled as a set.

> Not yet confirmed in a visualiser: nobody has opened an ArrayCAD `.mvr` in Capture or Depence.
> Check the size after importing.

---

## Preparing a model on import

Most of the first ten minutes with a new file goes on work the drawing already describes. The
**Prepare** panel does it as the file opens, and every part of it is a decision you can see and
undo. Nothing is deleted: the objects it leaves out stay in the tree, ghosted in the view, one
click from coming back.

| | |
|---|---|
| **Leave out clutter** | Objects named as something other than a room surface: dimensions, text, lighting bars, truss, cable, ductwork, furniture, people — and modelled loudspeakers, since the prediction tools place their own. **Whole words only**, so `TEXTURED PANEL` stays and `TEXT` goes. |
| **Leave out tiny objects** | Brackets, fixings, trim and stray facets, under an area you set. **Seating is exempt** — a seat pan is 0.2 m². |
| **Split one-piece models** | A model that's one mesh (an OBJ, an STL, a media server's stock stage) has no names to work with, so it's read **by its shape**: rows of treads and risers become **rakes**, cut into as many sectors as it takes for each to fit one plane, and the rest becomes **Floor**, **Ceiling** and **Walls**. |
| **Flatten seating into audience planes** | Found by name, **by repetition** (hundreds of alike, small, upward-facing objects a metre apart are a bank of chairs whatever they are called) and **by shape**: every rake the split found. Tiers separated in height become separate planes. |
| **Guess plane types from names and shape** | `STAGE` becomes a stage; `WALL` and `CEILING` become surfaces. **An unnamed object that's all wall, or a ceiling over the room, becomes a surface too.** |
| **Re-cut heavy objects** | A meshed flat wall is hundreds of triangles describing one rectangle. Re-cutting from its own outline gives the same shape with a fraction of the triangles. **Anything not genuinely flat, or with a hole in it, is left alone.** |

The panel then tells you what it actually did to *your* model, with counts. On the demo venue
that's 3,206 triangles down to 1,322 and **116 ArrayCalc objects down to 52** before you've
touched anything. On the seat-by-seat plan it's **3,710 objects down to 17**, and on the
one-piece theatre (`demo/demo-onepiece.obj`) it's **439 down to 26.**

Untick a box and it re-runs from the file as imported. It reads the model once, when it opens,
using the units in force at that point, **so if the unit guess was wrong, fix it and re-run.**

> **Check the units even when the file states them.** A DWG or DXF says what units it's in, and
> it can be wrong. The National Taichung Theater's published plans say millimetres and are drawn
> in centimetres. When a drawing's rows of seats come out the wrong size for its stated units,
> ArrayCAD says so and suggests the units that would make them seats. It doesn't change them
> for you.
>
> A mesh format that doesn't say which way is up (OBJ, STL, PLY, 3DS) has it guessed from the way
> its largest surfaces face. Check the room is standing upright.

---

## Scans

A LiDAR or photogrammetry scan is a mesh in which **nothing is quite flat**: every triangle of a
scanned wall is tilted by the scanner's noise. The ordinary merge joins only triangles in exactly
the same plane, so on a scan it finds nothing, and loosened far enough to find the floor it takes
the ramp beside it in too.

A scan is read differently. ArrayCAD **measures the noise off the mesh** and grows each plane from
the flattest part of the surface, taking in whatever lies within that noise of it. Outlines are
smoothed at the scan's mesh size and squared off where a rectangle fits; holes under a square
metre (shadow the scanner never saw) are filled, a stair well isn't; a floor within the noise of
level is set exactly level, so it stays **one** ArrayCalc object.

It's decided as the file opens, from how the triangles meet. **Surfaces**, under *Simplification*,
says *Modelled* or *Scanned* and how much noise it measured; switching it re-runs preparation. A
synthetic 14 m hall with 8 mm of noise is **7 objects** read as a scan, and 6,273 read as a model.

> **The scans it's been tested on are synthetic**, made with known noise so the answer is known. A
> real scanner smooths, drifts and leaves holes, and everything in the room (chairs, people, the
> rig) is just more surface with no name to prune it by.

---

## Rationalising a seat-by-seat plan

An architect's model draws every seat. A sound designer wants the seating *area*.

Pick what to gather up, whichever way suits the drawing:

- **Select in the tree**: right when each seat or block is its own object, as in a glTF or IFC
  export.
- **Box select**: drag a rectangle in the 3D view.
- **Draw an area**: click the corners of the region. This is the one that matters for a DXF or
  DWG, where the whole house is usually on *one layer* and no amount of pruning in the tree will
  separate the stalls from the balcony.

Two settings decide most of the result:

- **Capture**: *Upward faces* (the default) keeps only surfaces pointing up, so a modelled seat
  reduces to its pan rather than dragging the plane down inside the seat. *All faces* is for a
  wall or a bare rake.
- **Outline**: *Follow* traces the seating and bridges gaps up to a distance you set. Set it to
  the row pitch and it joins seat to seat and row to row, and leaves an aisle wider than the
  pitch standing as an aisle. *Hull* is the convex hull, fine for a rectangular block and wrong
  for a horseshoe. *Rectangle* squares it off, which a Positioning area has to be.

> **Combine the tree and the drawing.** Select the seating layer first and then draw, and only the
> seating inside your outline is captured. **Draw with nothing selected and it takes everything
> under the polygon, including the floor beneath the seats, which fits the plane half a seat
> height too low.** The panel says which it's about to do.

**Read the numbers underneath.** Every area reports what the reduction cost, because "these four
hundred seats are one surface" is *your* assertion and not the geometry's.

---

## No 3D model? Trace one off the plan

Drop in a PDF or an image instead, set the scale, click inside a room to detect its outline, and
type a height at each corner.

**A DXF or DWG that's really a plan goes the same way.** A rig plot or a floor plan saved as
CAD has every line at height zero, and converted as a model it comes out with every surface lying
on the floor, ceiling included. When that's what's left once the clutter is out, the **Prepare**
panel says so and offers **Trace this plan**. The drawing states its own units, so it arrives at
the right scale with nothing to measure, and the room lands where the drawing puts it. Only the
layers left in are drawn, so a centreline or a lighting layer doesn't cut a room in two for the
wand. Turn a layer off in the tree first if you don't want it on the sheet: a reflected ceiling
plan drawn over the floor plan, say. A plan whose lines never close at all skips the question and
opens in the tracer straight away. **Back to the 3D import** in the Scale panel goes the other way.

Try it on [`demo/demo-rigplot.dxf`](../demo/demo-rigplot.dxf), a made-up ballroom rig plot.

---

## If something is wrong

| Symptom | Cause |
| --- | --- |
| **A mapping returns nothing, and the geometry looks right** | A surface is wound the wrong way. It lands in the right place and silently maps nothing — check a mapping early. |
| **Everything came in at the wrong scale** | The unit guess, or a drawing that states the wrong units (look for the warning about its seats). Fix it and re-run the import; it reads the model once, with the units in force then. |
| **The room is lying on its back** | The up-axis guess, on a format that doesn't state one. Switch Up axis and re-run. |
| **A scanned room came back as thousands of scraps** | It was read as a model. Set **Surfaces** to *Scanned*. |
| **A seating sector is cut where you wouldn't** | The split cuts a rake wherever one plane stops fitting it. It's an ordinary audience area in **Rationalise**: delete it, or untick **Split one-piece models** and draw your own. |
| **A seating plane sits half a seat too low** | The floor under the seats was captured. Select the seating layer before drawing. |
| **An aisle was swallowed** | The follow distance is wider than the aisle. Set it to the row pitch. |
| **A horseshoe came back as a block** | *Hull* outline. Use *Follow*. |
| **Something useful was left out** | Nothing is deleted — it is ghosted in the tree, one click from coming back. |
