#!/usr/bin/env python3
"""MAGI P0 experiment: can gemini-decision-1 play three MAGI personas that actually disagree?

Usage (see README.md):
    python run_p0.py --dry-run          # print one request body, no API call
    python run_p0.py --mock             # fake answers, to check the pipeline and report format
    python run_p0.py                    # real run, latest template (v3), Chinese
    python run_p0.py --template v1 --lang both   # the original v1 run

Only the Python standard library is used. Responses are cached in results/raw_<lang>[_<template>].jsonl,
so an interrupted run resumes where it stopped, and the report can be rebuilt offline
with --report-only.
"""

import argparse
import csv
import hashlib
import json
import os
import random
import statistics
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

import personas as P

ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/decisions"
MODEL = "gemini-decision-1"
HERE = Path(__file__).resolve().parent
RESULTS = HERE / "results"
W_VALUES = [1.0, 0.6, 0.3]          # weight of the vote probability in the blended score
THRESHOLD = 0.5                      # persona approves when its score >= THRESHOLD
CRITICAL_THRESHOLD = 0.9             # is_critical >= this -> special agenda (one-vote veto); set from the v3 run
GATES = {                            # suggested pass lines from the design doc
    "conflict_split": (">=", 0.40),
    "consensus_agree": (">=", 0.90),
    "consensus_final": (">=", 0.95),
    "direction_acc": (">=", 0.70),
    "max_corr": ("<=", 0.80),
    "flip_rate": ("<=", 0.15),
}

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass


# --------------------------------------------------------------------------- setup

def load_key() -> str:
    key = os.environ.get("GEMINI_API_KEY", "").strip()
    env = HERE / ".env"
    if not key and env.exists():
        for line in env.read_text(encoding="utf-8-sig").splitlines():
            line = line.strip()
            if line.startswith("GEMINI_API_KEY") and "=" in line:
                key = line.split("=", 1)[1].strip().strip('"').strip("'")
    if not key or key.startswith("在这里"):
        sys.exit("没有找到 API Key：请在 .env 文件里填写 GEMINI_API_KEY=你的key（见 README）。")
    return key


def load_cases():
    data = json.loads((HERE / "cases.json").read_text(encoding="utf-8"))
    return data["cases"]


def work_items(cases, limit, paraphrases):
    items = []
    base = cases[:limit] if limit else cases
    for c in base:
        items.append((c["id"], 0, c["text"]))
        if paraphrases:
            for i, t in enumerate(c.get("paraphrases", []), start=1):
                items.append((c["id"], i, t))
    return items


def build_body(text, lang, tpl):
    return {"model": MODEL, "input": P.build_input(text, lang, tpl), "questions": P.build_questions(lang, tpl)}


def raw_path_for(lang, tpl, mock):
    # v1 keeps its original file names so the first run's cache is reused.
    suffix = "" if tpl == "v1" else f"_{tpl}"
    return RESULTS / f"raw_{lang}{suffix}{'_mock' if mock else ''}.jsonl"


# --------------------------------------------------------------------------- API

class FatalAPIError(Exception):
    pass


def call_api(body, key, retries=5):
    data = json.dumps(body, ensure_ascii=False).encode("utf-8")
    delay = 2.0
    for attempt in range(retries + 1):
        req = urllib.request.Request(
            ENDPOINT, data=data, method="POST",
            headers={"x-goog-api-key": key, "Content-Type": "application/json"},
        )
        t0 = time.perf_counter()
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                payload = json.loads(r.read().decode("utf-8"))
            return payload, (time.perf_counter() - t0) * 1000
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", "replace")
            if e.code in (429, 500, 502, 503, 504) and attempt < retries:
                print(f"  HTTP {e.code}，{delay:.0f} 秒后重试…")
                time.sleep(delay)
                delay *= 2
                continue
            raise FatalAPIError(f"HTTP {e.code}\n{detail}")
        except urllib.error.URLError as e:
            if attempt < retries:
                print(f"  网络错误（{e.reason}），{delay:.0f} 秒后重试…")
                time.sleep(delay)
                delay *= 2
                continue
            raise FatalAPIError(f"网络错误：{e.reason}")
    raise FatalAPIError("重试次数用尽")


