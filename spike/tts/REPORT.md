# Spike: Edge TTS zh-TW 曉臻 -12%, 10-minute render, Mac and cloud (fisheraiagent#74)

Rerun the Mac numbers with one command: `cd spike/tts && npm ci && npm run mac` (needs Node >= 22, `uv`, network to the Edge TTS endpoint; it runs `run.mjs mac` then regenerates this file with `node report.mjs`). Cloud numbers come from the `spike-tts` workflow (re-run it with `workflow_dispatch` or push to this PR), then `node report.mjs` after downloading its artifact into `results/`.

Voice `zh-TW-HsiaoChenNeural`, rate `-12%`, output 24 kHz 48 kbit mono MP3. Fixture `fixture/episode-zh-tw.txt` (2735 chars). Wall s is the synthesis time inside the engine process (excludes `uv` start-up). Audio s is read with `mutagen`. Chars/min = input chars / audio minutes.

- **mac**: FisherdeMini darwin arm64 27.2.0; node v26.13.0; python edge-tts 7.3.1; generated 2026-11-26T17:57:29.739Z
- **gha**: github-actions Linux X64 7.0.0-1020-azure; node v22.23.5; python edge-tts 7.3.1; generated 2026-11-26T18:21:27.987Z; workflow run https://github.com/agentfleet-team/fisheraiagent/actions/runs/45872694482

## Results

| engine | place | run | wall s | status | bytes | audio s | chars/min | requests | boundary events (type) |
|---|---|---|---|---|---|---|---|---|---|
| python-edge-tts 7.3.1 | mac | 1 | 6.82 | ok | 3757392 | 626.23 | 262 | 2 | 68 (SentenceBoundary(default)) |
| python-edge-tts 7.3.1 | mac | 2 | 46.43 | ok | 3757392 | 626.23 | 262 | 2 | 68 (SentenceBoundary(default)) |
| python-edge-tts 7.3.1 | mac | 3 | 45.14 | ok | 3757392 | 626.23 | 262 | 2 | 68 (SentenceBoundary(default)) |
| python-edge-tts 7.3.1 | mac | 20k chars (20000) | 333.76 | ok | 27455328 | 4575.89 | 262 | 15 | 498 (SentenceBoundary(default)) |
| python-edge-tts 7.3.1 | gha | 1 | 117.16 | ok | 3757392 | 626.23 | 262 | 2 | 68 (SentenceBoundary(default)) |
| python-edge-tts 7.3.1 | gha | 2 | 5.19 | ok | 3757392 | 626.23 | 262 | 2 | 68 (SentenceBoundary(default)) |
| python-edge-tts 7.3.1 | gha | 3 | 5.53 | ok | 3757392 | 626.23 | 262 | 2 | 68 (SentenceBoundary(default)) |
| python-edge-tts 7.3.1 | gha | 20k chars (20000) | 271.4 | ok | 27455328 | 4575.89 | 262 | 15 | 498 (SentenceBoundary(default)) |
| node-msedge-tts 2.1.1 | mac | 1 | 41.6 | ok | 3756672 | 626.11 | 262 | 1 | 1459 (WordBoundary+SentenceBoundary) |
| node-msedge-tts 2.1.1 | mac | 2 | 110.46 | ok | 3756672 | 626.11 | 262 | 1 | 1459 (WordBoundary+SentenceBoundary) |
| node-msedge-tts 2.1.1 | mac | 3 | 91.53 | ok | 3756672 | 626.11 | 262 | 1 | 1459 (WordBoundary+SentenceBoundary) |
| node-msedge-tts 2.1.1 | mac | 20k chars (20000) | 600.38 | error | 20404800 | 3400.8 | 353 | 1 | 7930 (-) |
| node-msedge-tts 2.1.1 | gha | 1 | 119.64 | ok | 3756672 | 626.11 | 262 | 1 | 1459 (WordBoundary+SentenceBoundary) |
| node-msedge-tts 2.1.1 | gha | 2 | 29.39 | ok | 3756672 | 626.11 | 262 | 1 | 1459 (WordBoundary+SentenceBoundary) |
| node-msedge-tts 2.1.1 | gha | 3 | 8.26 | ok | 3756672 | 626.11 | 262 | 1 | 1459 (WordBoundary+SentenceBoundary) |
| node-msedge-tts 2.1.1 | gha | 20k chars (20000) | 570.43 | ok | 27445536 | 4574.26 | 262 | 1 | 10677 (WordBoundary+SentenceBoundary) |
| node-edge-tts-universal 1.4.0 | mac | 1 | 0.4 | error (exit 13) | 0 | 0 | - | 2 | 0 (WordBoundary) |
| node-edge-tts-universal 1.4.0 | mac | 2 | 0.36 | error (exit 13) | 0 | 0 | - | 2 | 0 (WordBoundary) |
| node-edge-tts-universal 1.4.0 | mac | 3 | 0.35 | error (exit 13) | 0 | 0 | - | 2 | 0 (WordBoundary) |
| node-edge-tts-universal 1.4.0 | mac | 20k chars (20000) | 0.36 | error (exit 13) | 0 | 0 | - | 15 | 0 (WordBoundary) |
| node-edge-tts-universal 1.4.0 | gha | 1 | 0.34 | error (exit 13) | 0 | 0 | - | 2 | 0 (WordBoundary) |
| node-edge-tts-universal 1.4.0 | gha | 2 | 0.29 | error (exit 13) | 0 | 0 | - | 2 | 0 (WordBoundary) |
| node-edge-tts-universal 1.4.0 | gha | 3 | 0.28 | error (exit 13) | 0 | 0 | - | 2 | 0 (WordBoundary) |
| node-edge-tts-universal 1.4.0 | gha | 20k chars (20000) | 0.33 | error (exit 13) | 0 | 0 | - | 15 | 0 (WordBoundary) |

