## 5. Findings for RFC-3 (written by the builder)

Cloud workflow runs (artifact `spike/selection/results/`): GHA_RUN_URLS

- **Keyless search from the cloud:** GHA_OK/N of the search calls on `ubuntu-latest` succeeded; 18/18 Mac calls succeeded (2 runs, ~11 min apart, residential IP). GHA_BLOCK_NOTE
- **Fields without a second call:** at `--playlist-end 20`, every flat entry carried `id`, `title`, `channel`, `duration`, `view_count` (360/360 on Mac); no flat entry carried `upload_date`/`timestamp`. A quality bar can gate on duration and views at search time; date, follower count and caption languages need the second call per candidate.
- **Cost of the second call:** ~1.1 s median per search call vs ~1.3 s median per full-metadata call on the Mac. Probing all 20 hits of a query costs ~26 s; the ticket's top-3 probe costs ~4 s per query, ~36 s for the whole nightly set.
- **`ytsearchdate` is gone:** the ticket named `ytsearchdate20:`; `YoutubeSearchDateIE` no longer exists in yt-dlp 2026.11.23 (`Unsupported url scheme`). `https://www.youtube.com/results?search_query=<q>&sp=EgIQAQ==` gives the same upload-date ordering through the same flat-playlist path.
- **Date sort is not strict:** rank-1 hits include videos 46-597 days old, and re-ordering between two runs 10 min apart shows YouTube mixes older "relevant" videos into the date sort. Freshness must be enforced by the second call's `upload_date`, not assumed from rank; probing deeper than top 3 is cheap and probably needed.
- **Nightly supply (Mac, probed top-3 per query, deduped over 2 runs):** <=7 days in the 8-90 min band — 0-1 video per topic; <=30 days — 1-3 per topic. From the top-3 probes alone, a strict "fresh this week" bar is marginal; <=30d or a deeper probe (candidates 4-20 carry no dates, so they need probing) is where the supply is.
- **Caption presence (Mac, 54 probed):** `en` track on 39/54, `zh*` on 47/54 (almost all via `automatic_captions`, e.g. `zh-Hans`/`zh-Hant` ASR), 5/54 have neither — the presence check works on the metadata call, no caption download needed.

RFC-2 note: GHA_SELECT_NOTE
