# Spike: Edge TTS zh-TW 曉臻 -12%, 10-minute render, Mac and cloud (fisheraiagent#74)

Rerun the Mac numbers with one command: `cd spike/tts && npm ci && npm run mac` (needs Node >= 22, `uv`, network to the Edge TTS endpoint; it runs `run.mjs mac` then regenerates this file with `node report.mjs`). Cloud numbers come from the `spike-tts` workflow (re-run it with `workflow_dispatch` or push to this PR), then `node report.mjs` after downloading its artifact into `results/`.

Voice `zh-TW-HsiaoChenNeural`, rate `-12%`, output 24 kHz 48 kbit mono MP3. Fixture `fixture/episode-zh-tw.txt` (2735 chars). Wall s is the synthesis time inside the engine process (excludes `uv` start-up). Audio s is read with `mutagen`. Chars/min = input chars / audio minutes.

- **mac**: FisherdeMini darwin arm64 27.2.0; node v26.13.0; python edge-tts 7.3.1; generated 2026-11-26T17:57:29.739Z
- **gha**: no results file yet.

## Results

| engine | place | run | wall s | status | bytes | audio s | chars/min | requests | boundary events (type) |
|---|---|---|---|---|---|---|---|---|---|
| python-edge-tts 7.3.1 | mac | 1 | 6.82 | ok | 3757392 | 626.23 | 262 | 2 | 68 (SentenceBoundary(default)) |
| python-edge-tts 7.3.1 | mac | 2 | 46.43 | ok | 3757392 | 626.23 | 262 | 2 | 68 (SentenceBoundary(default)) |
| python-edge-tts 7.3.1 | mac | 3 | 45.14 | ok | 3757392 | 626.23 | 262 | 2 | 68 (SentenceBoundary(default)) |
| python-edge-tts 7.3.1 | mac | 20k chars (20000) | 333.76 | ok | 27455328 | 4575.89 | 262 | 15 | 498 (SentenceBoundary(default)) |
| node-msedge-tts 2.1.1 | mac | 1 | 41.6 | ok | 3756672 | 626.11 | 262 | 1 | 1459 (WordBoundary+SentenceBoundary) |
| node-msedge-tts 2.1.1 | mac | 2 | 110.46 | ok | 3756672 | 626.11 | 262 | 1 | 1459 (WordBoundary+SentenceBoundary) |
| node-msedge-tts 2.1.1 | mac | 3 | 91.53 | ok | 3756672 | 626.11 | 262 | 1 | 1459 (WordBoundary+SentenceBoundary) |
| node-msedge-tts 2.1.1 | mac | 20k chars (20000) | 600.38 | error | 20404800 | 3400.8 | 353 | 1 | 7930 (-) |
| node-edge-tts-universal 1.4.0 | mac | 1 | 0.4 | error (exit 13) | 0 | 0 | - | 2 | 0 (WordBoundary) |
| node-edge-tts-universal 1.4.0 | mac | 2 | 0.36 | error (exit 13) | 0 | 0 | - | 2 | 0 (WordBoundary) |
| node-edge-tts-universal 1.4.0 | mac | 3 | 0.35 | error (exit 13) | 0 | 0 | - | 2 | 0 (WordBoundary) |
| node-edge-tts-universal 1.4.0 | mac | 20k chars (20000) | 0.36 | error (exit 13) | 0 | 0 | - | 15 | 0 (WordBoundary) |

## Errors seen

- node-msedge-tts / mac / long: `Error: Stream closed before the synthesis completed (no turn.end received). The audio is likely truncated.`
- node-edge-tts-universal / mac / episode: `event loop drained before the stream finished (library swallowed a websocket handshake error)`
- node-edge-tts-universal / mac / long: `event loop drained before the stream finished (library swallowed a websocket handshake error)`

## 20,000-character behavior

| engine | place | outcome | audio s | expected audio s | audio / expected | boundary text chars / input chars | requests | wall s |
|---|---|---|---|---|---|---|---|---|
| python-edge-tts | mac | full output | 4575.89 | 4580 | 1.00 | 19745/20000 | 15 | 333.76 |
| node-msedge-tts | mac | partial audio then error: Error: Stream closed before the synthesis completed (no turn.end received). The audio is likely truncated. | 3400.8 | 4580 | 0.74 | 27849/20000 | 1 | 600.38 |
| node-edge-tts-universal | mac | error: event loop drained before the stream finished (library swallowed a websocket handshake error) | 0 | 4580 | - | 0/20000 | 15 | 0.36 |

Expected audio s = input chars / median chars-per-minute of all successful 10-minute-fixture runs. A ratio under 0.95 with status ok means silent truncation.

## Findings for RFC-4

Numbers below are computed from `results/*.json`.

- Characters for a 10-minute episode at -12%: about 2620 (median 262 chars/min over 6 successful runs; per engine: python-edge-tts 262, node-msedge-tts 262, node-edge-tts-universal -).
- Reliability, python-edge-tts: mac 3/3 successful 10-minute runs.
- Reliability, node-msedge-tts: mac 3/3 successful 10-minute runs.
- Reliability, node-edge-tts-universal: mac 0/3 successful 10-minute runs.
- Timing stream, python-edge-tts: SentenceBoundary(default), median 68 events per episode.
- Timing stream, node-msedge-tts: WordBoundary+SentenceBoundary, median 1459 events per episode.
- Timing stream, node-edge-tts-universal: no successful run.
- Largest characters per request seen succeeding: python-edge-tts 1368, node-msedge-tts 2735, node-edge-tts-universal 0 (python and universal split at 4096 UTF-8 bytes, about 1365 CJK chars; msedge-tts does not split).