## Errors seen

- node-msedge-tts / mac / long: `Error: Stream closed before the synthesis completed (no turn.end received). The audio is likely truncated.`
- node-edge-tts-universal / mac / episode: `event loop drained before the stream finished (library swallowed a websocket handshake error)`
- node-edge-tts-universal / mac / long: `event loop drained before the stream finished (library swallowed a websocket handshake error)`
- node-edge-tts-universal / gha / episode: `event loop drained before the stream finished (library swallowed a websocket handshake error)`
- node-edge-tts-universal / gha / long: `event loop drained before the stream finished (library swallowed a websocket handshake error)`

## 20,000-character behavior

| engine | place | outcome | audio s | expected audio s | audio / expected | boundary text chars / input chars | requests | wall s |
|---|---|---|---|---|---|---|---|---|
| python-edge-tts | mac | full output | 4575.89 | 4580 | 1.00 | 19745/20000 | 15 | 333.76 |
| python-edge-tts | gha | full output | 4575.89 | 4580 | 1.00 | 19745/20000 | 15 | 271.4 |
| node-msedge-tts | mac | partial audio then error: Error: Stream closed before the synthesis completed (no turn.end received). The audio is likely truncated. | 3400.8 | 4580 | 0.74 | 27849/20000 | 1 | 600.38 |
| node-msedge-tts | gha | full output | 4574.26 | 4580 | 1.00 | 37418/20000 | 1 | 570.43 |
| node-edge-tts-universal | mac | error: event loop drained before the stream finished (library swallowed a websocket handshake error) | 0 | 4580 | - | 0/20000 | 15 | 0.36 |
| node-edge-tts-universal | gha | error: event loop drained before the stream finished (library swallowed a websocket handshake error) | 0 | 4580 | - | 0/20000 | 15 | 0.33 |

Expected audio s = input chars / median chars-per-minute of all successful 10-minute-fixture runs. A ratio under 0.95 with status ok means silent truncation.

## Findings for RFC-4

Numbers below are computed from `results/*.json`.

- Characters for a 10-minute episode at -12%: about 2620 (median 262 chars/min over 12 successful runs; per engine: python-edge-tts 262, node-msedge-tts 262, node-edge-tts-universal -).
- Reliability, python-edge-tts: mac 3/3, gha 3/3 successful 10-minute runs; cloud median wall 5.53 s.
- Reliability, node-msedge-tts: mac 3/3, gha 3/3 successful 10-minute runs; cloud median wall 29.39 s.
- Reliability, node-edge-tts-universal: mac 0/3, gha 0/3 successful 10-minute runs.
- Timing stream, python-edge-tts: SentenceBoundary(default), median 68 events per episode.
- Timing stream, node-msedge-tts: WordBoundary+SentenceBoundary, median 1459 events per episode.
- Timing stream, node-edge-tts-universal: no successful run.
- Largest characters per request seen succeeding: python-edge-tts 1368, node-msedge-tts 2735, node-edge-tts-universal 0 (python and universal split at 4096 UTF-8 bytes, about 1365 CJK chars; msedge-tts does not split).

### Recommendation

- **Engine for tool 3 (TypeScript): `msedge-tts` 2.1.1, with our own chunking.** It worked 6/6 on 10-minute runs (3 Mac, 3 GitHub Actions) and yields about 1,459 word and sentence boundary events per episode, which gives time marks. It does not split text, so the tool must send chunks itself. Python `edge-tts` 7.3.1 is the reference and is also 6/6; it splits at 4,096 UTF-8 bytes (about 1,365 CJK chars) and gave 68 sentence-boundary events by default (it can emit word boundaries instead).
- **Do not use `edge-tts-universal` 1.4.0.** It fails 6/6 runs on both places: it sends `Sec-MS-GEC-Version=1-...` and the endpoint answers HTTP 403 (checked by hand with a raw websocket: version `2-...` opens, `1-...` gets 403). The library swallows the error and Node exits with code 13 and no message. Re-check after an upstream fix.
- **Max chars per request: 1,300.** This is a recommendation, not a measured limit. A single `msedge-tts` request of 2,735 chars worked 6/6, but a single 20,000-char request ran into a wall-clock cap of about 600 s per request: it failed on the Mac (stream closed without `turn.end`, 3,401 s of 4,580 s audio, silent for a caller that ignores the error) and passed on GitHub Actions only because it finished in 570 s. Python `edge-tts` handled 20,000 chars as 15 requests of at most 4,096 bytes on both places with full audio. Chunks near 1,300 chars (one request about 5 audio minutes) stay far from the cap and give a retry unit.
- **Script length:** about 2,600 chars for 10 minutes at -12% (262 chars per audio minute on both engines and both places; the result did not vary across 12 runs). Plan scripts of 2,500 to 2,700 chars.
- **Cloud (RFC-2):** the Edge endpoint accepted a GitHub Actions datacenter IP (no 403 for working libraries), 6/6 for the two working engines. One workflow run is a small sample, and wall time varied much (5 to 120 s for the same input), so the tool needs a timeout and retry. Wall time is 5 to 120 s for 10 audio minutes, so rendering is not the bottleneck.
- **Failure behavior at 20,000 chars:** python and msedge-tts on cloud: full audio. msedge-tts on Mac: error after 600 s with partial audio (the library raises; a caller must check). Nothing truncated silently.
