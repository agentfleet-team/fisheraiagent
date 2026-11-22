# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/). Releases are `vMAJOR.MINOR.PATCH`
git tags on `main`.

## [Unreleased]

## [0.1.0] - 2026-11-23

First release: the build the owner accepted live on 2026-11-23 (`011b768`)
plus the follow-ups merged since. Deployed at https://transcripts.agentfleet.team
as a public page (bring your own Gemini key).

### Added

- Web page key check on Save: the page calls Gemini's `models.get` directly
  from the browser for the model the service runs; the key never reaches the
  service (#42).
- Per-client job limits on the anonymous `/v1` surface: at most 2 in-flight
  jobs and 20 accepted submissions per client per sliding hour, keyed on
  `CF-Connecting-IP` from trusted proxies (#43).
- `GET /v1/config` reports `version` and `commit`, baked in at image build
  time; the web page footer shows them so a bug report can name the exact
  build (#46).

### Changed

- Transcription runs in clipped 120-second windows (`videoMetadata`
  start/end offsets); block times re-anchor per window so timestamp drift
  cannot cross a window boundary (#17).
- An over-limit transcript block no longer fails its whole window: its
  range is re-asked as a short sub-clip, and if that still fails the
  original block is kept and logged (#33, #37).
- The window loop is bounded at 12 hours (YouTube's maximum upload length)
  when no per-tenant cap applies (#34).
- A full-length window whose answer carries no usable blocks no longer ends
  the video — only a completed answer counts as end-of-video evidence (#40).

### Migration notes

- Transcript cache format version is now 4 (bumped whenever prompt or
  parser behavior changes); cache entries written by earlier builds are
  ignored and transcripts are regenerated (#32).
- The AWS task definition no longer pins `WINDOW_SECONDS`; the single
  default lives in `src/config.ts` (#32).
- The Docker image accepts `--build-arg APP_VERSION=<tag>` and
  `--build-arg APP_COMMIT=<sha>`; release images should set both so the
  deployed build reports its identity (#46).

[Unreleased]: https://github.com/agentfleet-team/fisheraiagent/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/agentfleet-team/fisheraiagent/releases/tag/v0.1.0
