# podcast-night

Cloudflare Worker that routes the morning-podcast night across the transcript, digest, and voice tools. It runs on a Cron Trigger every five minutes between 00:00 and 06:55 Asia/Taipei (`*/5 16-22 * * *` UTC), folds the night's run record, and runs due nodes one after another. It stops after five nodes or at the first node that must wait for a running tool job or an unopened slot. It has no HTTP route: `fetch()` returns 404, and `workers_dev` and `preview_urls` are both `false`.

## The seam

- Record: `<STATE_REPO>` `research/morning-podcast/runs/<YYYY-MM-DD>.jsonl`, one receipt per line, where the last line per node wins. Appends go through the GitHub contents API: a PUT carries the blob SHA it read, a 409 triggers one re-read, and a second 409 ends the tick without a write.
- Artifacts: transcripts, pool files, request pins, and episode scripts commit next to the record under `runs/<YYYY-MM-DD>/` before their receipts.
- Pure planner: `fold(lines, now, ctx)` in `src/fold.ts` and `planTail(lines, now, date, config)` in `src/tail.ts` compute the next step from the record lines, clock, and config. All GitHub and tool HTTP calls live in `src/worker.ts`, `src/github.ts`, `src/summary.ts`, `src/tool1.ts`, and `src/jobtool.ts`.
- Instance gate: `runTick` validates `STATE_REPO`, `SUMMARY_REPO`, and `SUMMARY_ISSUE` at the start of every tick. If any required var is missing or malformed, the tick returns a failure with zero store reads, store writes, tool calls, or issue comments.
- Dry run: while `DRY_RUN` is not `"false"`, the tick reads, folds, and logs its plan without writing or calling tools.

## Nodes this app runs

Scan order per tick: `config`, `pool`, `pick-1..3`, `transcript-1..3`, then at `content_at` the tail (`content`, `voice`, `check`, `deliver`, and `summary` in `trial` mode). There is no captions node because tool 1 asks the Mac mini caption reader itself (`agentfleet-team/fisheraiagent#86`, `#87`) and reports `source` on each transcript.

| node | due when | does | receipt |
|---|---|---|---|
| `config` | no config receipt, or last one `escalated` and the file parses now | reads `research/morning-podcast/config.json` at head and validates per `config.schema.json` | `done` with `config_sha`, `enabled`, `mode`; `escalated` on a missing or unparseable file |
| `pool` | config done and `enabled`, no terminal `pool` receipt | fetches one `youtube.com/results` page per topic query with the week filter (`sp=CAISBAgDEAE%3D`), falls back to the month filter (`sp=CAISBAgEEAE%3D`) for any topic with zero passing week hits, filters to 8–90 minutes outside `deny_channels` and earlier runs, adds unused `backlog` entries, scores, and commits `runs/<YYYY-MM-DD>/pool.json` | `done` with `count`, `pool_sha256`, `path`, `source`; a first search failure records `failed`, and a second records `escalated` |
| `pick-<n>` | `pool` `done` or `escalated`, now >= `slots[n-1]` Taipei, no `pick-<n>` receipt | picks the highest-scored unused slot-n candidate from `pool.json` and the next candidate as backup, or falls back to `backlog` when `pool` is `escalated` or unreadable | `done` with `video_id`, `backup_id`, `score`, `reason` (`no_candidates` when empty) |
| `transcript-<n>` | `pick-<n>` done with a video id | submits `POST /v1/jobs` and polls `GET /v1/jobs/<id>` on tool 1 | `done` with `source`, `blocks`, `transcript_sha256`, `path`; `filled` when the backup id succeeded; `failed` per try |
| `content` | now >= `content_at` Taipei and at least one transcript is ready | pins `content-request.json` and runs tool 2 (`podcast-zh-tw-10min`) with `Idempotency-Key` | `done` with `chars`, `script_sha256`, `path`, `file_id`; `failed` on try 1; `escalated` on try 2 or if no transcripts exist |
| `voice` | `content` done | pins `voice-request.json` and runs tool 3 with `expect_seconds` from `chars` | `done` with `duration_s`, `bytes`, `audio_sha256`, `audio_file_id`, `marks_file_id`; `failed` on try 1; `escalated` on try 2 |
| `check` | `voice` done | verifies `duration_s` falls within 80% to 120% of the 262-chars-per-minute band | `done` with `chars` and `duration_s`, or `escalated` |
| `deliver` | `check` done | checks that `file_id`, `audio_file_id`, and `marks_file_id` are present | `done` or `escalated` |
| `summary` | `deliver` done and `mode` is `"trial"` | posts one summary line with marker comment to `SUMMARY_REPO` issue `SUMMARY_ISSUE` | `done` |