def mock_api(body, case_id, variant, lang, cases_by_id):
    """Deterministic fake answers shaped like the real API, for testing the pipeline."""
    seed = int(hashlib.md5(f"{case_id}-{variant}-{lang}".encode()).hexdigest()[:8], 16)
    rng = random.Random(seed)
    exp = cases_by_id[case_id]["expected"]
    answers = {}
    for i, k in enumerate(P.PERSONA_KEYS):
        e = exp[i]
        centre = 0.5 if e is None else (0.75 if e == 1 else 0.25)
        p = min(0.99, max(0.01, rng.gauss(centre, 0.18)))
        answers[f"{k}_vote"] = {"type": "noul", "noul": round(p, 3), "confidence": round(max(p, 1 - p), 3)}
        for sk in P.SUBSCORES[k]:
            s = min(4.0, max(0.0, rng.gauss(p * 4, 0.8)))
            answers[sk] = {"type": "score", "score": round(s, 2), "confidence": 0.6}
    for g in P.GLOBAL_KEYS:
        if g not in body["questions"]:
            continue
        if g == "is_critical":
            p = rng.uniform(0.6, 0.95) if cases_by_id[case_id].get("critical") else rng.uniform(0.01, 0.45)
        else:
            p = rng.uniform(0.6, 0.99) if g != "high_stakes" else rng.uniform(0.01, 0.4)
        answers[g] = {"type": "noul", "noul": round(p, 3), "confidence": round(max(p, 1 - p), 3)}
    n_tokens = 900 + len(body["input"]) * 2
    usage = {"total_input_tokens": n_tokens, "total_output_tokens": 0}
    return {"answers": answers, "usage": usage}, rng.uniform(150, 260)


# --------------------------------------------------------------------------- run

def run_lang(lang, tpl, items, key, args, cases_by_id):
    RESULTS.mkdir(exist_ok=True)
    raw_path = raw_path_for(lang, tpl, args.mock)
    done = set()
    if raw_path.exists() and not args.fresh:
        for line in raw_path.read_text(encoding="utf-8").splitlines():
            if line.strip():
                r = json.loads(line)
                done.add((r["case_id"], r["variant"]))
    elif raw_path.exists():
        raw_path.unlink()

    todo = [it for it in items if (it[0], it[1]) not in done]
    print(f"\n[{lang} / {tpl}] 共 {len(items)} 次请求，已缓存 {len(items) - len(todo)}，待执行 {len(todo)}")
    with raw_path.open("a", encoding="utf-8") as f:
        for n, (cid, var, text) in enumerate(todo, 1):
            body = build_body(text, lang, tpl)
            if args.mock:
                resp, ms = mock_api(body, cid, var, lang, cases_by_id)
            else:
                resp, ms = call_api(body, key)
                time.sleep(args.sleep)
            if "answers" not in resp:
                raise FatalAPIError("响应中没有 answers 字段：\n" + json.dumps(resp, ensure_ascii=False)[:2000])
            rec = {"case_id": cid, "variant": var, "lang": lang, "text": text,
                   "template": tpl, "latency_ms": round(ms, 1), "response": resp}
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
            f.flush()
            print(f"  {n:>3}/{len(todo)}  {cid} v{var}  {ms:.0f} ms")
    return raw_path


# --------------------------------------------------------------------------- analysis

def _num(a, *names):
    for n in names:
        v = a.get(n)
        if isinstance(v, (int, float)):
            return float(v)
    return None


def parse_record(rec, levels):
    ans = rec["response"].get("answers", {})
    out = {"p": {}, "conf": {}, "sub": {}, "glob": {}}
    for k in P.PERSONA_KEYS:
        a = ans.get(f"{k}_vote", {})
        p = _num(a, "noul", "probability")
        if p is None and isinstance(a.get("probabilities"), dict):
            p = _num(a["probabilities"], "true", "yes")
        if p is None:
            raise ValueError(f"{rec['case_id']}: 无法解析 {k}_vote 的概率：{json.dumps(a, ensure_ascii=False)}")
        out["p"][k] = p
        out["conf"][k] = _num(a, "confidence")
        subs = []
        for sk in P.SUBSCORES[k]:
            s = _num(ans.get(sk, {}), "score")
            if s is not None:
                subs.append(s / (levels[sk] - 1))
        out["sub"][k] = subs
    for g in P.GLOBAL_KEYS:
        out["glob"][g] = _num(ans.get(g, {}), "noul", "probability")
    usage = rec["response"].get("usage", {})
    out["tokens"] = usage.get("total_input_tokens") or usage.get("total_tokens")
    out["latency"] = rec.get("latency_ms")
    return out


