/**
 * Live probe for the pool node (S6): one
 * run of the search + parser against the live results page, from this
 * machine, printing the parsed entry count per topic. Read-only.
 *
 *   npm run probe
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseConfig } from "../config.js";
import { fetchResultsPage } from "./search.js";

const appDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const parsed = parseConfig(
  readFileSync(join(appDir, "fixtures", "config.json"), "utf8"),
);
if (!parsed.ok) {
  console.error(`config fixture: ${parsed.error}`);
  process.exit(1);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
for (const topic of parsed.config.topics) {
  const seen = new Set<string>();
  const perQuery: string[] = [];
  for (const query of topic.queries) {
    // A burst of nine page fetches can trip YouTube's rate limiter;
    // retry with a growing pause before counting the query failed.
    let result = await fetchResultsPage(query, "week");
    for (const pause of [5000, 15000]) {
      if (result.ok) break;
      await sleep(pause);
      result = await fetchResultsPage(query, "week");
    }
    if (!result.ok) {
      failures += 1;
      perQuery.push(`"${query}" ERR ${result.error}`);
    } else {
      for (const entry of result.entries) seen.add(entry.id);
      perQuery.push(`"${query}" ${result.entries.length}`);
    }
    await sleep(2000);
  }
  console.log(
    `slot ${topic.slot} ${topic.name}: ${seen.size} unique (${perQuery.join(", ")})`,
  );
}
process.exit(failures > 0 ? 1 : 0);
