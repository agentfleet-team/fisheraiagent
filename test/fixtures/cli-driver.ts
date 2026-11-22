// Acceptance driver for Issue 21: runs the CLI entry (src/cli.ts main) with a
// stubbed caller in a real child process, so the test can check the actual
// stdout/stderr streams.
import { readFileSync } from 'node:fs';
import { main } from '../../src/cli.js';

const GOOD = readFileSync(new URL('./model-good.txt', import.meta.url), 'utf8');
process.exitCode = await main(process.argv[2], async () => ({ text: GOOD, status: 'completed' }));