def blended(parsed, w):
    s = {}
    for k in P.PERSONA_KEYS:
        subs = parsed["sub"][k]
        s[k] = parsed["p"][k] if (w >= 1.0 or not subs) else w * parsed["p"][k] + (1 - w) * sum(subs) / len(subs)
    return s


def votes_of(s):
    return [1 if s[k] >= THRESHOLD else 0 for k in P.PERSONA_KEYS]


def pearson(x, y):
    if len(x) < 3:
        return float("nan")
    mx, my = statistics.fmean(x), statistics.fmean(y)
    sx = sum((a - mx) ** 2 for a in x) ** 0.5
    sy = sum((b - my) ** 2 for b in y) ** 0.5
    if sx == 0 or sy == 0:
        return float("nan")
    return sum((a - mx) * (b - my) for a, b in zip(x, y)) / (sx * sy)


def analyse(raw_path, lang, cases, tpl):
    levels = P.score_levels(lang, tpl)
    by_key = {}
    for line in raw_path.read_text(encoding="utf-8").splitlines():
        if line.strip():
            rec = json.loads(line)
            by_key[(rec["case_id"], rec["variant"])] = parse_record(rec, levels)
    cases_by_id = {c["id"]: c for c in cases}
    base_ids = [c["id"] for c in cases if (c["id"], 0) in by_key]

    results = {}
    for w in W_VALUES:
        S = {cid: blended(by_key[(cid, 0)], w) for cid in base_ids}
        V = {cid: votes_of(S[cid]) for cid in base_ids}

        cons = [cid for cid in base_ids if cases_by_id[cid]["category"] == "consensus"]
        conf = [cid for cid in base_ids if cases_by_id[cid]["category"] == "conflict"]

        cons_ok = [all(v == cases_by_id[cid]["expected"][0] for v in V[cid]) for cid in cons]
        cons_final = [int(sum(V[cid]) >= 2) == cases_by_id[cid]["expected"][0] for cid in cons]
        split = [len(set(V[cid])) > 1 for cid in conf]

        pairs_ok = pairs_n = match_ok = match_n = 0
        for cid in conf:
            exp = cases_by_id[cid]["expected"]
            for i, ki in enumerate(P.PERSONA_KEYS):
                if exp[i] is None:
                    continue
                match_n += 1
                match_ok += int(V[cid][i] == exp[i])
                for j, kj in enumerate(P.PERSONA_KEYS):
                    if exp[j] is not None and exp[i] == 1 and exp[j] == 0:
                        pairs_n += 1
                        pairs_ok += int(S[cid][ki] > S[cid][kj])

        corrs = {}
        for a, b in (("melchior", "balthasar"), ("melchior", "casper"), ("balthasar", "casper")):
            corrs[f"{a[0].upper()}-{b[0].upper()}"] = pearson([S[c][a] for c in base_ids], [S[c][b] for c in base_ids])
        valid = [v for v in corrs.values() if v == v]
        max_corr = max(valid) if valid else float("nan")

        flips = flip_n = 0
        for cid in conf:
            base_final = int(sum(V[cid]) >= 2)
            var = 1
            while (cid, var) in by_key:
                f = int(sum(votes_of(blended(by_key[(cid, var)], w))) >= 2)
                flip_n += 1
                flips += int(f != base_final)
                var += 1

        pattern = {}
        for cid in base_ids:
            key = f"{sum(V[cid])}:{3 - sum(V[cid])}"
            pattern[key] = pattern.get(key, 0) + 1

        results[w] = {
            "consensus_agree": sum(cons_ok) / len(cons_ok) if cons_ok else float("nan"),
            "consensus_final": sum(cons_final) / len(cons_final) if cons_final else float("nan"),
            "conflict_split": sum(split) / len(split) if split else float("nan"),
            "direction_acc": pairs_ok / pairs_n if pairs_n else float("nan"),
            "vote_match": match_ok / match_n if match_n else float("nan"),
            "corrs": corrs,
            "max_corr": max_corr,
            "flip_rate": flips / flip_n if flip_n else float("nan"),
            "flip_n": flip_n,
            "pattern": pattern,
            "S": S, "V": V,
        }

    # Abstention: old rule (confidence < 0.6) vs a per-persona band calibrated so each persona
    # abstains on about 10% of cases. Votes do not change; only which ones count as "hold".
    base = [by_key[(cid, 0)] for cid in base_ids]
    abst = {}
    for k in P.PERSONA_KEYS:
        dist = sorted(abs(b["p"][k] - 0.5) for b in base)
        delta = dist[max(0, int(0.10 * len(dist)) - 1)] if dist else float("nan")
        abst[k] = {
            "old_rule": sum(1 for b in base if (b["conf"][k] if b["conf"][k] is not None else 1) < 0.6),
            "decisiveness": statistics.fmean(dist) if dist else float("nan"),
            "delta": delta,
            "calibrated": sum(1 for d in dist if d <= delta),
        }
    final_hold = sum(1 for b in base
                     if sum(abs(b["p"][k] - 0.5) <= abst[k]["delta"] for k in P.PERSONA_KEYS) >= 2)
    glob = {}
    for g in P.GLOBAL_KEYS:
        vals = [b["glob"][g] for b in base if b["glob"].get(g) is not None]
        if not vals:
            continue
        glob[g] = {
            "median": statistics.median(vals) if vals else float("nan"),
            "lt_0_5": sum(v < 0.5 for v in vals),
            "ge_0_8": sum(v >= 0.8 for v in vals),
        }

    # Special agenda (one-vote veto): detection quality and effect on the final verdict.
    critical = None
    if any(by_key[(cid, 0)]["glob"].get("is_critical") is not None for cid in base_ids):
        tp = fp = fn = 0
        flagged, vetoed = [], []
        V1 = results[1.0]["V"]
        for cid in base_ids:
            pc = by_key[(cid, 0)]["glob"].get("is_critical") or 0.0
            pred, gold = pc >= CRITICAL_THRESHOLD, bool(cases_by_id[cid].get("critical"))
            tp += pred and gold
            fp += pred and not gold
            fn += (not pred) and gold
            if pred:
                flagged.append((cid, pc, gold))
                majority = sum(V1[cid]) >= 2
                unanimous = sum(V1[cid]) == 3
                if majority and not unanimous:
                    vetoed.append(cid)
        critical = {
            "precision": tp / (tp + fp) if tp + fp else float("nan"),
            "recall": tp / (tp + fn) if tp + fn else float("nan"),
            "flagged": flagged, "vetoed": vetoed,
        }

    lat = [v["latency"] for v in by_key.values() if v["latency"] is not None]
    tok = [v["tokens"] for v in by_key.values() if v["tokens"] is not None]
    meta = {
        "n_requests": len(by_key),
        "n_base": len(base_ids),
        "latency_p50": statistics.median(lat) if lat else float("nan"),
        "tokens_mean": statistics.fmean(tok) if tok else float("nan"),
        "parsed": {cid: by_key[(cid, 0)] for cid in base_ids},
        "abst": abst,
        "final_hold": final_hold,
        "glob": glob,
        "critical": critical,
    }
    return results, meta


