---
status: accepted
---

# Read YouTube captions before calling Gemini, through a reader on the Mac mini

Before #76 the service never contacted YouTube. Gemini read each video from its URL, one clipped window at a time (120 s by default), and the windows ran in sequence. A window can need more than one call. We decide that a caption track in the spoken language becomes the transcript with no Gemini call (agentfleet-team/fisheraiagent#65). Speed and cost drive this: the words already exist, and the window loop is sequential.

Which tracks count is a per-tenant policy (#93). `manual` (the default) accepts a manual track in the spoken language. `manual-or-auto` also accepts the spoken-language speech-recognition track. `off` skips the read. Any other result, and any failed read, goes to Gemini with the URL as before.

The read does not run in the hosted service. From the AWS egress, YouTube's bot check (`LOGIN_REQUIRED`) blocked 2 of 3 reads (#67). From the Mac mini (residential IP) the same reads worked (#66, #73). The read is therefore a separate caption reader on the Mac mini, in an OrbStack container (#86). The service calls it over HTTPS with a short timeout and falls back to Gemini when the reader is unreachable or refuses (#87). Only our own services may call it: a Cloudflare Access service token at the edge and a bearer token in the app (owner ruling 2026-11-27, spec amendment r4 on #65). With no reader configured, the service makes no YouTube call.

**Pending owner confirmation.** The reader is planned on its own Cloudflare tunnel, whose only connector runs on the Mac mini (fisherivco/dotfiles#446). The earlier owner ruling was one shared tunnel for AgentFleet tools, and the 2026-11-27 ruling named the existing tunnel. A Mac mini connector on that shared tunnel would also receive the transcript hostname's traffic. The choice is open on #65 (options A/B/C) and is not run until Allen answers.

## Considered Options

- **Gemini only (before #76).** No YouTube dependency, but sequential windows and a paid call for words that already exist.
- **Service reads captions from AWS.** Refuted by #67.
- **Caller-supplied captions.** Each Mac mini caller reads the track and sends it with the job. Not chosen: every caller would need the reader, and the web page would gain nothing.
- **Reader on the Mac mini, called by the service (chosen, owner ruling A).** One reader serves every caller, the web page included. The cost is an uptime dependency on the Mac mini, which the Gemini fallback covers.
- **Parallel Gemini windows.** This is complementary and is tracked as its own proposal (#71).

## Consequences

- The YouTube-specific code sits behind one reader module (#76) with one call. A failed read returns a reason and never fails the job.
- The spoken language comes from the original speech-recognition track. A video without one stays on Gemini. In the tested player responses no field proved the language: a lone manual track can be a translation (#76 verdicts), and `captionTrackIndices` lists every track in an order that can change with `hl`. Both counterexamples picked an English translation (#79, #81, REFUTED). The track selector holds no language list.
- The morning-podcast job uses the same reader through the CLI `transcribe captions` (#90), so there is one reader.
