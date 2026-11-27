# digest (tool 2)

Turns N transcripts (tool 1's `Transcript` JSON) and their video metadata into one episode script for a named profile. Same job API as the transcript tool. Status: built, not deployed. Contract: RFC-002 in `fisherivco/allen-ai-os` (the morning podcast RFC set, PRD allen-ai-os#1878), ticket `agentfleet-team/fisheraiagent#83`.

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
| `check` | JSON schema, structure, refs, missing-slot sentence, length band; up to two repair calls on any failure, each naming the problems of the check before it | job `failed`, `script_check_failed` with `error.problems` |
| `save` | writes `<date>-script.md` to the tenant's `google-drive` destination; an existing file of that name is returned, never rewritten | job stays `done`, `save_error` is `save_failed` |

The job makes the draft call, then up to two repair calls. The first passing check ends the loop. If the third check fails, the job is `failed` with `error.code` `script_check_failed` and `error.problems`, the problem strings of the last check. The service writes one line per failed check: `digest_check_failed job=<id> attempt=<n> problems=<JSON array>`, where attempt 1 is the draft. The lines hold no transcript text and no key.

`check` rules for profile `podcast-zh-tw-10min`:

- `sections` are one `opening`, one `segment` per source in slot order, one `closing`.
- Every segment has at least one ref. A ref names the segment's own `video_id` and a `start` that falls inside one transcript block (`start` to `end`).
- Each slot in `missing_slots` appears as `第N則` in the opening or closing.
- `char_count` (spoken text of all sections, whitespace not counted) is inside the profile band, 2,400 to 2,850. It comes from the 9 to 11 minute acceptance at 262 characters per audio minute (fisheraiagent#82). Change it in `profile.ts`. The draft prompt states a concrete target — about 2,500 (the lower middle of the band, because the model overshoots), minus any fixed framing lines — plus a per-section budget (opening, each segment, closing). A failed length check names the total, the exact overshoot or shortfall, and a per-section cut or add scaled from the actual section lengths toward the midpoint (2,625).
- After the last repair call, if the draft is still above 2,850, a deterministic fit step removes whole sentences (ending 。！？ or a line end; a closing quote or bracket after the terminator stays with its sentence) from the end of the longest segment, then the next longest, until the total is at most 2,850. It never touches the opening and closing bodies or the fixed lines, never removes a segment's last sentence, keeps every segment's refs, and never cuts below 2,400. The service logs `fit removed=<n> chars_before=<a> chars_after=<b>`. If the fit cannot reach the max, the job fails with the problem list of the check.
- The model writes spoken text only. The tool appends the source list (title, channel, link per source) to `markdown` after the closing.

## Tenant fixed lines

A tenant may fix the spoken framing of its episodes in the tenants document (the same `TENANTS_FILE` / `TENANTS_JSON` the transcript tool reads):

```json
"digest": { "opening_line": "<greeting>", "closing_line": "<sign-off>" }
```

- Each value is a non-empty string of at most 200 characters (`MAX_DIGEST_LINE_CHARS` in `src/tenants.ts`); any other value fails the tenants-document load like every other bad field. Either field may be set alone; a tenant without them gets the unprompted behavior.
- `opening_line` replaces the model's greeting: the draft and repair prompts say the system adds the opening line, the model writes only the opening body, and the `opening` section comes out as `opening_line` then the model's body, verbatim.
- `closing_line` replaces the model's sign-off the same way: it ends the `closing` section verbatim, and the prompt says the system adds it.
- The check works on the model's bodies before composition: a body that repeats the configured line, opens with a greeting or ends with a sign-off (the `greetings` / `signoffs` lists in `profile.ts`) is a check problem and goes to the repair loop, so the composed section holds each fixed line exactly once. The lines count in `char_count` and the band; the prompt reduces the model's own length target by their length.

## Save is off until allen-ai-os#1879 merges

`server.ts` wires no Drive adapter, so `saved` is absent in every real job. The `DigestDrive` interface in `save.ts` is what the adapter must implement: find a file by name in a folder, create a file.
