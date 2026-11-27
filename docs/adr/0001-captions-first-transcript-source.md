---
status: accepted
---

# Read YouTube captions before calling Gemini, through a reader on the Mac mini

Before #76 the service never contacted YouTube. Gemini read each video from its URL, one clipped window at a time (120 s by default), and the windows ran in sequence. A window can need more than one call. We decide that a caption track in the spoken language becomes the transcript with no Gemini call (agentfleet-team/fisheraiagent#65). Speed and cost drive this: the words already exist, and the window loop is sequential.

Which tracks count is a per-tenant policy (#93). `manual` (the default) accepts a manual track in the spoken language. `manual-or-auto` also accepts the spoken-language speech-recognition track. `off` skips the read. Any other result, and any failed read, goes to Gemini with the URL as before.

The read does not run in the hosted service. From the AWS egress, YouTube's bot check (`LOGIN_REQUIRED`) blocked 2 of 3 reads (#67). From the Mac mini (residential IP) the same reads worked (#66, #73). The read is therefore a separate caption reader on the Mac mini, in an OrbStack container (#86). The service calls it over HTTPS with a short timeout and falls back to Gemini when the reader is unreachable or refuses (#87). Only our own services may call it: a Cloudflare Access service token at the edge and a bearer token in the app (owner ruling 2026-11-27, spec amendment r4 on #65). With no reader configured, the service makes no YouTube call.

**Tunnel (owner ruling 2026-11-27 10:1x Taipei, option A on #65).** The reader gets its own Cloudflare tunnel, `agentfleet-mac`, with its only connector on the Mac mini. The owner step that creates it is fisherivco/dotfiles#446; the name was changed before the first run (fisherivco/dotfiles#448, PR #449). The tunnel exists only after Allen runs that step. It is the one channel for cloud services to reach HTTP tools on the Mac mini. AWS-hosted tools stay on the shared tunnel `agentfleet-tools`, so a Mac mini connector never receives the transcript hostname's traffic. ChatGPT reaches the Mac mini through the OpenAI Secure MCP Tunnel, and Tailscale is for administration only (fisherivco/allen-ai-os `docs/runbooks/dot-surface-inventory.md`). The reader stays an optional adapter, off by default with the Gemini fallback, so a later commercial version can drop it with no architecture change.

## Considered Options

- **Gemini only (before #76).** No YouTube dependency, but sequential windows and a paid call for words that already exist.
- **Service reads captions from AWS.** Refuted by #67.
- **Caller-supplied captions.** Each Mac mini caller reads the track and sends it with the job. Not chosen: every caller would need the reader, and the web page would gain nothing.
- **Reader on the Mac mini, called by the service (chosen, owner ruling A).** One reader serves every caller, the web page included. The cost is an uptime dependency on the Mac mini, which the Gemini fallback covers.
- **Other channels to the Mac mini (not chosen, #65 comment 7207884306).** A Mac mini connector on the shared `agentfleet-tools` tunnel would also get a share of the transcript hostname's traffic. The OpenAI Secure MCP Tunnel serves ChatGPT only. A Tailscale sidecar in the cloud task would put own-use infrastructure into the service and cannot serve Cloudflare Workers. The Tailscale tailnet stays for administration only. The Tailscale Funnel route (`allen-mac`) is retired (removed 2026-11-26, fisherivco/allen-ai-os#1838) and is not an option.
- **Parallel Gemini windows.** This is complementary and is tracked as its own proposal (#71).

## Consequences

- The YouTube-specific code sits behind one reader module (#76) with one call. A failed read returns a reason and never fails the job.
- The spoken language comes from the original speech-recognition track. A video without one stays on Gemini. In the tested player responses no field proved the language: a lone manual track can be a translation (#76 verdicts), and `captionTrackIndices` lists every track in an order that can change with `hl`. Both counterexamples picked an English translation (#79, #81, REFUTED). The track selector holds no language list.
- The morning-podcast job uses the same reader through the CLI `transcribe captions` (#90), so there is one reader.