# --------------------------------------------------------------------------- report

def fmt(x, pct=False):
    if x != x:
        return "—"
    return f"{x * 100:.0f}%" if pct else f"{x:.2f}"


def gate_mark(name, value):
    op, line = GATES[name]
    if value != value:
        return "—"
    ok = value >= line if op == ">=" else value <= line
    return "通过" if ok else "未通过"


METRIC_ROWS = [
    ("冲突类分歧率", "conflict_split", True),
    ("共识类最终结论正确率", "consensus_final", True),
    ("共识类三台全票率（参考）", "consensus_agree", True),
    ("人格方向正确率", "direction_acc", True),
    ("三台概率最大相关系数", "max_corr", False),
    ("改写翻转率", "flip_rate", True),
]
LANG_NAME = {"zh": "中文", "en": "英文"}


def section(lang, tpl, results, meta, cases_by_id):
    L = [f"## 模板 {tpl} · 人格描述语言：{LANG_NAME[lang]}", ""]
    L.append(f"请求数 {meta['n_requests']}（基础案件 {meta['n_base']}）· 延迟 P50 {meta['latency_p50']:.0f} ms · "
             f"平均输入 {meta['tokens_mean']:.0f} tokens")
    L.append("")
    L.append("| 指标 | 通过线 | " + " | ".join(f"w = {w}" for w in W_VALUES) + " |")
    L.append("| --- | --- | " + " | ".join("---" for _ in W_VALUES) + " |")
    for label, k, pct in METRIC_ROWS:
        op, line = GATES[k]
        cells = [f"{fmt(results[w][k], pct)}（{gate_mark(k, results[w][k])}）" for w in W_VALUES]
        L.append(f"| {label} | {op} {fmt(line, pct)} | " + " | ".join(cells) + " |")
    L.append("| 冲突类单台投票与标注一致率 | 参考 | " + " | ".join(fmt(results[w]["vote_match"], True) for w in W_VALUES) + " |")
    L.append("")
    for w in W_VALUES:
        r = results[w]
        c = "，".join(f"{k} {fmt(v)}" for k, v in r["corrs"].items())
        pat = "，".join(f"{k} 共 {v} 例" for k, v in sorted(r["pattern"].items(), reverse=True))
        L.append(f"- w = {w}：相关系数 {c}；票型分布（承认:否决）{pat}")
    L.append("")

    L.append("### 保留规则与全局检查")
    L.append("")
    L.append("| 人格 | 果断度（\\|p − 0.5\\| 均值） | 旧规则保留数（confidence < 0.6） | 校准带宽 δ | 校准后保留数 |")
    L.append("| --- | --- | --- | --- | --- |")
    for k in P.PERSONA_KEYS:
        a = meta["abst"][k]
        L.append(f"| {P.PERSONA_NAMES[k]} | {fmt(a['decisiveness'])} | {a['old_rule']} | {fmt(a['delta'])} | {a['calibrated']} |")
    L.append("")
    L.append(f"按校准带宽，两台及以上保留时最终判“保留”：{meta['final_hold']} / {meta['n_base']} 例。")
    L.append("")
    L.append("| 全局问题 | 中位数 | < 0.5 的案件数 | ≥ 0.8 的案件数 |")
    L.append("| --- | --- | --- | --- |")
    for g, v in meta["glob"].items():
        L.append(f"| {g} | {fmt(v['median'])} | {v['lt_0_5']} | {v['ge_0_8']} |")
    L.append("")
    cr = meta.get("critical")
    if cr:
        L.append("### 特别议案（一票否决制）")
        L.append("")
        L.append(f"is_critical ≥ {CRITICAL_THRESHOLD} 判为特别议案：精确率 {fmt(cr['precision'], True)}，召回率 {fmt(cr['recall'], True)}"
                 f"（标注的特别议案共 {sum(1 for c in cases_by_id.values() if c.get('critical'))} 个）。")
        L.append("")
        if cr["flagged"]:
            L.append("| 案件 | is_critical | 标注为特别议案 | 内容 |")
            L.append("| --- | --- | --- | --- |")
            for cid, pc, gold in sorted(cr["flagged"], key=lambda x: -x[1]):
                t = cases_by_id[cid]["text"]
                L.append(f"| {cid} | {pc:.2f} | {'是' if gold else '否'} | {t[:36] + ('…' if len(t) > 36 else '')} |")
            L.append("")
        L.append(f"因一票否决由“可决”变为“否决”的案件：{'、'.join(cr['vetoed']) if cr['vetoed'] else '无'}。")
        L.append("")

    L.append("### 逐案结果（w = 1.0）")
    L.append("")
    L.append("| 案件 | 类别 | M | B | C | 票型 | 标注 | 特别议案 | 信息充足 | 案件内容 |")
    L.append("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |")
    r = results[1.0]
    for cid, parsed in meta["parsed"].items():
        c = cases_by_id[cid]
        p = parsed["p"]
        vote_s = "".join("承" if x else "否" for x in r["V"][cid])
        exp = "".join("承" if e == 1 else ("否" if e == 0 else "·") for e in c["expected"])
        dec, info = parsed["glob"].get("is_critical"), parsed["glob"].get("info_sufficient")
        text = c["text"] if len(c["text"]) <= 40 else c["text"][:40] + "…"
        L.append(f"| {cid} | {c['category']} | {p['melchior']:.2f} | {p['balthasar']:.2f} | {p['casper']:.2f} | "
                 f"{vote_s} | {exp} | {fmt(dec) if dec is not None else '—'} | {fmt(info) if info is not None else '—'} | {text} |")
    L.append("")
    return L


