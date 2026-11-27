# Spike: clearer English inside zh-TW speech, three A/B samples (fisheraiagent#107)

Phase 1 only. Allen picks by ear; phase 2 builds the chosen option into `src/voice/engine.ts` in a separate round. No change to `src/` or `test/`.

Rerun: `cd spike/voice-english && npm ci && node render.mjs` (Node >= 22, network to the Edge TTS endpoint, no secrets). The script writes `samples/*.mp3` and `samples/results.json`, which holds every SSML request it sent and every error text.

Run of 2026-11-27 14:22 Taipei: msedge-tts 2.1.1, Node v26.13.0, Mac mini. Base voice `zh-TW-HsiaoChenNeural`, base rate `-12%` (RFC-004), output 24 kHz 48 kbit mono MP3.

Test sentence: `今天第一則是 Matt Pocock 示範怎麼用 mattpocock/skills 在一天內交付兩萬一千行的功能。`
Latin-script spans (regex in `render.mjs`): `Matt Pocock`, `mattpocock/skills`.

## Result

| # | option | one SSML request | sample | how rendered | duration | size |
|---|---|---|---|---|---|---|
| 1 | as-is | accepted | [`samples/sample-1-as-is.mp3`](samples/sample-1-as-is.mp3) | one request, today's engine template | 8.76 s | 52,560 B |
| 2 | lang | **rejected** | [`samples/sample-2-lang-split.mp3`](samples/sample-2-lang-split.mp3) | 5 requests, English spans in `en-US-AriaNeural`, MP3 frames concatenated | 14.30 s | 85,824 B |
| 3 | slow | **rejected** | [`samples/sample-3-slow-split.mp3`](samples/sample-3-slow-split.mp3) | 5 requests, English spans at `-35%` in the same zh-TW voice, concatenated | 15.58 s | 93,456 B |

Total 231,840 B, so the samples stay in the spike folder (no release assets).

**Finding.** The Edge TTS endpoint behind msedge-tts 2.1.1 accepts only the library's own template shape: one `<voice>` with one `<prosody>` and plain text. Any inner element closes the socket without `turn.end`. The library then rejects with the error text below. No audio bytes arrive. So options 2 and 3 cannot be one SSML request. They can be built only by splitting the text at English spans, one request per span, and joining the MP3 frames. Samples 2 and 3 are made that way.

**Confound for the listening test.** Each Edge request adds its own leading and trailing silence. The split samples have 5 requests instead of 1, so about 5.5 s of the extra length in samples 2 and 3 is pause, not slower speech. Allen hears a short pause around each English name. The pause may itself help understanding. Phase 2 can trim or shorten that silence if Allen picks option 2 or 3.

## V1: the files exist, decode, and render the same sentence

`afinfo` (macOS; `ffprobe` is not installed on this host):

```
File:           samples/sample-1-as-is.mp3
File type ID:   MPG3
Data format:     1 ch,  24000 Hz, .mp3 (0x00000000) 0 bits/channel, 0 bytes/packet, 576 frames/packet, 0 bytes/frame
estimated duration: 8.760000 sec
audio bytes: 52560
File:           samples/sample-2-lang-split.mp3
File type ID:   MPG3
Data format:     1 ch,  24000 Hz, .mp3 (0x00000000) 0 bits/channel, 0 bytes/packet, 576 frames/packet, 0 bytes/frame
estimated duration: 14.304000 sec
audio bytes: 85824
File:           samples/sample-3-slow-split.mp3
File type ID:   MPG3
Data format:     1 ch,  24000 Hz, .mp3 (0x00000000) 0 bits/channel, 0 bytes/packet, 576 frames/packet, 0 bytes/frame
estimated duration: 15.576000 sec
audio bytes: 93456
```

Each file also decoded in full to 16-bit WAV with `afconvert -f WAVE -d LEI16` (exit 0, output discarded). All three render the test sentence above; samples 2 and 3 render its five spans in order (requests listed below).

## V2: the exact SSML sent, and each rejection

Error text for both rejections (msedge-tts 2.1.1): `Stream closed before the synthesis completed (no turn.end received). The audio is likely truncated.`

### 1 as-is: accepted

```xml
<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="zh-TW"><voice name="zh-TW-HsiaoChenNeural"><prosody pitch="+0Hz" rate="-12%" volume="+0%">今天第一則是 Matt Pocock 示範怎麼用 mattpocock/skills 在一天內交付兩萬一千行的功能。</prosody></voice></speak>
```

