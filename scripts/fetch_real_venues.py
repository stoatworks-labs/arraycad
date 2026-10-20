#!/usr/bin/env python3
"""Download the real venues' published drawings that `src/lib/realVenues.test.ts` reads.

    python3 scripts/fetch_real_venues.py [--dir DIR]

The list, with each file's source and checksum, is `test/real-venues/venues.json`. The
files go to $ARRAYCAD_REAL_VENUES, or ~/.cache/arraycad-real-venues, one folder per venue —
never into this repository: they are the venues' own drawings, published for visiting
companies, and none of them carries a licence to redistribute it.

A file already present with the right checksum is left alone. A download whose checksum
does not match is kept beside the expected name as `.new` and reported, because a venue
re-issuing a drawing is news the test expectations may need, not a reason to fail quietly.
"""

import argparse
import hashlib
import json
import os
import sys
import urllib.request
from pathlib import Path

MANIFEST = Path(__file__).resolve().parent.parent / "test" / "real-venues" / "venues.json"
DEFAULT_DIR = Path(os.environ.get("ARRAYCAD_REAL_VENUES", Path.home() / ".cache" / "arraycad-real-venues"))
AGENT = "Mozilla/5.0 (ArrayCAD real-venue tests; https://github.com/stoatworks-labs/arraycad)"


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", type=Path, default=DEFAULT_DIR)
    args = ap.parse_args()

    manifest = json.loads(MANIFEST.read_text())
    problems = 0
    for venue in manifest["venues"]:
        folder = args.dir / venue["id"]
        folder.mkdir(parents=True, exist_ok=True)
        for f in venue["files"]:
            target = folder / f["name"]
            if target.exists() and sha256(target) == f["sha256"]:
                print(f"ok        {venue['id']}/{f['name']}")
                continue
            req = urllib.request.Request(f["url"], headers={"User-Agent": AGENT})
            try:
                with urllib.request.urlopen(req, timeout=300) as r:
                    data = r.read()
            except Exception as e:  # noqa: BLE001 - every failure is reported the same way
                print(f"FAILED    {venue['id']}/{f['name']}: {e}")
                problems += 1
                continue
            got = hashlib.sha256(data).hexdigest()
            if got == f["sha256"]:
                target.write_bytes(data)
                print(f"fetched   {venue['id']}/{f['name']} ({len(data):,} bytes)")
            else:
                Path(f"{target}.new").write_bytes(data)
                print(f"CHANGED   {venue['id']}/{f['name']}: the venue now serves a different file "
                      f"(sha256 {got[:12]}…), kept as {target.name}.new")
                problems += 1
    print(f"\n{args.dir}")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