def comparison(entries):
    """Side-by-side key numbers (w = 1.0) for several (lang, tpl) runs."""
    L = ["## 版本对比（w = 1.0）", ""]
    heads = [f"{tpl} {LANG_NAME[lang]}" for (lang, tpl) in entries]
    L.append("| 指标 | 通过线 | " + " | ".join(heads) + " |")
    L.append("| --- | --- | " + " | ".join("---" for _ in heads) + " |")
    for label, k, pct in METRIC_ROWS:
        op, line = GATES[k]
        L.append(f"| {label} | {op} {fmt(line, pct)} | " +
                 " | ".join(fmt(res[1.0][k], pct) for (res, _) in entries.values()) + " |")
    extra = [
        ("M–B 相关", lambda res, meta: fmt(res[1.0]["corrs"]["M-B"])),
        ("CASPER 果断度", lambda res, meta: fmt(meta["abst"]["casper"]["decisiveness"])),
        ("CASPER 旧规则保留数", lambda res, meta: str(meta["abst"]["casper"]["old_rule"])),
        ("is_decidable 中位数", lambda res, meta: fmt(meta["glob"]["is_decidable"]["median"])),
        ("info_sufficient 中位数", lambda res, meta: fmt(meta["glob"]["info_sufficient"]["median"])),
    ]
    for label, f in extra:
        L.append(f"| {label} | 参考 | " + " | ".join(f(res, meta) for (res, meta) in entries.values()) + " |")
    L.append("")
    return L


