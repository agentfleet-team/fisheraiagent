# fisheraiagent

Open-source AI agent tools by [AgentFleet](https://agentfleet.team/). Self-host them for free, or use them through AgentFleet.

> Status: the YouTube transcript CLI, HTTP job API, web page, Discord bot, optional web sign-in with per-tenant limits, and an AWS deployment recipe work.

## Tools

| Tool | What it does | Status |
|---|---|---|
| YouTube transcript | One YouTube URL in, the full timed transcript out. A manual caption track in the spoken language becomes the transcript with zero Gemini calls; every other video goes to Gemini. Use it from a web page, a Discord bot, or the command line. | CLI + HTTP API + Discord bot + web page ready |

## Self-host quick start (HTTP service)

One service, many callers: every client sends its own Gemini API key per request (`X-Gemini-Key` header) — or, when its tenant holds one, just its caller credential — and jobs run in the background.

```bash
docker compose up -d          # serves on http://localhost:8080
npm run smoke                 # prints 200 for /healthz and 400 missing_key for a keyless POST
```

Open http://localhost:8080 in a browser for the web page: one box, one button, the transcript below. Open Settings (top right) to add your Gemini API key — it is kept only in your browser's localStorage and is sent to the service, as `X-Gemini-Key`, only when you submit a URL. On Save the page also checks the key once against Gemini directly (`models.get` for the model this service runs, read from `GET /v1/config`; the key travels in the `x-goog-api-key` header to Google, never to this service) and reports whether the key was accepted, rejected, out of quota, or could not be checked.

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
| `WINDOW_SECONDS` | no | `120` | Length of one clipped transcription window, in seconds. Each window is a separate Gemini call with start and end offsets, so timestamps re-anchor per window. |
| `MAX_VIDEO_SECONDS` | no | `43200` | Length cap for a video whose tenant sets no `max_video_seconds`, in seconds; a tenant's own limit overrides it. A video known or discovered to be longer fails with `video_too_long`. The default is YouTube's documented 12-hour upload maximum. |
| `CACHE_DIR` | no | `./transcript-cache` | Where transcripts are cached. Under `docker compose` this is the host directory bind-mounted to `/data/cache` in the container. |
| `TENANTS_FILE` | no | — | Path to a JSON file of per-tenant save destinations (below). When unset, jobs still return transcripts; nothing is written to any destination. |
| `TENANTS_JSON` | no | — | The same tenants document inline (from a secrets manager, without a mounted file). `TENANTS_FILE` wins when both are set. |
| `GOOGLE_APPLICATION_CREDENTIALS` | no | — | Path to a Google service-account key JSON, needed only when a tenant uses a `google-drive` destination. |
| `GOOGLE_CREDENTIALS_JSON` | no | — | The same key JSON inline (from a secrets manager). `GOOGLE_APPLICATION_CREDENTIALS` wins when both are set. |
| `GOOGLE_OAUTH_JSON` | no | — | `{"client_id", "client_secret", "refresh_token"}` of a Google user's OAuth grant with the `drive` scope, inline. Files are created as that user, in that user's My Drive. Use it for a consumer gmail.com Drive: a service account has no storage quota and cannot create files there. Ignored when either service-account variable is set. A consent screen left in "Testing" status expires the refresh token after 7 days; set it to "In production". |
| `OIDC_CLIENT_ID` | no | — | OAuth client id for web sign-in (below). |
| `OIDC_CLIENT_SECRET` | no | — | OAuth client secret for web sign-in. |
| `OIDC_REDIRECT_URI` | no | — | This service's callback URL, `https://<host>/auth/callback`. |
| `OIDC_ISSUER` | no | `https://accounts.google.com` | The OpenID provider's issuer. |
| `SESSION_SECRET` | no | — | Any long random string; signs the session cookie. |
| `MAX_CONCURRENT_JOBS_PER_CLIENT` | no | `2` | In-flight jobs one client may hold at once (see "Per-client job limits"). |
| `MAX_JOBS_PER_HOUR_PER_CLIENT` | no | `20` | Accepted job submissions one client may make in a sliding hour. |
| `TRUSTED_PROXY_IPS` | no | `127.0.0.1,::1` | Peers allowed to supply the client IP via `CF-Connecting-IP` — the Cloudflare Tunnel connector's address, as a comma-separated list of IPs or IPv4 CIDRs. `none` disables header trust entirely. |
| `APP_VERSION` | no | `0.0.0-dev` | Build identity reported by `GET /v1/config` and shown in the page footer. The Docker build bakes it in via `--build-arg APP_VERSION` (see "Release checklist"). |
| `APP_COMMIT` | no | `unknown` | Commit the running image was built from, reported next to `APP_VERSION`; baked in via `--build-arg APP_COMMIT`. |

### Per-client job limits (anonymous surface)

When `SERVICE_TOKEN` is unset — the public page — `POST /v1/jobs` limits each client to `MAX_CONCURRENT_JOBS_PER_CLIENT` jobs in flight and `MAX_JOBS_PER_HOUR_PER_CLIENT` accepted submissions in a sliding hour; over either cap the reply is `429` `rate_limited`, which the page shows as a "too many jobs" message. `/healthz` and job polling are never limited.

A client is its source IP: `CF-Connecting-IP` when the request's own peer is listed in `TRUSTED_PROXY_IPS`, its socket address otherwise. Behind a Cloudflare Tunnel the connector (cloudflared) overwrites `CF-Connecting-IP` with the real client IP, so point `TRUSTED_PROXY_IPS` at the connector — the loopback default fits a connector running in the same task or host. A request that did not come through the tunnel can forge the header, so its value is trusted only from those peers; any other caller is counted on the address it connects from. Limits are in-process: a restart resets the counters. When `SERVICE_TOKEN` is set, authenticated callers are trusted infrastructure (the Discord bot, an MCP client) and are not limited.

### Web sign-in (optional, off by default)

When `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_REDIRECT_URI` and
`SESSION_SECRET` are all set, the page gains a **Sign in** link
(`/auth/login`) running the OpenID Connect authorization code flow with
PKCE against `OIDC_ISSUER` (Google by default). `/auth/login` also sets a
short-lived `af_login` cookie — HttpOnly, Secure, SameSite=Lax, HMAC-signed —
binding the pending login's state and PKCE verifier to the browser that
started it; the callback is rejected without it. A completed sign-in leaves
an `af_session` cookie — HttpOnly, Secure, SameSite=Lax, HMAC-signed — that
carries only the verified email. Setting only some of the four variables
fails startup; setting none keeps today's anonymous page, so self-hosters
are unaffected.

A signed-in user's email resolves to a tenant through that tenant's
`web_emails` allowlist — the session is the caller credential, so the job
saves to that tenant's destination and the page shows the link. An email on
no allowlist still gets its transcript plus a fixed "nothing was saved"
note. A signed-in job always lands in the session's own tenant: any tenant
the request itself claims is ignored.

### Per-tenant destinations (Google Drive or NAS)

Each Discord server/channel — and each allowlisted web sign-in — can pick where its transcripts are saved. Adding a tenant is an edit to the tenants file — no code change, no restart (the file is read fresh on every job).

```json
{
  "tenants": [
    {
      "id": "family",
      "discord_guild_id": "111111111111111111",
      "caller": { "token_env": "SERVICE_TOKEN" },
      "gemini_key_env": "FAMILY_GEMINI_KEY",
      "destination": { "type": "google-drive", "folder_id": "0BabcYourFolderId", "extension": ".md" }
    },
    {
      "id": "team-channel",
      "discord_guild_id": "111111111111111111",
      "discord_channel_ids": ["222222222222222222"],
      "caller": { "token_sha256": "<hex sha256 of the caller's bearer token>" },
      "discord_delivery": { "token_env": "FILE_DELIVERER_TOKEN" },
      "destination": { "type": "google-drive", "folder_id": "0CdefAnotherFolderId" }
    },
    {
      "id": "web-users",
      "web_emails": ["alice@example.com", "bob@example.com"],
      "destination": { "type": "google-drive", "folder_id": "0DghiThirdFolderId" },
      "limits": { "max_video_seconds": 3600, "jobs_per_hour": 10 }
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

- **Matching.** A job carries its `origin` (the Discord bot sends the guild and configured channel automatically; a signed-in web user's origin is the session's verified email). A tenant `id` is a lowercase slug (`a-z`, `0-9`, `-`, `_`). A tenant with `discord_channel_ids` claims only those channels; a tenant with just `discord_guild_id` claims every channel no channel entry took; a tenant with `web_emails` claims exactly those signed-in emails. First match wins; no match means nothing is saved.
- **Caller credential.** An origin in the request body is a claim, not proof: the service writes only when the caller's bearer token is the credential the resolved tenant names — `token_env` (an environment variable holding the token, for example the Discord bot's `SERVICE_TOKEN`) or `token_sha256` (the token's lowercase hex SHA-256). A claim that resolves to a tenant but fails the check saves nothing and reports the fixed `save_unauthorized` error; a tenant without `caller` cannot be claimed. For web users the verified sign-in session is the credential: a request's own `web` origin never resolves, and a session email matches a tenant only through `web_emails`.
- **Tenant-held Gemini key.** `gemini_key_env` names an environment variable that holds the tenant's own Gemini key (like `password_env`, the file names the variable — never the key). A `POST /v1/jobs` without `X-Gemini-Key`, from a caller whose bearer token passes that tenant's caller check, is transcribed with the tenant key; requests that send `X-Gemini-Key` are unchanged, and a failed caller check never falls back to the tenant key — it still gets `missing_key` or `save_unauthorized`. Web sign-in callers stay bring-your-own-key: a tenant resolved through `web_emails` never spends its `gemini_key_env`. The key is read per request, held only in memory for that job, and is never logged, stored or returned.
- **Discord delivery.** `discord_delivery.token_env` names an environment variable holding a dedicated file-deliverer bot token — the file names the variable, never the token, and a caller's bot never holds it. A verified caller of such a tenant may add `"deliver_to": "<channel or thread id>"` to `POST /v1/jobs`; after the job the service posts into that target with the deliverer bot: one summary bounded to Discord's 2000-character limit (source URL, language, covered length, the first transcript lines, the Drive link when saved) with the transcript attached in the tenant's destination extension (`.txt` by default), or one short line carrying the fixed error code for a failed job. The target counts only when Discord reports it — or a thread's parent channel — among the tenant's `discord_channel_ids` (in the tenant's guild when `discord_guild_id` is set); anything else is refused and nothing is posted. An unauthenticated `deliver_to`, or one on a tenant without `discord_delivery`, is ignored. The job view's `delivery` reports `sent` with the message id or `failed` with a fixed code (`delivery_refused`, `delivery_failed`, `invalid_config`) — the transcript and the Drive save are unaffected either way. The deliverer speaks only https to `discord.com` and never follows a redirect, so the token can travel nowhere else; it is never logged.
- **Limits.** `limits.jobs_per_hour` caps accepted submissions in a sliding hour (a `429` `rate_limited` reply); `limits.max_video_seconds` rejects longer videos with `video_too_long` — before any Gemini call when the length is already known locally (the transcript cache), otherwise on the first model response, which declares the duration.
- **Destinations.** `"type": "google-drive"` writes into that `folder_id`; `"type": "webdav"` writes into `path` on a WebDAV server (a NAS); `"type": "none"` saves nothing. `extension` is `.txt` (default), `.md` or `.srt`.
- **Google Drive setup.** Create a service account in Google Cloud, download its key JSON, and set `GOOGLE_APPLICATION_CREDENTIALS` to the file's path. Then share each `folder_id` with the service account's `client_email` (right-click folder → Share → paste the email → Editor). The service account can only reach folders you share with it. Under `docker compose`, bind-mount both files into the container and point the variables at the in-container paths (e.g. `- ./tenants.json:/data/tenants.json:ro` with `TENANTS_FILE=/data/tenants.json`).
- **NAS (WebDAV) setup.** Enable the NAS's HTTPS WebDAV service (Synology: WebDAV Server package; Nextcloud: its WebDAV endpoint) and create a user for this service. `base_url` must be `https://` — plain HTTP is refused at config load. The file holds only `password_env`: the name of an environment variable that carries the password (e.g. `NAS_WEBDAV_PASSWORD`), never the password itself; set that variable where the api process runs (under `docker compose`, add it to the api service's `environment:`).
- **Reaching a home or office NAS from a hosted instance.** Put both machines on a mesh VPN such as [Tailscale](https://tailscale.com/): install Tailscale where the api container runs and on (or beside) the NAS, then use the NAS's tailnet HTTPS name as `base_url` — for example `https://nas.tail1234.ts.net` with Tailscale HTTPS certificates enabled. Never expose the NAS to the public internet: no port forwarding, no public IP listener. If the api runs on the same LAN as the NAS, use its LAN HTTPS address instead.
- **The file.** Name: `<english-slug>_<videoId>_<YYYYMMDD>.<ext>` — a lowercase slug of the video title, the video id and the capture date. Contents: a header with title, channel, source URL and capture date, then the timestamped transcript. On Drive the video id is also stored in `appProperties`; on WebDAV it is the `<videoId>` inside the file name. Either way, saving the same video again — another day, a renamed title — updates the existing file instead of making a duplicate, and two different videos can never overwrite each other even when their names collide.
- **Consumer Google account (gmail.com).** A service account has no storage quota, so it cannot create files in a personal My Drive even when the folder is shared with it as Editor ([Drive API errors](https://developers.google.com/workspace/drive/api/guides/handle-errors)). The service-account setup above fits a Workspace shared drive. For a personal Drive, set `GOOGLE_OAUTH_JSON` to an OAuth client and refresh token of the Drive owner (scope `drive` to write into an existing folder; `drive.file` only reaches files the app created). The folder needs no sharing; the token acts as its owner.
- **Failures.** If the write fails (for example the folder is not shared with the service account, or the NAS rejects the login), the job still completes and returns the transcript, and the Discord reply or web result shows the save failure. The Discord bot replies with the file link (`Saved to Drive:`) or the saved path (`Saved to NAS:`) when the write succeeds.

The callers keep working exactly as before: the Discord reply gains a saved-file line, and the job result the web page reads gains a `saved.url` or `saved.path` field when a verified caller's job saves (plus a `save_error` on failure). See [openapi.yaml](openapi.yaml) for the `origin` and `saved` contract.

Notes:

- **Callers bring their own key, or their tenant holds one.** The service holds no Gemini key of its own except what a tenant's `gemini_key_env` names; each request's `X-Gemini-Key` lives in memory only for that job and is never logged, stored or returned.
- **Jobs are in-process.** The job store is memory only — a service restart loses every job (`GET /v1/jobs/{id}` then returns 404). The transcript cache on disk survives.
- The API is described in [openapi.yaml](openapi.yaml).
- To run it on AWS (ECS Fargate behind an HTTPS load balancer, secrets in Secrets Manager, logs in CloudWatch), see [deploy/aws/](deploy/aws/README.md).

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
| `BOT_ENCRYPTION_KEY` | BYOK mode | — | Secret that encrypts every guild's Gemini key at rest (AES-256-GCM). Losing it makes stored keys unreadable. Not needed in tenant mode. |
| `API_BASE_URL` | no | `http://localhost:8080` | Where the bot reaches the HTTP API. Under compose it is `http://api:8080`. |
| `SERVICE_TOKEN` | no | — | Must match the API's `SERVICE_TOKEN` when the API requires one (BYOK mode; tenant mode sends `TENANT_CALLER_TOKEN` instead). |
| `BOT_DATA_FILE` | no | `./bot-data/bot-data.json` | Local JSON file holding per-guild settings (encrypted keys, enabled channels). Under compose it lives in the `bot-data` volume. Not used in tenant mode. |
| `BOT_POLL_INTERVAL_MS` | no | `2000` | How often the bot polls a job (BYOK mode; tenant mode never polls). |
| `BOT_JOB_TIMEOUT_MS` | no | `1800000` | How long the bot waits for a transcript before giving up (BYOK mode). |
| `TENANT_CALLER_TOKEN` | tenant mode | — | Bearer token the bot submits jobs with — the same credential the tenant's `caller` entry names on the service. Setting it (with the two variables below) puts the bot in tenant listener mode. |
| `TENANT_GUILD_ID` | tenant mode | — | The Discord server (snowflake id) the listener answers in. |
| `TENANT_CHANNEL_IDS` | tenant mode | — | Comma-separated channel ids the listener answers in; a thread under a listed channel is covered. |

### Tenant listener mode

When `TENANT_CALLER_TOKEN`, `TENANT_GUILD_ID` and `TENANT_CHANNEL_IDS` are set, the bot is a plain listener for one configured tenant instead of a per-server BYOK bot: no slash commands, no per-guild key and no data file. A message with a YouTube URL in a configured channel — or a thread under one — is forwarded to `POST /v1/jobs` once, with the caller token as the bearer, the Discord `origin` (guild and parent channel) and `deliver_to` set to the message's own channel or thread. The service does everything after — transcription with the tenant key, the save, and posting the result into `deliver_to`; the listener sends no replies and adds no reactions. Slash-command setup below applies to BYOK mode only.

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

## Use from any agent (MCP)

Any MCP-capable runtime — Claude Code, Codex, Kiro, Devin, OpenAB bots, and others — can get a transcript with one tool call. The repo ships a stdio MCP server exposing a single tool, `get_transcript(url, max_block_seconds?)`, that returns the same transcript JSON the CLI prints, or a fixed error code (`{"error": {"code": "...", "message": "..."}}`). Gemini stays the transcription engine behind it; your own Gemini API key is sent per call and is never logged, stored or returned. `max_block_seconds` applies only when the server runs in-process (no `FISHERAIAGENT_URL`).

Build once, then point your agent runtime at the server (`npx fisheraiagent-mcp` when the package is installed; otherwise `node dist/mcp.js`):

```bash
npm ci && npm run build    # the server is dist/mcp.js
node dist/mcp.js           # speaks MCP over stdio
```

Server environment variables:

| Variable | Required | What it does |
|---|---|---|
| `GEMINI_API_KEY` | per call | The caller's Gemini key; a call without it returns `missing_key`. |
| `FISHERAIAGENT_URL` | no | When set, remote mode: the tool submits and polls jobs on that fisheraiagent HTTP service (sending the key as `X-Gemini-Key`) instead of transcribing in-process. |
| `FISHERAIAGENT_TOKEN` | no | Bearer token for a service started with `SERVICE_TOKEN`. |
| `GEMINI_MODEL` | no | In-process mode only: Gemini model (default `gemini-3.8-flash`). |
| `MAX_BLOCK_SECONDS` | no | In-process mode only: default max block length; a call's `max_block_seconds` overrides it. |
| `MAX_VIDEO_SECONDS` | no | In-process mode only: video length cap in seconds (default `43200`, YouTube's documented 12-hour upload maximum); a longer video fails with `video_too_long`. Remote mode uses the service's cap. |
| `CACHE_DIR` | no | In-process mode only: transcript cache directory. |

Claude Code:

```bash
claude mcp add fisheraiagent --env GEMINI_API_KEY=<your Gemini API key> -- node /absolute/path/to/dist/mcp.js
```

Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.fisheraiagent]
command = "node"
args = ["/absolute/path/to/dist/mcp.js"]
env = { GEMINI_API_KEY = "<your Gemini API key>" }
```

Any MCP client that takes a JSON server block:

```json
{
  "mcpServers": {
    "fisheraiagent": {
      "command": "node",
      "args": ["/absolute/path/to/dist/mcp.js"],
      "env": { "GEMINI_API_KEY": "<your Gemini API key>" }
    }
  }
}
```

To run the tool against a self-hosted service instead of in-process, add `FISHERAIAGENT_URL` (and `FISHERAIAGENT_TOKEN` when the service sets `SERVICE_TOKEN`) to the `env` block. Under docker compose, the `mcp` service is pre-wired to the `api` service in remote mode — point the client at:

```bash
docker compose run --rm -T mcp
```

## Self-host quick start (CLI)

One YouTube URL in, the full timed transcript out as JSON. You bring your own Gemini API key; the video URL goes to Gemini as video input — but only when the video has no manual caption track in the spoken language, which is read directly at zero Gemini cost. Nothing is downloaded or stored but the transcript cache you choose.

```bash
export GEMINI_API_KEY=<your Gemini API key>
docker compose run --rm transcribe https://youtu.be/hWe-j78vNpc
```

The transcript prints to stdout as JSON:

```json
{"video_id": "hWe-j78vNpc", "source_url": "https://www.youtube.com/watch?v=hWe-j78vNpc", "language": "en", "blocks": [{"start": 0, "end": 7.48, "text": "..."}], "source": "gemini"}
```

`source` says how the transcript was made: `captions:manual` (a human caption track in the spoken language, no Gemini calls) or `gemini` (`captions:auto` arrives with a per-tenant setting for auto captions).

Environment variables:

| Variable | Required | Default | What it does |
|---|---|---|---|
| `GEMINI_API_KEY` | yes | — | Your Gemini API key. |
| `GEMINI_MODEL` | no | `gemini-3.8-flash` | Gemini model used for transcription. |
| `MAX_BLOCK_SECONDS` | no | `8` | Maximum length of one transcript block, in seconds. |
| `WINDOW_SECONDS` | no | `120` | Length of one clipped transcription window, in seconds. Each window is a separate Gemini call with start and end offsets, so timestamps re-anchor per window. |
| `MAX_VIDEO_SECONDS` | no | `43200` | Video length cap, in seconds; a video known or discovered to be longer fails with `video_too_long`. Also the hard bound on transcription windows when nothing else limits the video. The default is YouTube's documented 12-hour upload maximum. |
| `CACHE_DIR` | no | `./transcript-cache` | Where transcripts are cached. Under `docker compose` this is the host directory bind-mounted to `/data/cache` in the container. |

Without Docker, on Node 22 or newer:

```bash
npm ci
GEMINI_API_KEY=<your Gemini API key> npm start -- https://youtu.be/hWe-j78vNpc
```

Error codes (stderr, non-zero exit): `invalid_url`, `video_unavailable`, `missing_key`, `key_rejected`, `quota_exceeded`, `upstream_timeout`, `upstream_rejected`, `upstream_media_error`, `model_not_found`, `bad_model_output`.

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

- **Bring your own key.** Each user or Discord server sets their own Gemini API key — or its tenant holds one (`gemini_key_env`) for its verified callers. On the web, the key stays in your browser.
- **Your destination, your config.** Each user or Discord channel chooses where transcripts are saved. Adding a user is configuration, not code.
- **One program.** The same container runs on your own machine (`docker compose up`) or on our hosted instance.

## Caption reader (Mac mini)

A small tool that reads a video's caption tracks and returns them over HTTP, so the cloud service can get captions from a residential IP without a Gemini call (agentfleet-team/fisheraiagent#65, #78). It reuses the caption reader module unchanged and has no tenant, Gemini or Drive code. The cloud calls it through a Cloudflare tunnel; the tunnel, Access and the real token are set up outside this repo.

```text
GET /v1/captions/{videoId}    Authorization: Bearer <CAPTION_READER_TOKEN>
  200  the caption read: {"kind":"manual"|"auto"|"none"|"unavailable", ...}
       (a YouTube-side failure is 200 with kind "unavailable" and a reason)
  400  {"error":"invalid_video_id"}
  401  {"error":"unauthorized"}
  429  {"error":"busy"}          (concurrency cap reached)
GET /healthz                  200 ok
```

| Env | Meaning |
|---|---|
| `CAPTION_READER_TOKEN` | Required. Startup exits non-zero without it. Compared as sha256 digests in constant time; never logged. |
| `CAPTION_READER_MAX_CONCURRENT` | Concurrent reads allowed (default 4). Over the cap returns 429. |
| `CAPTION_READER_RECEIPT_DIR` | Where receipts go (default `./receipts`; `/data/receipts` in compose). |
| `PORT` | Listen port (default 8090). |

Every `/v1/captions` request appends one JSON line to `receipts-YYYY-MM-DD.jsonl`: `ts`, `video_id`, `status`, `kind`, `reason`, `language`, `cue_count`, `cues_sha256`, `ms`, `caller` (first 8 hex characters of the token's sha256, `null` when the token was missing or wrong).

Run it: `CAPTION_READER_TOKEN=<token> npm run build && node dist/caption-reader.js`, or `docker compose --profile caption-reader up -d caption-reader` (same image, entrypoint `node dist/caption-reader.js`, port 8090, receipts in the `CAPTION_READER_RECEIPT_HOST_DIR` volume).

## Limits (from Google)

Gemini reads public or unlisted YouTube videos only, one video per request. See [Gemini video understanding](https://ai.google.dev/gemini-api/docs/video-understanding).

## Release checklist

Releases are semantic-version git tags on `main` (`vMAJOR.MINOR.PATCH`); user-visible changes and migration notes live in [CHANGELOG.md](CHANGELOG.md). The image records its identity (`APP_VERSION`, `APP_COMMIT`) so the deployed build reports itself at `GET /v1/config` and in the page footer.

1. Move the `Unreleased` changelog entries under `## [X.Y.Z] - YYYY-MM-DD` and merge to `main`.
2. On `main`: `npm ci && npm run build && npm test && npm run test:web && npm run typecheck` all green, then the live acceptance gate (the 9-run D2 oracle) on the same commit.
3. Tag the accepted commit: `git tag -a vX.Y.Z -m "vX.Y.Z" <sha>` and `git push origin vX.Y.Z`.
4. Build the image with the version and full commit sha baked in, tagged by both:

   ```bash
   docker build \
     --build-arg APP_VERSION=vX.Y.Z --build-arg APP_COMMIT=<full sha> \
     -t <ecr-repo>:vX.Y.Z -t <ecr-repo>:<full sha> .
   docker push <ecr-repo>:vX.Y.Z && docker push <ecr-repo>:<full sha>
   ```

5. Deploy the `vX.Y.Z` image tag, then live check: `GET /v1/config` on the site reports `"version": "vX.Y.Z"` and the page footer shows it.
6. Rollback: deploy the previous version tag.

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

---

**中文簡介**：AgentFleet 開源的 AI agent 工具。第一個工具：貼上 YouTube 網址，拿回完整逐字稿（有沒有字幕都可以）；可從網頁、Discord bot 或指令列使用，每位使用者用自己的 Gemini key、自己決定存放位置。可免費自架，也可使用 AgentFleet 代管服務。
