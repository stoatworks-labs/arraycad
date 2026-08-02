#!/usr/bin/env python3
"""Write demo/demo-plan.pdf: a synthetic venue plan to trace.

The counterpart to make_demo_venue.py. That one produces a 3D model to reduce; this one
produces the other kind of source ArrayCAD accepts — a 2D drawing with no third dimension
at all, where every height is something the user types.

It is deliberately a hand-written vector PDF rather than an export of anything real:

* the theatre fixture is a real building and must not appear in a screenshot,
* vector line work exercises the operator-list path in trace/pdfPaths.ts, which a scanned
  page would not, and
* every dimension here is known exactly, so the calibration and the traced areas can be
  checked against a number rather than against an impression.

Drawn at 1:200 on A4 landscape, so "1:200" typed into the paper-scale box is the exact
right answer and can be checked against the 40.00 m dimension line.
"""

from __future__ import annotations

import math
from pathlib import Path

PT_PER_MM = 72.0 / 25.4
SCALE_DENOM = 200.0
# One metre of building, in page points, at 1:200.
M = (1000.0 / SCALE_DENOM) * PT_PER_MM

PAGE_W, PAGE_H = 842.0, 595.0
# Venue origin on the page: centre line, a little in from the left edge.
OX, OY = 215.0, PAGE_H / 2.0


def xy(x_m: float, y_m: float) -> tuple[float, float]:
    """Venue metres (x downstage-to-upstage, y left-right) -> page points."""
    return OX + x_m * M, OY + y_m * M


def poly(points: list[tuple[float, float]], close: bool = True) -> str:
    out = []
    for i, (x, y) in enumerate(points):
        px, py = xy(x, y)
        out.append(f"{px:.3f} {py:.3f} {'m' if i == 0 else 'l'}")
    if close:
        out.append("h")
    out.append("S")
    return "\n".join(out)


def text(s: str, x_m: float, y_m: float, size: float = 7.0) -> str:
    px, py = xy(x_m, y_m)
    esc = s.replace("\\", r"\\").replace("(", r"\(").replace(")", r"\)")
    return f"BT /F1 {size:.1f} Tf {px:.3f} {py:.3f} Td ({esc}) Tj ET"


def build_content() -> str:
    parts: list[str] = ["0 G", "0.8 w", "1 J", "1 j"]

    # Auditorium: a fan-shaped room 40 m long and 30 m wide at the back.
    parts.append(
        poly([(0, -9), (0, 9), (6, 11), (26, 15), (38, 15), (38, -15), (26, -15), (6, -11)])
    )

    # Stage, upstage of the setting line, with its own wall.
    parts.append(poly([(-12, -9), (-12, 9), (0, 9), (0, -9)]))
    parts.append(text("STAGE", -8.0, -0.5))

    # Orchestra pit: recessed, so tracing it is the negative-height case.
    parts.append(poly([(0.6, -6), (0.6, 6), (4.4, 6), (4.4, -6)]))
    parts.append(text("PIT", 2.0, -0.4, 5.5))

    # Stalls, raked. Two blocks either side of a centre aisle.
    for sign in (1, -1):
        parts.append(
            poly(
                [
                    (5.4, sign * 1.2),
                    (5.4, sign * 10.4),
                    (24.0, sign * 13.6),
                    (24.0, sign * 1.2),
                ]
            )
        )
    parts.append(text("STALLS", 13.0, -0.5))

    # No seat rows are drawn. A real plan has them, and they seal a flood fill inside the
    # first row — which is what hand tracing, the ink threshold and "thicken lines" are
    # there for. Leaving them out here keeps the demo about the tracer rather than about
    # tuning a detector.

    # Balcony over the back of the stalls, drawn as a dashed edge the way a plan would.
    parts.append("[4 3] 0 d")
    parts.append(poly([(25.0, -14.2), (25.0, 14.2), (37.2, 14.2), (37.2, -14.2)]))
    parts.append("[] 0 d")
    parts.append(text("BALCONY OVER", 29.0, -0.5))

    # Two columns in the stalls: enclosed voids, so region detect returns holes.
    for cy in (-7.5, 7.5):
        cx = 20.0
        ring = [
            (cx + 0.45 * math.cos(t), cy + 0.45 * math.sin(t))
            for t in [i * math.pi / 8 for i in range(16)]
        ]
        parts.append(poly(ring))

    # Mix position.
    parts.append(poly([(33.0, -2.4), (33.0, 2.4), (36.2, 2.4), (36.2, -2.4)]))
    parts.append(text("MIX", 34.0, -0.4, 5.5))

    # A dimension line across the room, so the scale can be set by measurement as well as
    # by paper scale, and the two answers can be compared.
    y = -17.5
    parts.append(poly([(0, y), (40, y)], close=False))
    for x in (0.0, 40.0):
        parts.append(poly([(x, y - 0.8), (x, y + 0.8)], close=False))
    parts.append(text("40.00 m", 18.0, y + 1.0))

    parts.append(text("SYNTHETIC VENUE - PLAN AT 1:200 - NOT A REAL BUILDING", 0.0, 17.0, 8.0))
    return "\n".join(parts)


def build_pdf(content: str) -> bytes:
    stream = content.encode("ascii")
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        (
            f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {PAGE_W:.0f} {PAGE_H:.0f}] "
            f"/Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>"
        ).encode("ascii"),
        b"<< /Length " + str(len(stream)).encode("ascii") + b" >>\nstream\n" + stream + b"\nendstream",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]

    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for i, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += f"{i} 0 obj\n".encode("ascii") + body + b"\nendobj\n"

    xref_at = len(out)
    out += f"xref\n0 {len(objects) + 1}\n".encode("ascii")
    out += b"0000000000 65535 f \n"
    for off in offsets:
        out += f"{off:010d} 00000 n \n".encode("ascii")
    out += (
        f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref_at}\n%%EOF\n"
    ).encode("ascii")
    return bytes(out)


def main() -> None:
    path = Path(__file__).resolve().parent.parent / "demo" / "demo-plan.pdf"
    path.parent.mkdir(exist_ok=True)
    path.write_bytes(build_pdf(build_content()))
    print(f"wrote {path} ({path.stat().st_size} bytes)")
    print(f"1:{SCALE_DENOM:.0f}  -> {M:.4f} page points per metre")


if __name__ == "__main__":
    main()