def write_report(runs, compare, cases, mock, tpl):
    cases_by_id = {c["id"]: c for c in cases}
    L = ["# MAGI P0 验证结果" + ("（MOCK 假数据，仅用于检查流程）" if mock else ""), ""]
    L.append(f"生成时间：{time.strftime('%Y-%m-%d %H:%M')} · 单台承认阈值 θ = {THRESHOLD}")
    L.append("")
    L.append("w 是混合分中投票概率的权重：w = 1.0 只用投票概率；w 越小，子项评分占比越大。")
    L.append("")
    if len(compare) > 1:
        L += comparison(compare)
        L.append("对比表里的旧版本数字按当前 cases.json 的标注重新计算；新增的案件只有当前版本跑过。")
        L.append("")
    for (lang, t), (results, meta) in runs.items():
        L += section(lang, t, results, meta, cases_by_id)
    name = "report" if tpl == "v1" else f"report_{tpl}"
    out = RESULTS / f"{name}{'_mock' if mock else ''}.md"
    out.write_text("\n".join(L), encoding="utf-8")
    return out


def write_csv(lang, tpl, results, meta, cases, mock):
    cases_by_id = {c["id"]: c for c in cases}
    suffix = "" if tpl == "v1" else f"_{tpl}"
    out = RESULTS / f"cases_{lang}{suffix}{'_mock' if mock else ''}.csv"
    with out.open("w", newline="", encoding="utf-8-sig") as f:
        wr = csv.writer(f)
        wr.writerow(["id", "category", "text", "exp_M", "exp_B", "exp_C",
                     "p_M", "p_B", "p_C", "conf_M", "conf_B", "conf_C",
                     "sub_M", "sub_B", "sub_C", "is_decidable", "info_sufficient", "high_stakes", "is_critical",
                     "votes_w1.0", "latency_ms", "input_tokens"])
        for cid, x in meta["parsed"].items():
            c = cases_by_id[cid]
            sub = [round(sum(x["sub"][k]) / len(x["sub"][k]), 3) if x["sub"][k] else "" for k in P.PERSONA_KEYS]
            wr.writerow([cid, c["category"], c["text"], *[("" if e is None else e) for e in c["expected"]],
                         *[round(x["p"][k], 3) for k in P.PERSONA_KEYS],
                         *[x["conf"][k] for k in P.PERSONA_KEYS], *sub,
                         x["glob"].get("is_decidable"), x["glob"].get("info_sufficient"), x["glob"].get("high_stakes"),
                         x["glob"].get("is_critical"), "".join(map(str, results[1.0]["V"][cid])), x["latency"], x["tokens"]])
    return out


