# fisheraiagent

Open-source AI agent tools by [AgentFleet](https://agentfleet.team/). Self-host them for free, or use them through AgentFleet.

> Status: the YouTube transcript CLI, HTTP job API, web page and Discord bot work. Hosted surfaces follow.

## Tools

| Tool | What it does | Status |
|---|---|---|
| YouTube transcript | One YouTube URL in, the full timed transcript out. Works for videos with or without captions. Use it from a web page, a Discord bot, or the command line. | CLI + HTTP API + Discord bot + web page ready |

## Self-host quick start (HTTP service)

One service, many callers: every client sends its own Gemini API key per request (`X-Gemini-Key` header), and jobs run in the background.

```bash
docker compose up -d          # serves on http://localhost:8080
npm run smoke                 # prints 200 for /healthz and 400 missing_key for a keyless POST
```

Open http://localhost:8080 in a browser for the web page: one box, one button, the transcript below. Open Settings (top right) to add your Gemini API key — it is kept only in your browser's localStorage and is sent to the service, as `X-Gemini-Key`, only when you submit a URL.

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
| `TENANTS_FILE` | no | — | Path to a JSON file of per-tenant save destinations (below). When unset, jobs still return transcripts; nothing is written to any destination. |
| `GOOGLE_APPLICATION_CREDENTIALS` | no | — | Path to a Google service-account key JSON, needed only when a tenant uses a `google-drive` destination. |

### Per-tenant destinations (Google Drive or NAS)

Each Discord server/channel can pick where its transcripts are saved. Adding a tenant is an edit to the tenants file — no code change, no restart (the file is read fresh on every job).

```json
{
  "tenants": [
    {
      "id": "family",
      "discord_guild_id": "111111111111111111",
      "caller": { "token_env": "SERVICE_TOKEN" },
      "destination": { "type": "google-drive", "folder_id": "0BabcYourFolderId", "extension": ".md" }
    },
    {
      "id": "team-channel",
      "discord_guild_id": "111111111111111111",
      "discord_channel_ids": ["222222222222222222"],
      "caller": { "token_sha256": "<hex sha256 of the caller's bearer token>" },
      "destination": { "type": "google-drive", "folder_id": "0CdefAnotherFolderId" }
    },
    {
      "id": "office-nas",
      "discord_guild_id": "111111111111111111",
      "caller": { "token_env": "SERVICE_TOKEN" },
      "destination": {
        "type": "webdav",
        "base_url": "https://nas.example.ts.net",
        "path": "/transcripts",
        "username": "transcripts",
        "password_env": "NAS_WEBDAV_PASSWORD",
        "extension": ".md"
      }
    }
  ]
}
```

- **Matching.** A job carries its `origin` (the Discord bot sends the guild and configured channel automatically). A tenant `id` is a lowercase slug (`a-z`, `0-9`, `-`, `_`). A tenant with `discord_channel_ids` claims only those channels; a tenant with just `discord_guild_id` claims every channel no channel entry took. First match wins; no match means nothing is saved.
- **Caller credential.** An origin in the request body is a claim, not proof: the service writes only when the caller's bearer token is the credential the resolved tenant names — `token_env` (an environment variable holding the token, for example the Discord bot's `SERVICE_TOKEN`) or `token_sha256` (the token's lowercase hex SHA-256). A claim that resolves to a tenant but fails the check saves nothing and reports the fixed `save_unauthorized` error; a tenant without `caller` cannot be claimed. Web callers are anonymous until sign-in lands: a web origin always shows the transcript only and saves nothing.
- **Destinations.** `"type": "google-drive"` writes into that `folder_id`; `"type": "webdav"` writes into `path` on a WebDAV server (a NAS); `"type": "none"` saves nothing. `extension` is `.txt` (default), `.md` or `.srt`.
- **Google Drive setup.** Create a service account in Google Cloud, download its key JSON, and set `GOOGLE_APPLICATION_CREDENTIALS` to the file's path. Then share each `folder_id` with the service account's `client_email` (right-click folder → Share → paste the email → Editor). The service account can only reach folders you share with it. Under `docker compose`, bind-mount both files into the container and point the variables at the in-container paths (e.g. `- ./tenants.json:/data/tenants.json:ro` with `TENANTS_FILE=/data/tenants.json`).
- **NAS (WebDAV) setup.** Enable the NAS's HTTPS WebDAV service (Synology: WebDAV Server package; Nextcloud: its WebDAV endpoint) and create a user for this service. `base_url` must be `https://` — plain HTTP is refused at config load. The file holds only `password_env`: the name of an environment variable that carries the password (e.g. `NAS_WEBDAV_PASSWORD`), never the password itself; set that variable where the api process runs (under `docker compose`, add it to the api service's `environment:`).
- **Reaching a home or office NAS from a hosted instance.** Put both machines on a mesh VPN such as [Tailscale](https://tailscale.com/): install Tailscale where the api container runs and on (or beside) the NAS, then use the NAS's tailnet HTTPS name as `base_url` — for example `https://nas.tail1234.ts.net` with Tailscale HTTPS certificates enabled. Never expose the NAS to the public internet: no port forwarding, no public IP listener. If the api runs on the same LAN as the NAS, use its LAN HTTPS address instead.
- **The file.** Name: `<english-slug>_<videoId>_<YYYYMMDD>.<ext>` — a lowercase slug of the video title, the video id and the capture date. Contents: a header with title, channel, source URL and capture date, then the timestamped transcript. On Drive the video id is also stored in `appProperties`; on WebDAV it is the `<videoId>` inside the file name. Either way, saving the same video again — another day, a renamed title — updates the existing file instead of making a duplicate, and two different videos can never overwrite each other even when their names collide.
- **Failures.** If the write fails (for example the folder is not shared with the service account, or the NAS rejects the login), the job still completes and returns the transcript, and the Discord reply or web result shows the save failure. The Discord bot replies with the file link (`Saved to Drive:`) or the saved path (`Saved to NAS:`) when the write succeeds.

The callers keep working exactly as before: the Discord reply gains a saved-file line, and the job result the web page reads gains a `saved.url` or `saved.path` field when a verified caller's job saves (plus a `save_error` on failure). See [openapi.yaml](openapi.yaml) for the `origin` and `saved` contract.

Notes:

- **Callers bring their own key.** `GEMINI_API_KEY` is not used by the service; each request's `X-Gemini-Key` lives in memory only for that job and is never logged, stored or returned.
- **Jobs are in-process.** The job store is memory only — a service restart loses every job (`GET /v1/jobs/{id}` then returns 404). The transcript cache on disk survives.
- The API is described in [openapi.yaml](openapi.yaml).

## Self-host the Discord bot

A plain Discord bot (no LLM inside it) as its own process. A user posts a YouTube URL in an enabled channel or thread, the bot forwards only the URL to the HTTP API above, and the transcript comes back in the same channel or thread: a short reply (video, language, length) with the transcript as `.txt` and `.srt` attachments. Each Discord server brings its own Gemini key.

### 1. Create the Discord application

1. In the [Discord Developer Portal](https://discord.com/developers/applications) create an application, then open **Bot** → **Add Bot** and copy the bot token (`DISCORD_TOKEN`).
2. On the same **Bot** page, under **Privileged Gateway Intents**, turn on **Message Content Intent**. (The bot also uses the standard Guilds and Guild Messages intents.)
3. Invite the bot: **OAuth2 → URL Generator**, scopes `bot` + `applications.commands`, bot permissions **View Channel**, **Send Messages**, **Send Messages in Threads**, **Attach Files**, **Add Reactions**, **Read Message History**. Open the generated URL and pick your server. The effective channel and thread permission overwrites where the bot is enabled must allow these too: it needs **Attach Files** to upload the transcripts and **Read Message History** plus **Add Reactions** for the progress reaction.

### 2. Run it

The `bot` compose service runs next to `api` and reaches it at `http://api:8080`:

```bash
export DISCORD_TOKEN=<bot token>
export BOT_ENCRYPTION_KEY=<any secret string>   # encrypts guild keys at rest
export SERVICE_TOKEN=<same token as the api service, if you set one>
docker compose up -d
```

Bot environment variables:

| Variable | Required | Default | What it does |
|---|---|---|---|
| `DISCORD_TOKEN` | yes | — | Bot token from the Developer Portal. |
| `BOT_ENCRYPTION_KEY` | yes | — | Secret that encrypts every guild's Gemini key at rest (AES-256-GCM). Losing it makes stored keys unreadable. |
| `API_BASE_URL` | no | `http://localhost:8080` | Where the bot reaches the HTTP API. Under compose it is `http://api:8080`. |
| `SERVICE_TOKEN` | no | — | Must match the API's `SERVICE_TOKEN` when the API requires one. |
| `BOT_DATA_FILE` | no | `./bot-data/bot-data.json` | Local JSON file holding per-guild settings (encrypted keys, enabled channels). Under compose it lives in the `bot-data` volume. |
| `BOT_POLL_INTERVAL_MS` | no | `2000` | How often the bot polls a job. |
| `BOT_JOB_TIMEOUT_MS` | no | `1800000` | How long the bot waits for a transcript before giving up. |

### 3. Set up a server

Slash commands (all replies are ephemeral, only members with **Manage Server** may run them):

| Command | What it does |
|---|---|
| `/transcript set-key key:<key>` | Save this server's Gemini API key (encrypted at rest). |
| `/transcript remove-key` | Delete this server's key. |
| `/transcript enable` | Enable the bot in the channel where you run it (covers its threads). |
| `/transcript disable` | Disable it there. |

Then post a YouTube URL in an enabled channel or thread: the bot adds an hourglass reaction, then replies in the same channel and thread with the transcript attachments. Messages elsewhere, or without a YouTube link, are ignored.

Notes:

- **Guild keys are encrypted at rest** and decrypted only in memory for the duration of one job; they are never logged. The bot sends only the video URL to the service — message text never leaves Discord.
- The API returns no video title, so the reply links the video id to its watch page and reports the covered length.

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

Error codes (stderr, non-zero exit): `invalid_url`, `video_unavailable`, `missing_key`, `key_rejected`, `quota_exceeded`, `upstream_timeout`, `upstream_rejected`, `model_not_found`, `bad_model_output`.

Develop: `npm test` runs the offline unit tests (no key, no network). `npm run test:web` runs the browser test (`npx playwright-core install chromium` once first). `.github/workflows/ci.yml` runs both on every push.

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
