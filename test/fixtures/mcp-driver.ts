// Acceptance driver for Issue 27 M1: runs the MCP entry (src/mcp.ts main)
// with a stubbed in-process caller over real stdio, so the test can check the
// protocol stream end to end.
import { readFileSync } from 'node:fs';
import { main } from '../../src/mcp.js';

const GOOD = readFileSync(new URL('./model-good.txt', import.meta.url), 'utf8');
await main({
  caller: async (req) => ({
    text: (req.startOffsetSeconds ?? 0) > 0 ? 'LANGUAGE: en' : GOOD,
    status: 'completed',
  }),
  captionReader: async () => ({ kind: 'none' }),
});
