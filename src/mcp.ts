#!/usr/bin/env node
// Stdio MCP server (Issue 27): any MCP-capable runtime — Claude Code, Codex,
// Kiro, Devin, OpenAB bots — calls the single `get_transcript` tool and gets
// the same transcript JSON the CLI prints, or a fixed error code from the
// SafeText table. Gemini stays the only transcription engine and the caller's
// own GEMINI_API_KEY pays for it; the key is sent per call and never logged,
// stored or returned.
//
// Two modes, chosen by environment only:
//   remote — FISHERAIAGENT_URL (+ optional FISHERAIAGENT_TOKEN bearer): the
//     job is submitted and polled on that fisheraiagent HTTP service.
//   local — no URL set: the shared core runs in-process; CACHE_DIR,
//     GEMINI_MODEL, MAX_BLOCK_SECONDS and MAX_VIDEO_SECONDS apply and a
//     per-call max_block_seconds overrides the configured block length.
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { ApiError, createApiClient, type TranscriptApi } from './bot/api.js';
import { createCaptionReader, type CaptionReader } from './captions.js';
import { loadConfig } from './config.js';
import {
  codeOf,
  isFixedErrorCode,
  messageForCode,
  TranscriptError,
  type ErrorBody,
  type FixedErrorCode,
} from './errors.js';
import { createGeminiCaller, type GeminiCaller } from './gemini.js';
import { parseVideoId, type VideoId } from './ids.js';
import { createLogger, stderrSink, type LogFields, type LogSink } from './log.js';
import { transcribeYouTube } from './transcribe.js';
import type { Transcript } from './transcript.js';
import { parseYouTubeVideoId } from './youtube-url.js';

// Everything a test or an embedding driver can override: env for config, the
// caller for the in-process engine, the api client for remote mode, and the
// sink for allowlisted log lines.
export interface McpDeps {
  env?: NodeJS.ProcessEnv;
  caller?: GeminiCaller;
  // In-process caption read; tests inject a fake so they never touch the
  // network. Unset wires the real reader in local mode.
  captionReader?: CaptionReader;
  api?: TranscriptApi;
  fetchImpl?: typeof fetch;
  log?: LogSink;
}

interface RemoteConfig {
  baseUrl: string;
  serviceToken?: string;
}

interface ResolvedDeps {
  env: NodeJS.ProcessEnv;
  remote?: { api: TranscriptApi };
  caller?: GeminiCaller;
  captionReader?: CaptionReader;
  log: LogSink;
}

// A stdio server's stdout is the protocol channel, so every log line — this
// module's own events and the core's — goes to stderr.
const log = createLogger(stderrSink);

function packageVersion(): string {
  const pkg: { version?: string } = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  );
  return pkg.version ?? '0.0.0';
}

// Remote mode exists only when FISHERAIAGENT_URL is set; FISHERAIAGENT_TOKEN
// is the optional bearer for a service started with SERVICE_TOKEN.
function remoteConfig(env: NodeJS.ProcessEnv): RemoteConfig | undefined {
  const baseUrl = (env.FISHERAIAGENT_URL ?? '').trim();
  if (!baseUrl) return undefined;
  const serviceToken = (env.FISHERAIAGENT_TOKEN ?? '').trim();
  return serviceToken === '' ? { baseUrl } : { baseUrl, serviceToken };
}

// A branded VideoId for the log fields when the input parses; the remote path
// legitimately forwards an unparseable URL and lets the service reject it, so
// the field is simply absent then.
function tryVideoId(url: string): VideoId | undefined {
  try {
    return parseVideoId(parseYouTubeVideoId(url));
  } catch {
    return undefined;
  }
}

