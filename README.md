# fisheraiagent

Open-source AI agent tools by [AgentFleet](https://agentfleet.team/). Self-host them for free, or use them through AgentFleet.

> Status: the YouTube transcript CLI and HTTP job API work. Web, Discord and hosted surfaces follow.

## Tools

| Tool | What it does | Status |
|---|---|---|
| YouTube transcript | One YouTube URL in, the full timed transcript out. Works for videos with or without captions. Use it from a web page, a Discord bot, or the command line. | CLI + HTTP API ready |

## Self-host quick start (HTTP service)

One service, many callers: every client sends its own Gemini API key per request (`X-Gemini-Key` header), and jobs run in the background.

```bash
docker compose up -d          # serves on http://localhost:8080
npm run smoke                 # prints 200 for /healthz and 400 missing_key for a keyless POST
```

Submit a job, then poll it:

```bash
curl -X POST http://localhost:8080/v1/jobs \
  -H 'content-type: application/json' \
  -H 'X-Gemini-Key: <your Gemini API key>' \
  -d '{"url": "https://youtu.be/hWe-j78vNpc"}'
# -> 202 {"job_id": "..."}

curl http://localhost:8080/v1/jobs/<job_id>
# -> {"job_id": "...", "status": "queued|running|done|failed",
#     "result"?: {<the same transcript JSON the CLI prints>},
#     "error"?: {"code": "...", "message": "..."}}
```

Service environment variables:

| Variable | Required | Default | What it does |
|---|---|---|---|
| `PORT` | no | `8080` | Port the service listens on (also the host port under `docker compose`). |
| `SERVICE_TOKEN` | no | — | When set, every `/v1` request needs `Authorization: Bearer <token>` (401 otherwise). `/healthz` stays open. |
| `GEMINI_MODEL` | no | `gemini-3.8-flash` | Gemini model used for transcription. |
| `MAX_BLOCK_SECONDS` | no | `8` | Maximum length of one transcript block, in seconds. |
| `CACHE_DIR` | no | `./transcript-cache` | Where transcripts are cached. Under `docker compose` this is the host directory bind-mounted to `/data/cache` in the container. |

Notes:

- **Callers bring their own key.** `GEMINI_API_KEY` is not used by the service; each request's `X-Gemini-Key` lives in memory only for that job and is never logged, stored or returned.
- **Jobs are in-process.** The job store is memory only — a service restart loses every job (`GET /v1/jobs/{id}` then returns 404). The transcript cache on disk survives.
- The API is described in [openapi.yaml](openapi.yaml).

## Self-host quick start (CLI)

One YouTube URL in, the full timed transcript out as JSON — for videos with or without captions. You bring your own Gemini API key; the video URL goes to Gemini as video input. Nothing is downloaded or stored but the transcript cache you choose.

```bash
export GEMINI_API_KEY=<your Gemini API key>
docker compose run --rm transcribe dist/cli.js https://youtu.be/hWe-j78vNpc
```

The transcript prints to stdout as JSON:

```json
{"video_id": "hWe-j78vNpc", "source_url": "https://www.youtube.com/watch?v=hWe-j78vNpc", "language": "en", "blocks": [{"start": 0, "end": 7.48, "text": "..."}]}
```

Environment variables:

| Variable | Required | Default | What it does |
|---|---|---|---|
| `GEMINI_API_KEY` | yes | — | Your Gemini API key. |
| `GEMINI_MODEL` | no | `gemini-3.8-flash` | Gemini model used for transcription. |
| `MAX_BLOCK_SECONDS` | no | `8` | Maximum length of one transcript block, in seconds. |
| `CACHE_DIR` | no | `./transcript-cache` | Where transcripts are cached. Under `docker compose` this is the host directory bind-mounted to `/data/cache` in the container. |

Without Docker, on Node 22 or newer:

```bash
npm ci
GEMINI_API_KEY=<your Gemini API key> npm start -- https://youtu.be/hWe-j78vNpc
```

Error codes (stderr, non-zero exit): `invalid_url`, `video_unavailable`, `missing_key`, `key_rejected`, `quota_exceeded`, `upstream_timeout`, `bad_model_output`.

Develop: `npm test` runs the offline unit tests (no key, no network). `.github/workflows/ci.yml` runs them on every push.

## How the YouTube transcript tool works

```text
 Web page (one box)     Discord bot (paste a URL)     CLI / any AI agent
          \                     |                         /
           +--------> one service (self-host or hosted) <-+
                         |
                         | your own Gemini API key (BYOK)
                         v
               Gemini reads the public YouTube URL
                         |
                         v
     transcript back to where you asked  +  saved where you chose
     (same page / same Discord thread)      (Google Drive, NAS, or nowhere)
```

- **Bring your own key.** Each user or Discord server sets their own Gemini API key. On the web, the key stays in your browser.
- **Your destination, your config.** Each user or Discord channel chooses where transcripts are saved. Adding a user is configuration, not code.
- **One program.** The same container runs on your own machine (`docker compose up`) or on our hosted instance.

## Limits (from Google)

Gemini reads public or unlisted YouTube videos only, one video per request. See [Gemini video understanding](https://ai.google.dev/gemini-api/docs/video-understanding).

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

---

**中文簡介**：AgentFleet 開源的 AI agent 工具。第一個工具：貼上 YouTube 網址，拿回完整逐字稿（有沒有字幕都可以）；可從網頁、Discord bot 或指令列使用，每位使用者用自己的 Gemini key、自己決定存放位置。可免費自架，也可使用 AgentFleet 代管服務。
