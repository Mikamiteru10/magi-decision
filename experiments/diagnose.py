#!/usr/bin/env python3
"""Diagnose a 403 from the Gemini Decisions API. Prints no part of the key beyond its first 4 characters.

Runs three checks with the same key:
  1. list models             -> is the key/project allowed to use the Gemini API at all?
  2. a 5-token generateContent -> does an ordinary model call work?
  3. a 1-question Decisions call -> is the Decisions API open to this account?
"""
import json
import sys
import urllib.error
import urllib.request

from run_p0 import load_key

BASE = "https://generativelanguage.googleapis.com/v1beta"

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass


def req(method, url, key, body=None):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    r = urllib.request.Request(url, data=data, method=method,
                               headers={"x-goog-api-key": key, "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(r, timeout=30) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        txt = e.read().decode("utf-8", "replace")
        try:
            return e.code, json.loads(txt)
        except Exception:
            return e.code, {"raw": txt[:500]}
    except urllib.error.URLError as e:
        return None, {"network_error": str(e.reason)}


def msg(payload):
    err = payload.get("error", payload)
    return json.dumps(err, ensure_ascii=False)[:600]


def main():
    key = load_key()
    print(f"Key 检查：前 4 位 {key[:4]}，长度 {len(key)}，"
          f"{'含空白字符（有问题）' if any(c.isspace() for c in key) else '无空白字符'}")

    print("\n[1] 列出模型 …")
    code, data = req("GET", f"{BASE}/models?pageSize=1000", key)
    models = []
    if code == 200:
        models = data.get("models", [])
        names = [m.get("name", "") for m in models]
        print(f"    成功，共 {len(names)} 个模型；列表里{'有' if any('gemini-decision-1' in n for n in names) else '没有'} gemini-decision-1")
    else:
        print(f"    失败 HTTP {code}：{msg(data)}")

    print("\n[2] 普通生成调用（5 个 token）…")
    gen = next((m["name"] for m in models
                if "generateContent" in m.get("supportedGenerationMethods", []) and "flash" in m.get("name", "")), None)
    if not gen:
        print("    跳过：第 1 步没有拿到可用的生成模型")
    else:
        code, data = req("POST", f"{BASE}/{gen}:generateContent", key,
                         {"contents": [{"parts": [{"text": "Say OK"}]}], "generationConfig": {"maxOutputTokens": 5}})
        print(f"    {gen}：{'成功' if code == 200 else f'失败 HTTP {code}：{msg(data)}'}")

    print("\n[3] Decisions API（1 个问题）…")
    code, data = req("POST", f"{BASE}/decisions", key, {
        "model": "gemini-decision-1",
        "input": "This is a connectivity test.",
        "questions": {"is_test": {"type": "noul", "instructions": "Is this text a test?"}},
    })
    if code == 200:
        print("    成功：" + json.dumps(data.get("answers", data), ensure_ascii=False)[:300])
    else:
        print(f"    失败 HTTP {code}：{msg(data)}")

    print("\n把以上全部输出发给 Claude（里面不含你的完整 Key）。")


if __name__ == "__main__":
    main()