// One call = the remote job path or the in-process core path; both end in the
// same Transcript document and in the same fixed codes on failure.
async function getTranscript(
  url: string,
  maxBlockSeconds: number | undefined,
  deps: ResolvedDeps,
): Promise<Transcript> {
  if (
    maxBlockSeconds !== undefined &&
    (!Number.isFinite(maxBlockSeconds) || maxBlockSeconds <= 0)
  ) {
    throw new TranscriptError('invalid_request', 'max_block_seconds must be a positive number');
  }

  if (deps.remote !== undefined) {
    // The service validates the URL itself; the key leaves the process in the
    // X-Gemini-Key header of the submit request and nowhere else.
    const apiKey = (deps.env.GEMINI_API_KEY ?? '').trim();
    if (!apiKey) throw new TranscriptError('missing_key', 'GEMINI_API_KEY is not set');
    const outcome = await deps.remote.api.transcribe(url, apiKey);
    return outcome.transcript;
  }

  const config = loadConfig(deps.env);
  const videoId = parseYouTubeVideoId(url);
  return transcribeYouTube(videoId, {
    caller: deps.caller ?? createGeminiCaller({ apiKey: config.apiKey, model: config.model, log: deps.log }),
    model: config.model,
    maxBlockSeconds: maxBlockSeconds ?? config.maxBlockSeconds,
    cacheDir: config.cacheDir,
    defaultMaxVideoSeconds: config.maxVideoSeconds,
    captionReader: deps.captionReader ?? createCaptionReader(),
    log: deps.log,
  });
}

// Folds every failure — thrown TranscriptError, remote ApiError, anything
// else — into one fixed table code. Named like the other code mappers so the
// R-13 scan sees a closed union leaving this function, never caught text.
function errorCode(err: unknown): FixedErrorCode {
  if (err instanceof ApiError && isFixedErrorCode(err.code)) return err.code;
  return codeOf(err);
}

function okResult(transcript: Transcript): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(transcript, null, 2) }],
    structuredContent: { ...transcript },
  };
}

// The error result carries only a fixed code and its table message — the
// same ErrorBody shape the HTTP API returns — so no caught or upstream text
// can reach the calling agent through a tool result.
function errorResult(code: FixedErrorCode): CallToolResult {
  const body: ErrorBody = { error: { code, message: messageForCode(code) } };
  return { content: [{ type: 'text', text: JSON.stringify(body) }], isError: true };
}

export function createMcpServer(deps: McpDeps = {}): McpServer {
  const env = deps.env ?? process.env;
  const target = remoteConfig(env);
  const remote =
    target === undefined
      ? undefined
      : {
          api:
            deps.api ??
            createApiClient({
              baseUrl: target.baseUrl,
              serviceToken: target.serviceToken,
              fetchImpl: deps.fetchImpl,
            }),
        };
  const resolved: ResolvedDeps = {
    env,
    remote,
    caller: deps.caller,
    captionReader: deps.captionReader,
    log: deps.log ?? stderrSink,
  };

  const server = new McpServer({ name: 'fisheraiagent', version: packageVersion() });
  server.registerTool(
    'get_transcript',
    {
      title: 'Get YouTube transcript',
      description:
        "Return the full timed transcript of a YouTube video as the same JSON document the fisheraiagent CLI prints ({video_id, source_url, language, blocks[]}). Gemini is the transcription engine; the caller's own GEMINI_API_KEY is used for the call and is never logged, stored or returned. With FISHERAIAGENT_URL set the job runs on that fisheraiagent service; without it, transcription runs in-process (CACHE_DIR, GEMINI_MODEL, MAX_BLOCK_SECONDS apply). max_block_seconds applies only to the in-process mode. On failure the result is an error whose text is a fixed {\"error\":{\"code\",\"message\"}} document.",
      inputSchema: {
        url: z.string().describe('A YouTube watch/share URL or an 11-character video id.'),
        max_block_seconds: z
          .number()
          .optional()
          .describe('Maximum length of one transcript block in seconds (in-process mode only).'),
      },
    },
    async (args) => {
      const video = tryVideoId(args.url);
      const fields = (): LogFields => (video === undefined ? {} : { video });
      const startedAt = Date.now();
      log('job_submitted', fields());
      try {
        const transcript = await getTranscript(args.url, args.max_block_seconds, resolved);
        log('job_done', { ...fields(), durationMs: Date.now() - startedAt });
        return okResult(transcript);
      } catch (err) {
        const code = errorCode(err);
        log('job_failed', { ...fields(), code });
        return errorResult(code);
      }
    },
  );
  return server;
}

export async function main(deps: McpDeps = {}): Promise<void> {
  const server = createMcpServer(deps);
  await server.connect(new StdioServerTransport());
}

// Run only as the entry point; tests import main with injected deps.
if (process.argv[1] !== undefined && process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (err) {
    log('startup_failed', { code: codeOf(err) });
    process.exitCode = 1;
  }
}