- `enabled: false` in config stops the night after the `config` receipt with no tool calls.
- Node deadlines follow the watchdog contract (`config` 00:15 Taipei, `pick-<n>` slot start + 15 min, and `src/deadlines.ts` for `content` and `voice`).

## Deploy an instance

This repository holds the generic router code and `wrangler.jsonc` template without any deployment-specific repository or issue values. Allen's instance values are supplied by the owner step `deploy-router` (`fisherivco/allen-ai-os#1905`), not by this repository.

1. Prepare the instance state repository (`STATE_REPO`) with `research/morning-podcast/config.json` matching `config.schema.json`. See `fixtures/config.json` for an example with `enabled`, `mode` (`"trial"` or `"live"`), three `slots` in `HH:MM` Asia/Taipei, `content_at`, `topics`, `backlog`, `channel_boost`, and `deny_channels`.
2. Supply these Wrangler vars at deploy time (`wrangler.jsonc` sets only `DRY_RUN` and `TOOL1_BASE_URL`):

| Var | Required | Default | Meaning |
|---|---|---|---|
| `STATE_REPO` | yes | none | GitHub `owner/repo` that holds `research/morning-podcast/config.json` and receives run records and artifacts |
| `SUMMARY_REPO` | yes | none | GitHub `owner/repo` that receives the trial-mode summary comment |
| `SUMMARY_ISSUE` | yes | none | Positive integer issue number on `SUMMARY_REPO` for the trial-mode summary comment |
| `DRY_RUN` | no | `"true"` | Any value other than `"false"` keeps the tick read-only |
| `TOOL1_BASE_URL` | no | `https://transcripts.agentfleet.team` | Base URL for the transcript tool |
| `TOOL2_BASE_URL` | no | `https://digest.agentfleet.team` | Base URL for the digest tool |
| `TOOL3_BASE_URL` | no | `https://voice.agentfleet.team` | Base URL for the voice tool |

3. Configure these Worker secrets by name in the target Cloudflare Worker (never commit secret values):
   - `GITHUB_TOKEN`: GitHub token with contents read/write on `STATE_REPO` and issues read/write on `SUMMARY_REPO` when running in `trial` mode.
   - `PODCAST_CALLER_TOKEN`: Bearer token sent to tool 1, tool 2, and tool 3.
4. Keep the cron trigger from `wrangler.jsonc`: `*/5 16-22 * * *` (every 5 minutes from 00:00 to 06:55 Asia/Taipei, UTC+8).
5. Bundle check before deploying from an instance wrapper: `npx wrangler deploy --dry-run`. Never deploy from an unreviewed agent seat or commit instance values here.

## Test and verify

```bash
cd apps/podcast-night
npm ci
npx tsc --noEmit
npx vitest run
npx wrangler deploy --dry-run --outdir dist-dry-run
```

`tests/tail.test.ts` imports `src/digest/contract.ts` and `src/voice/contract.ts` directly from the repository root (which in turn import `src/ids.ts` and `src/digest/profile.ts`). `tests/env.test.ts` verifies that any missing or malformed `STATE_REPO`, `SUMMARY_REPO`, or `SUMMARY_ISSUE` fails before any store, tool, or comment port call. `npm run probe` runs the read-only live YouTube search check from `src/selection/probe.ts`.

## History

Moved to `agentfleet-team/fisheraiagent` at `apps/podcast-night/` from `fisherivco/allen-ai-os` (`apps/podcast-night/` at commit `b2b36932bf50193c8b9cbfe7245ff921db8c479b`, short `b2b36932`).

Source PRs in `fisherivco/allen-ai-os`:
- `fisherivco/allen-ai-os#1913`: initial router, receipt fold, and tool 1 loop (`#1900`).
- `fisherivco/allen-ai-os#1919`: YouTube results-page `pool` selection (`#1901`).
- `fisherivco/allen-ai-os#1918`: `content`, `voice`, `check`, `deliver`, and `summary` tail (`#1903`).
- Design PRD and RFCs live in `fisherivco/allen-ai-os#1878` (`docs/morning-podcast/rfc/RFC-001` through `RFC-004`).
