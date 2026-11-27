# voice (tool 3)

Turns the sections of an episode script into one MP3 and one time mark per sentence, with Edge TTS. Same job API as the transcript tool. Status: built, not deployed. Contract: RFC-004 in `fisherivco/allen-ai-os` (the morning podcast RFC set, PRD allen-ai-os#1878), ticket `agentfleet-team/fisheraiagent#84`. Engine choice and limits: spike `agentfleet-team/fisheraiagent#74` (`spike/tts/REPORT.md`).

Run it: `npm run build && node dist/voice/server.js`. It reads `PORT`, `SERVICE_TOKEN`, `TENANTS_FILE` and `TENANTS_JSON` like the other services. Edge TTS needs no key. The API is in `openapi.yaml` next to this file.

Live check from a machine with internet: `npm run voice:probe` renders a 2-section fixture with the real endpoint, writes the MP3 and the marks to `voice-probe-out/` (git-ignored) and prints the duration and the mark count.

## Job API

- `POST /v1/jobs` with a `VoiceRequest` returns `202 {"job_id"}`. `GET /v1/jobs/<id>` returns `queued|running|done|failed` with `result` (a `VoiceResult`) or `error`. A failed render names the section in `error.section_id`.
- `GET /v1/jobs/<id>/audio` returns the MP3 of a done job. The service keeps the MP3 of the newest 4 done jobs in memory; Drive is the durable copy once `save` is on.
- `Authorization: Bearer <token>` is required when `SERVICE_TOKEN` is set.
- Tenant: the optional `tenant` field names the tenant id the job runs as; resolution then requires both that id and the bearer's caller check on it — an unknown id or an unsatisfied check is `403 tenant_forbidden` and reveals no tenant data. Without the field the first caller-authorized tenant resolves, as before.
- `Idempotency-Key`: the same key with the same request returns the first job (`202`, same `job_id`) and renders nothing. The same key with another request returns `409 idempotency_conflict`. Keys are kept in process memory, per caller token, and a restart forgets them.

## Nodes

| node | what it does | failure |
|---|---|---|
| `validate` | parses the `VoiceRequest` (voice engine `edge`, unique section ids, `expect_seconds.min <= max`) | `400 invalid_request` |
| `render-<section>-<chunk>` | splits each section into chunks of at most 1,300 characters at sentence ends; one Edge TTS request per chunk with a 120 s limit and one retry; marks come from `SentenceBoundary` events | job `failed`, `render_failed`, with `section_id` |
| `join` | joins the chunks in order; marks are shifted by the audio before them, ordered and never overlapping | none |
| `check` | the joined duration must be inside `expect_seconds` | job `failed`, `duration_out_of_band`; nothing is saved |
| `save` | writes `<date>-episode.mp3` and `<date>-marks.json` to the tenant's `google-drive` destination — `folders.voice` when the destination names it, else `folder_id`, with the destination's `file_prefix` prepended when it names one; an existing file of that name is returned, never rewritten | job stays `done`, `save_error` is `save_failed` |

Notes:

- Duration is computed from the byte count at 48 kbit/s constant bitrate (the format is `audio-24khz-48kbitrate-mono-mp3`). A chunk with no audio or no sentence boundary counts as a failure, so a partial file never joins.
- Rate: about 262 characters per audio minute at `-12%` (spike #74), so the router picks `expect_seconds` around the script length.
- `msedge-tts` 2.1.1 is the engine. Do not switch to `edge-tts-universal` 1.4.0; the endpoint answers 403 to it (spike #74).

## Save is off until allen-ai-os#1879 merges

`server.ts` wires no Drive adapter, so `saved` is absent in every real job. The `VoiceDrive` interface in `save.ts` is what the adapter must implement: find a file by name in a folder, create a file (text or bytes).
