---
status: accepted
---

# Read YouTube captions before calling Gemini, through a reader on the Mac mini

Until #76 the service never contacted YouTube. Gemini fetched each video by URL, which is why the service runs from an AWS Fargate IP. We now decide that a manual caption track in the spoken language becomes the transcript, with no Gemini call (agentfleet-team/fisheraiagent#65). Every other case still goes to Gemini with the URL. The reason is speed and cost: Gemini runs one call per 120 s window, in series, for words that already exist.

The caption read does not run in the hosted service. From the AWS egress, YouTube's bot check (`LOGIN_REQUIRED`) blocked 2 of 3 reads (#67). From the Mac mini (residential IP) every read worked (#66). So the read is a small reader tool on the Mac mini, in an OrbStack container (#78). The service calls it through a Cloudflare tunnel with a short timeout (#80). Gemini takes over when there are no captions or the reader is unreachable. The reader has its own tunnel whose only connector is on the Mac mini. Sharing `agentfleet-tools` would spread every hostname across the AWS and Mac mini connectors. Only our own services reach it: a Cloudflare Access service token at the edge and a bearer token in the app (owner ruling 2026-11-27).

## Considered Options

- **Gemini only (before #76).** No YouTube dependency, but slow and paid for captioned videos.
- **Service reads captions from AWS.** Refuted by #67: the bot check blocks ordinary videos.
- **Caller-supplied captions.** Each caller on the Mac mini reads the track and sends it with the job. Not chosen: every caller needs the reader, and the web page gets nothing.
- **Reader tool on the Mac mini, called by the service through its own tunnel (chosen, owner ruling A).** One reader serves every caller, the web page included. The cost is an uptime dependency on the Mac mini, and the Gemini fallback covers it.
- **Parallel Gemini windows.** This one complements the others and does not replace any. It is tracked as its own proposal (#71).

## Consequences

- The YouTube-specific code lives behind one reader module with one call. A read failure returns a reason and never fails the job.
- The spoken language comes from YouTube's original speech-recognition track. A video with no such track stays on Gemini, because no player field proves its language and a lone manual track can be a translation (#76 verdicts). #79 checks whether another field can prove it. No language list exists anywhere.
- The service's N2 mode is off by default (no YouTube call). It is remote when `CAPTIONS_READER_URL` is set, and local for a self-hoster on a residential IP.
