"""Regenerate src/personas.js from experiments/personas.py so the web app and the P0 experiment
always use identical persona wording.   Usage (from magi-web/):  python scripts/gen_personas.py [v3]
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "experiments"))
import personas as P  # noqa: E402

tpl = sys.argv[1] if len(sys.argv) > 1 else P.DEFAULT_TEMPLATE
q = P.build_questions("zh", tpl)
js = ("// Generated from experiments/personas.py (template %s, zh). Edit there and regenerate, so the web app\n"
      "// and the P0 experiment always use the same wording.\n" % tpl)
js += f"export const TEMPLATE = '{tpl}';\n"
js += "export const INPUT_PREFIX = " + json.dumps(P.TEMPLATES[tpl]["zh"]["input_prefix"], ensure_ascii=False) + ";\n"
js += "export const QUESTIONS = " + json.dumps(q, ensure_ascii=False, indent=2) + ";\n"
js += "export const SCORE_LEVELS = " + json.dumps(P.score_levels("zh", tpl), ensure_ascii=False) + ";\n"
(ROOT / "src" / "personas.js").write_text(js, encoding="utf-8")
print(f"src/personas.js <- template {tpl}, {len(q)} questions")
