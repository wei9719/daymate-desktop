"""Opt-in real localhost diagnostics using only fixed synthetic contexts.

Does not load a model, start DayMate, read credentials, or save completions.
The independently started local service must already be ready.
"""

import argparse
import http.client
import json
from pathlib import Path
import re
import time
import unicodedata

from local_ai.runtime import MODEL_ID


# Rust str::trim uses Unicode White_Space, unlike Python's extra U+001C..001F.
RUST_WHITESPACE = " \t\n\r\v\f\x85\xa0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000"


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate output field")
        result[key] = value
    return result


def reject_constant(_):
    raise ValueError("Non-JSON numeric constant")


def validate_completion(name, result):
    """Check synthetic diagnostics against native parsers; never return the text."""
    if not isinstance(result, dict) or not isinstance(result.get("choices"), list) or not result["choices"]:
        raise ValueError("Missing completion")
    choice = result["choices"][0]
    if not isinstance(choice, dict) or choice.get("finish_reason") != "stop":
        raise ValueError("Incomplete completion")
    message = choice.get("message")
    if not isinstance(message, dict) or not isinstance(message.get("content"), str):
        raise ValueError("Missing text")
    if message.get("refusal") not in (None, ""):
        raise ValueError("Refused completion")
    content = message["content"].strip(RUST_WHITESPACE)
    if not content:
        raise ValueError("Empty completion")
    if name == "connection":
        if "连接成功" not in content:
            raise ValueError("Unexpected connection response")
        return
    music = name.startswith("music-")
    if not music and name != "encouragement":
        raise ValueError("Unknown diagnostic case")
    # Only parse_suggestion accepts fences; parse_encouragement rejects them.
    if music and content.startswith("```"):
        content = content[7:] if content.startswith("```json") else content[3:]
        content = content.strip(RUST_WHITESPACE)
        if not content.endswith("```"):
            raise ValueError("Incomplete output fence")
        content = content[:-3].strip(RUST_WHITESPACE)
    data = json.loads(content, object_pairs_hook=unique_object, parse_constant=reject_constant)
    expected = {"category", "reason"} if music else {"text"}
    if not isinstance(data, dict) or set(data) != expected:
        raise ValueError("Unexpected output fields")
    value = data["reason" if music else "text"]
    if not isinstance(value, str):
        raise ValueError("Output is not text")
    value = value.strip(RUST_WHITESPACE)
    if not value or len(value) > (80 if music else 100) or any(unicodedata.category(c) == "Cc" for c in value):
        raise ValueError("Output text violates native limits")
    if music:
        if data["category"] not in {"smart", "focus", "chinese", "classical", "ambient", "electronic"}:
            raise ValueError("Unknown music category")
    elif "<" in value or ">" in value or "://" in value:
        raise ValueError("Encouragement contains markup or a URL")


def prompts_from_source():
    source = (Path(__file__).resolve().parents[1] / "src-tauri/src/ai.rs").read_text(encoding="utf-8")
    prompts = re.findall(r'\{"role":"system","content":"([^"\n]+)"\}', source)
    music = [value for value in prompts if value.startswith("你是温和的音乐陪伴助手。")]
    encouragement = re.findall(r'const LOCAL_ENCOURAGEMENT_PROMPT: &str = r#"([^\n]+)"#;', source)
    if len(music) != 1 or len(encouragement) != 1:
        raise RuntimeError("Native prompt contract changed; update this diagnostic explicitly.")
    return music[0], encouragement[0]


def call(port, method, path, body=None):
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=120)
    try:
        payload = None if body is None else json.dumps(body, ensure_ascii=False).encode()
        connection.request(method, path, payload, {"X-DayMate-Local": "1", "Content-Type": "application/json"})
        response = connection.getresponse()
        raw = response.read(65537)
        if response.status != 200 or len(raw) > 65536:
            raise RuntimeError(f"Local response status/size failed ({response.status}).")
        return json.loads(raw)
    finally:
        connection.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    if not 1024 <= args.port <= 65535:
        parser.error("Invalid port")
    health = call(args.port, "GET", "/v1/health")
    if health.get("state") != "ready" or health.get("model") != MODEL_ID:
        raise RuntimeError("The expected local model is not ready.")
    music, encouragement = prompts_from_source()
    cases = [
        ("connection", None, "请只回复：连接成功"),
        ("music-focus", music, {"preferred_category": "focus", "intent": "match", "scene": "focus", "mood": "neutral", "hour": 10}),
        ("music-rest", music, {"preferred_category": "smart", "intent": "lift", "scene": "rest", "mood": "tense", "hour": 18}),
        ("music-start", music, {"preferred_category": "smart", "intent": "lift", "scene": "start", "mood": "low", "hour": 9}),
        ("encouragement", encouragement, {"scene": "start", "mood": "tired", "hour": 9, "tone": "gentle"}),
    ]
    for name, system, context in cases:
        messages = [] if system is None else [{"role": "system", "content": system}]
        messages.append({"role": "user", "content": context if isinstance(context, str) else json.dumps(context, ensure_ascii=False)})
        started = time.monotonic()
        body = {"model": MODEL_ID, "messages": messages, "max_tokens": 64 if system is None else 256, "temperature": 0 if system is None else 0.4}
        if system is not None:
            body["response_format"] = {"type": "json_object"}
        result = call(args.port, "POST", "/v1/chat/completions", body)
        validate_completion(name, result)
        print(json.dumps({"case": name, "passed": True, "seconds": round(time.monotonic() - started, 2), "completion_tokens": result.get("usage", {}).get("completion_tokens"), "device": health.get("device"), "synthetic_input": True}, ensure_ascii=False), flush=True)
    print("PASS: five actual local-model response contracts; not a music satisfaction or GUI test.", flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # Fixed diagnostics avoid printing model completions or server bodies.
        print(f"FAIL: local model diagnostic ({type(error).__name__}); no completion saved.", flush=True)
        raise SystemExit(1) from None