# --------------------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser(description="MAGI P0 persona-divergence experiment")
    ap.add_argument("--template", choices=sorted(P.TEMPLATES), default=P.DEFAULT_TEMPLATE, help="人格模板版本")
    ap.add_argument("--lang", choices=["zh", "en", "both"], default="zh")
    ap.add_argument("--limit", type=int, default=0, help="只跑前 N 个基础案件（用于快速试跑）")
    ap.add_argument("--no-paraphrase", action="store_true", help="不跑改写版本")
    ap.add_argument("--sleep", type=float, default=0.4, help="两次请求间隔秒数（免费层 200 次/分钟）")
    ap.add_argument("--dry-run", action="store_true", help="只打印第一个请求体，不调用 API")
    ap.add_argument("--mock", action="store_true", help="用假数据跑通流程")
    ap.add_argument("--fresh", action="store_true", help="忽略缓存，重新请求")
    ap.add_argument("--report-only", action="store_true", help="只用已缓存结果重新生成报告")
    args = ap.parse_args()

    tpl = args.template
    cases = load_cases()
    cases_by_id = {c["id"]: c for c in cases}
    langs = ["zh", "en"] if args.lang == "both" else [args.lang]
    langs = [l for l in langs if l in P.TEMPLATES[tpl]] or sys.exit(f"模板 {tpl} 没有所选语言的版本。")
    items = work_items(cases, args.limit, not args.no_paraphrase)

    if args.dry_run:
        print(json.dumps(build_body(items[0][2], langs[0], tpl), ensure_ascii=False, indent=2))
        print(f"\n共 {len(items)} 次请求 / 每种语言。")
        return

    key = None if (args.mock or args.report_only) else load_key()

    runs = {}
    for lang in langs:
        raw_path = raw_path_for(lang, tpl, args.mock)
        if not args.report_only:
            try:
                raw_path = run_lang(lang, tpl, items, key, args, cases_by_id)
            except FatalAPIError as e:
                print("\nAPI 返回错误，已停止。已完成的请求都保存在缓存里，修复后重跑会自动续上。")
                print(str(e)[:3000])
                print("\n如果看不懂这个错误，把上面整段发给 Claude。")
                sys.exit(1)
        if not raw_path.exists():
            sys.exit(f"没有找到缓存文件 {raw_path}，请先运行一次不带 --report-only 的命令。")
        results, meta = analyse(raw_path, lang, cases, tpl)
        runs[(lang, tpl)] = (results, meta)
        write_csv(lang, tpl, results, meta, cases, args.mock)

    # Compare with the v1 run of the same language when its cache exists.
    # Compare with earlier templates of the same language when their caches exist.
    # Their numbers are recomputed with the current cases.json labels.
    compare = {}
    for t in sorted(P.TEMPLATES):
        for lang in langs:
            if t == tpl or lang not in P.TEMPLATES[t]:
                continue
            path = raw_path_for(lang, t, args.mock)
            if path.exists():
                compare[(lang, t)] = analyse(path, lang, cases, t)
    compare.update(runs)

    report = write_report(runs, compare, cases, args.mock, tpl)
    print(f"\n完成。报告：{report}")
    for (lang, t), (results, meta) in runs.items():
        r = results[1.0]
        print(f"[{lang}/{t}] w=1.0  冲突类分歧率 {fmt(r['conflict_split'], True)}  共识类一致率 {fmt(r['consensus_agree'], True)}  "
              f"方向正确率 {fmt(r['direction_acc'], True)}  最大相关 {fmt(r['max_corr'])}  翻转率 {fmt(r['flip_rate'], True)}  "
              f"最终保留 {meta['final_hold']}/{meta['n_base']}")


if __name__ == "__main__":
    main()
