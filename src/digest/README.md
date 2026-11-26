# digest (tool 2)

Turns N transcripts (tool 1's `Transcript` JSON) and their video metadata into one episode script for a named profile. Same job API as the transcript tool. Status: built, not deployed. Contract: RFC-002 in `fisherivco/allen-ai-os` (`docs/morning-podcast/rfc/`), ticket `agentfleet-team/fisheraiagent#83`.

Run it: `npm run build && node dist/digest/server.js`. It reads the transcript service's variables: `PORT`, `SERVICE_TOKEN`, `GEMINI_MODEL`, `TENANTS_FILE` and `TENANTS_JSON`. The API is in `openapi.yaml` next to this file.

## Job API

- `POST /v1/jobs` with an `EpisodeRequest` returns `202 {"job_id"}`. `GET /v1/jobs/<id>` returns `queued|running|done|failed` with `result` (an `EpisodeScript`) or `error`.
- `Authorization: Bearer <token>` is required when `SERVICE_TOKEN` is set.
- Gemini key: `X-Gemini-Key`, else the `gemini_key_env` of the tenant whose `caller` credential the bearer token satisfies. No key gives `400 missing_key`.
- `Idempotency-Key`: the same key with the same request returns the first job (`202`, same `job_id`) and makes no LLM call. The same key with another request returns `409 idempotency_conflict`. Keys are kept in process memory, per caller token, and a restart forgets them.

## Nodes

| node | what it does | failure |
|---|---|---|
| `validate` | parses the `EpisodeRequest`; no LLM call before it passes | `400 invalid_request` |
| `draft` | one Gemini call with the profile prompt | job `failed` with the upstream code (`key_rejected`, `quota_exceeded`, `upstream_timeout`, ...) |
| `check` | JSON schema, structure, refs, missing-slot sentence, length band; one repair call on any failure | job `failed`, `script_check_failed` |
| `save` | writes `<date>-script.md` to the tenant's `google-drive` destination; an existing file of that name is returned, never rewritten | job stays `done`, `save_error` is `save_failed` |

`check` rules for profile `podcast-zh-tw-10min`:

- `sections` are one `opening`, one `segment` per source in slot order, one `closing`.
- Every segment has at least one ref. A ref names the segment's own `video_id` and a `start` that falls inside one transcript block (`start` to `end`).
- Each slot in `missing_slots` appears as `第N則` in the opening or closing.
- `char_count` (spoken text of all sections, whitespace not counted) is inside the profile band. The band is a placeholder, 2,600 to 3,000, until fisheraiagent#74 publishes the ten-minute count. Change it in `profile.ts`.
- The model writes spoken text only. The tool appends the source list (title, channel, link per source) to `markdown` after the closing.

## Save is off until allen-ai-os#1879 merges

`server.ts` wires no Drive adapter, so `saved` is absent in every real job. The `DigestDrive` interface in `save.ts` is what the adapter must implement: find a file by name in a folder, create a file.
