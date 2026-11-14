"""Rebuild public/fonts/magi-display.woff2: Noto Serif JP Black (SIL OFL 1.1) subset to the
characters the MAGI page shows in its display font.

Needs:  npm install --no-save @fontsource/noto-serif-jp      (font source, OFL)
        pip install fonttools brotli
Usage (from magi-web/):  python scripts/build_font.py ["extra characters"]
"""
import re
import sys
from pathlib import Path

from fontTools import subset
from fontTools.merge import Merger
from fontTools.ttLib import TTFont

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "node_modules" / "@fontsource" / "noto-serif-jp"
OUT = ROOT / "public" / "fonts" / "magi-display.woff2"

TEXT = "提訴決議承認否定審議中保留特別案·・ " + "".join(chr(c) for c in range(0x21, 0x7F))
if len(sys.argv) > 1:
    TEXT += sys.argv[1]


def ranges(spec):
    cps = set()
    for part in spec.split(","):
        part = part.strip().replace("U+", "")
        if "-" in part:
            a, z = part.split("-")
            cps.update(range(int(a, 16), int(z, 16) + 1))
        else:
            cps.add(int(part, 16))
    return cps


css = (SRC / "900.css").read_text(encoding="utf-8")
need, parts = set(TEXT), []
for i, block in enumerate(re.findall(r"@font-face\s*{(.*?)}", css, re.S)):
    url = re.search(r"url\(\./files/([^)]+\.woff2)\)", block).group(1)
    cps = ranges(re.search(r"unicode-range:\s*([^;]+);", block).group(1))
    hit = {ch for ch in need if ord(ch) in cps}
    if not hit:
        continue
    need -= hit
    font = TTFont(SRC / "files" / url)
    opts = subset.Options()
    opts.layout_features = ["*"]
    opts.notdef_outline = True
    opts.name_IDs = ["*"]
    sub = subset.Subsetter(opts)
    sub.populate(text="".join(hit))
    sub.subset(font)
    font.flavor = None
    tmp = ROOT / f".font-part-{i}.ttf"
    font.save(tmp)
    parts.append(tmp)

if need:
    sys.exit(f"Characters not in Noto Serif JP: {''.join(sorted(need))}")
merged = Merger().merge([str(p) for p in parts])
merged.flavor = "woff2"
OUT.parent.mkdir(parents=True, exist_ok=True)
merged.save(OUT)
for p in parts:
    p.unlink()
print(f"{OUT.relative_to(ROOT)}: {OUT.stat().st_size} bytes, {len(merged.getGlyphOrder())} glyphs")
