---
status: proposed
---

# Read YouTube captions before calling Gemini

Until now the service never contacted YouTube. Gemini fetched each video by URL, and that is why the service runs unchanged from an AWS Fargate IP. We decide that the service reads the video's caption tracks first. A manual track in the spoken language becomes the transcript with no Gemini call. Every other case, including any failed read, falls back to Gemini (agentfleet-team/fisheraiagent#65). The reason is speed and cost: Gemini runs one call per 120 s window, in series, for words that already exist.

## Considered Options

- **Gemini only (today).** No YouTube dependency, but slow and paid for captioned videos.
- **Captions first, Gemini fallback (chosen).** Fast and free when captions exist. It adds a direct YouTube dependency that YouTube can gate (PO tokens on caption URLs, bot checks for datacenter IPs).
- **Parallel Gemini windows.** Cuts wall time for every video with no YouTube call. It is complementary, not a replacement, and is tracked as its own proposal (#71).

## Consequences

- The YouTube-specific code lives behind one reader module with one call. A read failure returns a reason and never fails the job.
- The spoken language comes from YouTube's original speech-recognition track. No language list exists anywhere.
- This ADR moves to `accepted` only after the prototype (#66) and the AWS-network probe (#67) show that captions can be read from the hosted service. If they are blocked there, this ADR is superseded.
