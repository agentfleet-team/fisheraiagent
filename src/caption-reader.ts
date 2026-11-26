#!/usr/bin/env node
// Entry point of the caption-reader tool (agentfleet-team/fisheraiagent#78).
// Env: CAPTION_READER_TOKEN (required), CAPTION_READER_MAX_CONCURRENT
// (default 4), CAPTION_READER_RECEIPT_DIR (default ./receipts), PORT
// (default 8090). A startup failure prints one stderr line and exits 1; no
// line ever carries the token.
import { createCaptionReader } from './captions.js';
import { createCaptionReaderServer } from './caption-reader-service.js';

function startupFailed(message: string): never {
  process.stderr.write(`caption-reader: ${message}\n`);
  process.exit(1);
}

function positiveInt(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) startupFailed(`${name} must be a positive integer`);
  return value;
}

const token = process.env.CAPTION_READER_TOKEN;
if (token === undefined || token === '') startupFailed('CAPTION_READER_TOKEN is required');

const port = positiveInt('PORT', process.env.PORT, 8090);
let server;
try {
  server = createCaptionReaderServer({
    token,
    reader: createCaptionReader(),
    maxConcurrent: positiveInt('CAPTION_READER_MAX_CONCURRENT', process.env.CAPTION_READER_MAX_CONCURRENT, 4),
    receiptDir: process.env.CAPTION_READER_RECEIPT_DIR?.trim() || './receipts',
  });
} catch {
  startupFailed('cannot create the receipt directory');
}
server.listen(port, () => {
  process.stdout.write(`caption-reader: listening on ${port}\n`);
});
