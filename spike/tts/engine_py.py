"""Edge TTS reference engine (python edge-tts). One synthesis, one JSON line on stdout.

usage: python engine_py.py <text-file> <out.mp3> [--repeat-to N]
"""
import asyncio
import json
import sys
import time
from importlib.metadata import version

import edge_tts

VOICE = "zh-TW-HsiaoChenNeural"
RATE = "-12%"


async def main() -> None:
    text = open(sys.argv[1], encoding="utf-8").read().strip()
    out = sys.argv[2]
    if "--repeat-to" in sys.argv:
        n = int(sys.argv[sys.argv.index("--repeat-to") + 1])
        text = (text + "\n")
        text = (text * (n // len(text) + 1))[:n]
    res = {
        "engine": "python-edge-tts",
        "engine_version": version("edge-tts"),
        "input_chars": len(text),
        "requests": None,
        "boundary_type": None,
        "boundary_events": 0,
        "boundary_text_chars": 0,
        "bytes": 0,
        "status": "ok",
        "error": "",
    }
    t0 = time.monotonic()
    try:
        c = edge_tts.Communicate(text, VOICE, rate=RATE)
        # The library builds a generator of <=4096-byte pieces; one websocket request per piece.
        c.texts = list(c.texts)
        res["requests"] = len(c.texts)
        res["boundary_type"] = getattr(c, "boundary", None) or "SentenceBoundary(default)"
        with open(out, "wb") as f:
            async for ch in c.stream():
                if ch["type"] == "audio":
                    f.write(ch["data"])
                    res["bytes"] += len(ch["data"])
                elif ch["type"] in ("WordBoundary", "SentenceBoundary"):
                    res["boundary_events"] += 1
                    res["boundary_text_chars"] += len(ch.get("text", ""))
    except Exception as e:  # record, do not hide
        res["status"] = "error"
        res["error"] = f"{type(e).__name__}: {e}"
    res["wall_s"] = round(time.monotonic() - t0, 2)
    print(json.dumps(res, ensure_ascii=False))


asyncio.run(main())
