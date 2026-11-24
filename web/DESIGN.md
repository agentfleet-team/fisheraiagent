# DESIGN: transcripts.agentfleet.team

The page turns one YouTube link into a timed transcript. It is an open-source
tool page and a client demo, so it must look designed and AgentFleet-branded.
Its function does not change.

## Brief and mode

- **Surface:** the single home page of the transcript service (`web/`).
- **Mode:** Operate. The visitor completes one task: paste a link, read or
  download the result. Scanability and the usage scene outrank expression;
  the brand lives in precise details.
- **Brand pins:** identity 2026.10.22.1, "Inner compass" (owner-selected C),
  palette navy `#0b2d50`, coral `#ee886f`, ivory `#f5f5ef`. Source record:
  `apps/agentfleet/brand/releases/2026.10.22.1.json` in fisherivco/allen-ai-os.
- **Family resemblance:** the same navy-led palette and mark as the AgentFleet
  sites. The sibling site's type was not audited in this pass.

## Brand asset

- `web/brand/agentfleet-mark.svg` is a byte copy of
  `apps/agentfleet/showcase/salmon/identity-studies/v1/inner-compass.svg`
  at source commit `dddcec7629bcb2aaf231ae3cd08611c649620153`.
- SHA-256 `983b6b106b257d00512dce28cc9b24b7ec1357e18a9f086dd9935c7b615afda0`,
  equal to the record's `assets.svg.sha256`.
- Its navy body needs a light ground, so the header sets it on an ivory tile.

## Decisions

1. **Navy ground, not cream.** Ivory is the brand's text and tile colour.
   The page ground is navy. An ivory page ground was flagged by the impeccable
   detector as the "cream palette" tell, and the navy ground is the brand's
   strongest surface anyway.
2. **One accent, one action.** Coral marks the single primary action
   (Transcribe, Save) and the timestamps. Nothing else uses it.
3. **Serif display, system sans body.** The display face sets the title and
   the settings heading. Body and controls use the system sans, so no font
   files are shipped. CJK fallbacks (`PingFang TC`, `Noto Sans TC`) keep the
   zh-TW text in the same voice.
4. **The field is the page.** The URL input and the action share one bordered
   field. The field gets a border change on focus, not a glow.
5. **Results read like a transcript.** Timestamps sit in a fixed gutter with
   tabular numerals. Rows are hairline-separated; nothing is carded.
6. **One motion moment.** The transcript rises once when it renders. It is
   removed under `prefers-reduced-motion`.
7. **Errors are tinted and edged.** An error keeps the words and gains a
   tint and a coral edge, so meaning does not rest on colour alone.
8. **No hard-coded language.** `app.js` sets `lang` from the browser and
   switches the strings. The static `lang="en"` is only the fallback.
9. **No decoration.** No gradient text, no glass, no one-sided borders, no
   eyebrows, no numbered steps, no arrow glyphs, no emoji.

## Tokens

| Token | Value | Use |
|---|---|---|
| `--navy` | `#0b2d50` | page ground, primary ink on coral |
| `--ivory` | `#f5f5ef` | body text, header tile, focus ring |
| `--coral` | `#ee886f` | primary action, timestamps, spinner, edges |
| `--navy-raised` | `#113657` | the input field, settings button |
| `--navy-drawer` | `#0f3358` | settings panel |
| `--navy-line` | `#24476b` | hairlines and dividers |
| `--navy-edge` | `#5d7a96` | control borders |
| `--ink-2` | `#a9bccd` | secondary text, placeholder, hints |
| `--error-ground` | `#2f3c55` | error and key-state tint |

Contrast, measured as WCAG ratios:

| Pair | Ratio | Needed |
|---|---|---|
| ivory on navy | 12.75 | 4.5 |
| secondary `#a9bccd` on navy | 7.15 | 4.5 |
| navy on coral (primary button) | 5.57 | 4.5 |
| coral on navy (timestamps) | 5.57 | 4.5 |
| ivory on error ground | 10.11 | 4.5 |
| `--navy-edge` on navy (control border) | 3.12 | 3 |

## Type scale

- Title: display serif, 500, `clamp(2.5rem, 1.7rem + 3.2vw, 4rem)`,
  line-height 1.02, tracking −0.025em.
- Settings heading: display serif, 1.75rem.
- Tagline: 1.125rem, measure about 34ch.
- Body: 1rem / 1.6. Controls: 0.9375rem.
- Timestamps: 0.875rem, tabular numerals.

## States

Each state was captured at 1280 and 390 px, before and after the redesign, in
`test/web/screenshots/design-review/`: empty, loading (job queued), result,
error (video unavailable), and the settings panel with a verified key.
No state scrolls sideways at 390 px.

## Constraints kept

- The DOM ids and `data-i18n` keys that `app.js` and the browser tests use are
  unchanged. `app.js` is not edited.
- The asset URLs keep the `?v=<commit>` stamping. The page stays a static
  file under `web/`.
- The `<h1>` text is only the title, so the test's text checks still hold.
- The settings button no longer carries a text gear glyph; it uses a drawn
  SVG icon.

## Not done in this pass

- No impeccable new-world roll. The `concept-seed` script is not shipped in the
  hub copy. The direction is set by the brand pins above, which fix the world.
- No font files and no PRODUCT.md. Both need a reviewed owner step.
- No deploy. Deployment is a separate owner-approved step.

## Verification

- `npm run build`, `npm test` and `npm run test:web` pass with no test edits.
- `npm run check:design` exits 0 with zero findings on `web/`.
- The CI design step is a gate: exit 2 fails the job.
