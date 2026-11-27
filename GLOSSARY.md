# YouTube transcript

One YouTube URL in, a full timed transcript out, saved and delivered per tenant.

## Language

**Transcript**:
The timed text of one video, as ordered blocks, each with a start, an end and text.
_Avoid_: subtitles, captions (for the output)

**Block**:
One timed piece of a transcript, no longer than the configured block length.
_Avoid_: segment, line, cue (for the output)

**Caption track**:
A timed text track YouTube holds for a video, in one language and of one kind.
_Avoid_: subtitle file, transcript (for the input)

**Cue**:
One timed entry inside a caption track.
_Avoid_: block (for the input)

**Manual track**:
A caption track a person uploaded or edited.
_Avoid_: human captions, official subtitles

**Auto track**:
A caption track made by YouTube's speech recognition from the video's audio.
_Avoid_: ASR captions, generated subtitles

**Translated track**:
A caption track YouTube derived from another track in a different language.
_Avoid_: auto-translate captions

**Spoken language**:
The language of the video's audio.
_Avoid_: video language, default language

**Transcript source**:
How a transcript was made: from a manual track, from an auto track, or by Gemini.
_Avoid_: method, origin

**Caption reader**:
The tool that reads a video's caption tracks for the service.
_Avoid_: caption proxy, caption service

**Window**:
One clipped stretch of the video that Gemini transcribes apart from the others; it can take more than one call.
_Avoid_: chunk, part

**Tenant**:
A configured caller group with its own destination, credentials and limits.
_Avoid_: customer, account
