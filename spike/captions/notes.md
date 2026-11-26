## 7. Verdict, chosen method and maintenance risk (written by the builder)

**Verdict: PASS (premise holds from the Mac mini).** A plain `fetch()` of the InnerTube `player` endpoint with the `ANDROID` client identity (`clientVersion 20.10.38`) returns a `captions` block with usable `baseUrl`s. Fetching `baseUrl` + `&fmt=json3` returns the cue text, with no PO token, no cookie and no npm dependency. All three acceptance videos give the expected kind in one command (`npm run verify`):

| role | video | kind read | cues (asr / manual) |
|---|---|---|---|
| manual track in the spoken language | dQw4w9WgXcQ | manual | 52 / 61 |
| ASR only | hWe-j78vNpc | auto | 255 / - |
| no tracks | aqz-KE-bpKQ | none | - |

Extra videos check the rule: UF8uR6Z6KLc and arj7oStGLkU (manual + asr, speech), 3JZ_D3ELwOQ (ASR only, auto-dubbed), kJQP7kiw5Fk (manual tracks only, no asr).

Candidate order from the ticket: (a) InnerTube with a client that returns usable caption URLs worked first for `ANDROID`, so (b) `youtubei.js` + PO token and (c) other npm libraries were not run (stop at the first method that works for all three). Design review r1 already recorded `youtubei.js` `getTranscript` as refused. Other clients tried here and why they fail are in table 1: `ANDROID_VR` works for a video that needs no check, then returns the "confirm you're not a bot" login wall on two of three videos; `WEB`, `MWEB`, `TVHTML5` return UNPLAYABLE or the login wall; `WEB_CREATOR` returns LOGIN_REQUIRED; an older `ANDROID` version (19.09.37) returns HTTP 400.

### ASR-original rule (holds for the three videos and the four extras)
Spoken language = language of YouTube's original speech-recognition track (`kind: "asr"`), chosen without any language list:
1. If the player lists more than one audio track (YouTube auto-dubbing, seen on hWe-j78vNpc and 3JZ_D3ELwOQ with 15 to 21 `asr` tracks), the original is the `asr` track whose language matches `audioTracks[defaultAudioTrackIndex].audioTrackId` (here `en-US.4`; the dubs carry `.10`). The other `asr` tracks are translations: the `ar` and `nl-NL` tracks fetched as controls contain Arabic and Dutch text of the English speech.
2. Otherwise exactly one `asr` track must exist and it is the original (dQw4w9WgXcQ, UF8uR6Z6KLc, arj7oStGLkU).
3. More than one `asr` track and no multi-audio hint is `ambiguous` and must go to Gemini. No `asr` track means the spoken language is unknown: kJQP7kiw5Fk has six manual tracks (en, ja, es...) and no `asr` track, so the reader cannot tell which is the spoken one and the rule sends it to Gemini. A manual track counts only when its language has the same primary subtag as the spoken language.

### Text match (P4)
The ticket asks for ASR vs the existing Gemini transcript; the zone orchestrator changed it (ticket comment): ASR vs the manual track of the same video, no Gemini key. Measure: bag-of-words F1 on word multisets (Intl.Segmenter, lower-cased, punctuation dropped) and Jaccard on word sets, see table 4. For spoken-word videos F1 is 0.96 to 0.97. dQw4w9WgXcQ scores 0.645 because it is a song (ASR hears `[Music]` and mis-hears lyrics). A text match against Gemini on the ASR-only video is left to T3 (#70).

### Timing
Median of 3 runs from the Mac mini (residential IP): 70 to 150 ms for the player call plus fetching the original asr and manual tracks, against 1 to 3 s assumed by the design review. Timing is for one fetch of each track; `asr-other` control fetches are included in the ASR-only rows.

### Maintenance risk
- **Medium to high, but contained.** The method rides on an unofficial client identity. YouTube already rejects an old `ANDROID` version with HTTP 400 (19.09.37), so the pinned `20.10.38` will rot; the reader needs the version as a constant, a canary run (`npm run verify`) and the `unavailable` fallback to Gemini. Nothing breaks the job when it fails; it only costs the saving.
- YouTube can start requiring a PO token on `ANDROID` caption URLs (it already does on `WEB` URLs per design review r1). The fallback is the same: `unavailable`, then Gemini.
- Datacenter IPs: not measured. `ANDROID_VR` already hits the bot wall for two of three videos from a residential IP; the `ANDROID` client did not. The AWS-network run of `npm run verify` is the owner step in the parent ticket and decides whether the hosted service can use this at all.
- No dependency to patch: about 60 lines of `fetch` and JSON parsing in `lib.mjs`. `baseUrl` values are signed and expire (about 6 hours); the reader must fetch them straight after the player call.
- Not tested: a non-English spoken video with a manual track (the rule has no language branch, but only English was checked with both kinds); live streams (the lofi radio videos return UNPLAYABLE); age-restricted or members-only videos.

### Notes for T1
- `fixtures/innertube-android/<video>/player.json` (trimmed player response) and `*.json3` (raw timedtext) are the recorded responses for the reader tests.
- json3 `events` without `segs` are window markers; cue text is the join of `segs[].utf8`; ASR cues may start with `[Music]`.
- Reader order differs from the node table by one swap: P3 (pure) runs before P2 because P2 needs the chosen tracks.