### 2 lang: one request rejected

```xml
<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="zh-TW"><voice name="zh-TW-HsiaoChenNeural"><prosody pitch="+0Hz" rate="-12%" volume="+0%">今天第一則是 <lang xml:lang="en-US">Matt Pocock</lang> 示範怎麼用 <lang xml:lang="en-US">mattpocock/skills</lang> 在一天內交付兩萬一千行的功能。</prosody></voice></speak>
```

Split requests that made `sample-2-lang-split.mp3` (all accepted):

```xml
<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="zh-TW"><voice name="zh-TW-HsiaoChenNeural"><prosody pitch="+0Hz" rate="-12%" volume="+0%">今天第一則是</prosody></voice></speak>
<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="en-US"><voice name="en-US-AriaNeural"><prosody pitch="+0Hz" rate="-12%" volume="+0%">Matt Pocock</prosody></voice></speak>
<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="zh-TW"><voice name="zh-TW-HsiaoChenNeural"><prosody pitch="+0Hz" rate="-12%" volume="+0%">示範怎麼用</prosody></voice></speak>
<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="en-US"><voice name="en-US-AriaNeural"><prosody pitch="+0Hz" rate="-12%" volume="+0%">mattpocock/skills</prosody></voice></speak>
<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="zh-TW"><voice name="zh-TW-HsiaoChenNeural"><prosody pitch="+0Hz" rate="-12%" volume="+0%">在一天內交付兩萬一千行的功能。</prosody></voice></speak>
```

### 3 slow: one request rejected

```xml
<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="zh-TW"><voice name="zh-TW-HsiaoChenNeural"><prosody pitch="+0Hz" rate="-12%" volume="+0%">今天第一則是 <prosody rate="-35%">Matt Pocock</prosody> 示範怎麼用 <prosody rate="-35%">mattpocock/skills</prosody> 在一天內交付兩萬一千行的功能。</prosody></voice></speak>
```

Split requests that made `sample-3-slow-split.mp3` (all accepted):

```xml
<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="zh-TW"><voice name="zh-TW-HsiaoChenNeural"><prosody pitch="+0Hz" rate="-12%" volume="+0%">今天第一則是</prosody></voice></speak>
<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="zh-TW"><voice name="zh-TW-HsiaoChenNeural"><prosody pitch="+0Hz" rate="-35%" volume="+0%">Matt Pocock</prosody></voice></speak>
<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="zh-TW"><voice name="zh-TW-HsiaoChenNeural"><prosody pitch="+0Hz" rate="-12%" volume="+0%">示範怎麼用</prosody></voice></speak>
<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="zh-TW"><voice name="zh-TW-HsiaoChenNeural"><prosody pitch="+0Hz" rate="-35%" volume="+0%">mattpocock/skills</prosody></voice></speak>
<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="zh-TW"><voice name="zh-TW-HsiaoChenNeural"><prosody pitch="+0Hz" rate="-12%" volume="+0%">在一天內交付兩萬一千行的功能。</prosody></voice></speak>
```

### Other shapes probed by hand, same session, all rejected with the same error

Short text `今天 Matt Pocock 示範`, sent with `rawToStream`:

- `<lang xml:lang="en-US">` inside `<voice>` with no `<prosody>`.
- `<lang>` inside `<mstts:express-as style="general">`.
- Nested `<prosody rate="-35%">` and nested `<prosody rate="slow">`.
- Three sibling `<prosody>` elements inside one `<voice>` (no nesting).
- Three `<voice>` elements in one `<speak>` (zh-TW, `en-US-AriaNeural`, zh-TW).

Controls in the same session, all accepted: `Matt Pocock` alone in `en-US-AriaNeural`, in `en-US-AvaMultilingualNeural`, and in `zh-TW-HsiaoChenNeural` at `-35%`; `今天 Matt` in the template shape.

## For phase 2

- Option 1 needs no engine change.
- Options 2 and 3 need a split in the engine: cut each chunk at Latin-script spans, one Edge request per span, and join the audio. That multiplies requests per chunk (here 1 to 5) and changes the sentence-boundary offsets, which the engine then must shift by the length of the earlier parts.
- Option 2 mixes two speakers (HsiaoChen and Aria). Option 3 keeps one speaker.
