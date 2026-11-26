---
status: accepted
---

# Read YouTube captions before calling Gemini, on the caller's host

Until #76 the service never contacted YouTube. Gemini fetched each video by URL, which is why the service runs from an AWS Fargate IP. We now decide that a manual caption track in the spoken language becomes the transcript, with no Gemini call (agentfleet-team/fisheraiagent#65). Every other case still goes to Gemini with the URL. The reason is speed and cost: Gemini runs one call per 120 s window, in series, for words that already exist.

The caption read runs **on the caller's host**, not in the hosted service. From the AWS egress, YouTube's bot check (`LOGIN_REQUIRED`) blocked 2 of 3 reads (#67). From the Mac mini (residential IP) every read worked (#66). So a verified tenant caller reads the track itself and supplies it with the job (#78). The hosted service's own read is off by default (`CAPTIONS_READ=off`).

## Considered Options

- **Gemini only (before #76).** No YouTube dependency, but slow and paid for captioned videos.
- **Service reads captions from AWS.** Refuted by #67: the bot check blocks ordinary videos.
- **Caption proxy on the Mac mini, called by the service.** Rejected: it adds a public endpoint on the home IP and an uptime dependency.
- **Caller-supplied captions (chosen).** The callers that matter (the mini-* bots and the morning-podcast scheduler) already run on the Mac mini. The anonymous web page keeps the Gemini path.
- **Parallel Gemini windows.** This one complements the others and does not replace any. It is tracked as its own proposal (#71).

## Consequences

- The YouTube-specific code lives behind one reader module with one call. A read failure returns a reason and never fails the job.
- The spoken language comes from YouTube's original speech-recognition track. A video with no such track stays on Gemini, because no player field proves its language and a lone manual track can be a translation (#76 verdicts). #79 checks whether another field can prove it. No language list exists anywhere.
- A supplied read is a claim, like `origin`. Only a verified tenant caller may supply one, and it changes only that tenant's own job.
