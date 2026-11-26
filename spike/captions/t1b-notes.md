## Method

For each video the probe makes one InnerTube `player` call (ANDROID client 20.10.38, the T0 identity in `lib.mjs`) per `hl` value, `en` and `zh-TW`, with `gl=US`. It records `captions.playerCaptionsTracklistRenderer.captionTracks`, `audioTracks[].captionTrackIndices`, `audioTracks[].defaultCaptionTrackIndex` and `defaultAudioTrackIndex`. The rule under test is the home orchestrator's pick: take `audioTracks[defaultAudioTrackIndex].captionTrackIndices` and use the track it names. The 13 videos have no ASR track. They are the 7 videos named in the ticket (two are the counterexamples `TLgAJgYqIZk` and `24kbywok2Hw`) and 6 more found by InnerTube search in other spoken languages (ja, fr, de, es, tr, th). Nothing is fetched except the player response. No language list or per-language branch is used in the probe or in the scoring: a pick is correct when it is a single track whose language equals the observed spoken language.

## Verdict

**REFUTED.** `captionTrackIndices` does not identify the spoken-language track.

- It is the list of every caption track of the video, not a pointer to one track. Whenever a video has more than one track (for example `JBRv-EAv2IA`, five tracks), the field names all of them, so it names no single track.
- On both counterexamples the only track is English. `TLgAJgYqIZk` (Korean speech) and `24kbywok2Hw` (Hokkien and Mandarin speech) both name `en`, a translation. A rule that picks from this field picks English on both.
- The order of tracks, and so the index values, depends on `hl`. For example `JBRv-EAv2IA` lists `ar nl de hu es` under `en` and `hu es ar nl de` under `zh-TW`; `XUqrvbsTfck` and `xzo8DPcVRZw` list the Arabic translation before the spoken track under `en` and after it under `zh-TW`. A "first index" rule is therefore correct or wrong depending on the request language. Section 3 scores it.
- `defaultCaptionTrackIndex` is present on some responses only, and its presence differed between calls for the same video and `hl` in the seat's runs. When present it follows `hl`: `6i7RcP39NB0` and `tx6of5YHqCA` give 1 (the English translation) under `en` and 0 under `zh-TW`. It carries no spoken-language information. Its row in section 3 can vary between runs; the `captionTrackIndices` columns did not.
- The player response has no other field in these samples that marks the original language when no ASR track exists. A lone manual track can be a translation, so the #76 behaviour (no ASR track means `none`, stay on Gemini) stands.
