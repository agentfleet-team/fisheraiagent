# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/). Releases are `vMAJOR.MINOR.PATCH`
git tags on `main`.

## [Unreleased]

### Added

- Caption reader tool (`dist/caption-reader.js`, compose service
  `caption-reader`, profile `caption-reader`): the caption reader behind
  `GET /v1/captions/{videoId}` with a bearer token, a concurrency cap and
  one JSONL receipt per request, for the Mac mini. See README "Caption
  reader (Mac mini)" (agentfleet-team/fisheraiagent#78).
- The caption read can run remotely: `CAPTIONS_READER_URL` (https only,
  with `CAPTIONS_READER_TOKEN` as the bearer credential) points the
  service at a caption-reader tool over HTTP — on the hosted instance,
  the reader running on the Mac mini behind its own Cloudflare tunnel —
  with an optional `CAPTIONS_READER_ACCESS_ID` /
  `CAPTIONS_READER_ACCESS_SECRET` Cloudflare Access service-token pair
  and a `CAPTIONS_READER_TIMEOUT_MS` budget (default 4000).
  `CAPTIONS_READ=local` keeps the in-process read for self-hosters; with
  neither set the read is off and the service makes no YouTube call at
  all — the new default, replacing the always-local reader wired in #68.
  A remote read that times out, is unreachable, refuses or answers badly
  falls back to Gemini with the mapped reason; the adapter never throws,
  never retries and never logs a credential. `captions_read` gains
  `origin=remote|local` (agentfleet-team/fisheraiagent#80).
- Transcription reads the video's caption tracks before any Gemini call:
  a manual track in the spoken language becomes the timed transcript with
  zero Gemini calls (InnerTube `player` with the ANDROID client, plain
  fetch, no new dependency — the method T0 proved in
  agentfleet-team/fisheraiagent#66). Auto-only videos, videos with no
  usable track and every failed read go to Gemini exactly as before.
  `Transcript` gains `source` (`captions:manual` or `gemini`;
  `captions:auto` arrives with the tenant captions setting), the cache
  format version is bumped once and caption results are never cached. The
  CLI, the HTTP service and the MCP server all wire the reader; each job
  logs `captions_read` and `source_chosen`
  (agentfleet-team/fisheraiagent#68).
- The Discord bot gains a tenant listener mode: when `TENANT_CALLER_TOKEN`,
  `TENANT_GUILD_ID` and `TENANT_CHANNEL_IDS` are set, the bot takes its
  enabled channels from configuration — no slash commands, no per-guild key,
  no data file — and forwards a posted YouTube URL to `POST /v1/jobs` once,
  with the caller token as the bearer, the Discord `origin` (guild and
  parent channel) and `deliver_to` (the message's channel or thread). The
  service owns the transcript, the save and the delivery; the listener
  sends no replies and adds no reactions. BYOK mode is unchanged
  (fisherivco/allen-ai-os#1539).
- A tenant may hold a Discord delivery credential: the tenants document
  gains an optional `discord_delivery` block naming `token_env`, the
  environment variable that carries a dedicated file-deliverer bot token.
  A `POST /v1/jobs` from a caller whose bearer token passes that tenant's
  caller check may carry `deliver_to` (a Discord channel or thread id);
  the service posts the result into that target — one summary bounded to
  2000 characters with the Drive link when saved and the `.txt`
  transcript attached, or one short line with the fixed error code for a
  failed job — but only when Discord reports the target, or a thread's
  parent, in the tenant's `discord_channel_ids`. The job view gains
  `delivery` (`sent` with the message id, or `failed` with a fixed code);
  the Drive save is unchanged, and the token reaches only
  https://discord.com with redirects never followed and is never logged
  (fisherivco/allen-ai-os#1506).
- A tenant may hold its own Gemini key: the tenants document gains an
  optional `gemini_key_env` naming an environment variable that carries the
  key. A `POST /v1/jobs` without `X-Gemini-Key`, from a caller whose bearer
  token passes that tenant's caller check, is transcribed with the tenant
  key. Bring-your-own-key requests are unchanged, a failed caller check
  never falls back to the tenant key, and the key never reaches logs, job
  views or errors (fisherivco/allen-ai-os#1511).

## [0.1.1] - 2026-11-23

### Added

- Every Gemini call beyond a clip's first request now writes one
  allowlisted `gemini_extra_call` log line — `reason` is `strict_retry`,
  `empty_full_window`, `subclip`, `tail_reask`, `media_retry` or
  `continuation` — with `video` and `windowStart` and never transcript or
  prompt text, so a run's input-token cost can be charged to the retry
  rule that spent it (#49).

### Fixed

- Static assets no longer reach browsers a deploy late: the page stamps
  its asset URLs with `?v=<commit>`, and the service sends a year-long
  `max-age` for a versioned URL while HTML and unversioned URLs go out as
  `no-cache, no-store`. Cloudflare's default 4-hour browser TTL — which
  rewrote the old `no-cache` to `max-age=14400` — respects the higher
  `max-age` and leaves `no-store` alone (#50).

## [0.1.0] - 2026-11-23

First release: the build the owner accepted live on 2026-11-23 (`011b768`)
plus the follow-ups merged since. Deployed at https://transcripts.agentfleet.team
as a public page (bring your own Gemini key).

### Added

- Web page key check on Save: the page calls Gemini's `models.get` directly
  from the browser for the model the service runs; the key never reaches the
  service (#42).
- Per-client job limits on the anonymous `/v1` surface: at most 2 in-flight
  jobs and 20 accepted submissions per client per sliding hour, keyed on
  `CF-Connecting-IP` from trusted proxies (#43).
- `GET /v1/config` reports `version` and `commit`, baked in at image build
  time; the web page footer shows them so a bug report can name the exact
  build (#46).

### Changed

- Transcription runs in clipped 120-second windows (`videoMetadata`
  start/end offsets); block times re-anchor per window so timestamp drift
  cannot cross a window boundary (#17).
- An over-limit transcript block no longer fails its whole window: its
  range is re-asked as a short sub-clip, and if that still fails the
  original block is kept and logged (#33, #37).
- The window loop is bounded at 12 hours (YouTube's maximum upload length)
  when no per-tenant cap applies (#34).
- A full-length window whose answer carries no usable blocks no longer ends
  the video — only a completed answer counts as end-of-video evidence (#40).

### Migration notes

- Transcript cache format version is now 4 (bumped whenever prompt or
  parser behavior changes); cache entries written by earlier builds are
  ignored and transcripts are regenerated (#32).
- The AWS task definition no longer pins `WINDOW_SECONDS`; the single
  default lives in `src/config.ts` (#32).
- The Docker image accepts `--build-arg APP_VERSION=<tag>` and
  `--build-arg APP_COMMIT=<sha>`; release images should set both so the
  deployed build reports its identity (#46).

[Unreleased]: https://github.com/agentfleet-team/fisheraiagent/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/agentfleet-team/fisheraiagent/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/agentfleet-team/fisheraiagent/releases/tag/v0.1.0
