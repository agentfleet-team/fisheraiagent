// Issue 27 acceptance: the stdio MCP server exposes exactly one
// get_transcript tool to any MCP client; M1 runs it in-process with a stubbed
// caller, M2 runs it in remote mode against the real HTTP service with a
// stubbed Gemini caller behind it.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { GeminiVideoRequest } from '../src/gemini.js';
import { createService, type ServiceOptions } from '../src/service.js';

const GOOD = readFileSync(new URL('./fixtures/model-good.txt', import.meta.url), 'utf8');
const ROOT = join(import.meta.dirname, '..');
const DRIVER = join(ROOT, 'test', 'fixtures', 'mcp-driver.ts');
const MCP_ENTRY = join(ROOT, 'src', 'mcp.ts');
const VIDEO_URL = 'https://www.youtube.com/watch?v=hWe-j78vNpc';
const VIDEO_B_URL = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
const VIDEO_B_ID = 'dQw4w9WgXcQ';
const VIDEO_ID = 'hWe-j78vNpc';
const CANARY = 'CANARY-UPSTREAM-TEXT-9f8e7d6c';
const KEY = 'TEST-KEY-ALPHA-x9x9x9';
const TOKEN = 'test-service-token-123';

interface McpClient {
  client: Client;
  stderrText: () => string;
  close: () => Promise<void>;
}

// Spawn a real MCP server process over stdio with the official SDK client;
// stderr is piped so tests can assert no upstream text reaches a log line.
async function connectMcp(args: string[], env: Record<string, string>): Promise<McpClient> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args,
    env: { ...process.env, ...env } as Record<string, string>,
    cwd: ROOT,
    stderr: 'pipe',
  });
  const chunks: Buffer[] = [];
  transport.stderr?.on('data', (chunk: Buffer) => chunks.push(chunk));
  const client = new Client({ name: 'mcp-acceptance-client', version: '0.0.0' });
  await client.connect(transport);
  return {
    client,
    stderrText: () => Buffer.concat(chunks).toString('utf8'),
    close: async () => {
      await client.close();
      await transport.close();
    },
  };
}

type ToolResult = Awaited<ReturnType<Client['callTool']>>;

function resultText(result: ToolResult): string {
  const item = result.content[0];
  assert.ok(item !== undefined && item.type === 'text');
  return item.text;
}

function resultErrorCode(result: ToolResult): string {
  assert.equal(result.isError, true);
  const body = JSON.parse(resultText(result)) as { error?: { code?: string } };
  return body.error?.code ?? '';
}

interface GeminiCall {
  apiKey: string;
  req: GeminiVideoRequest;
}

interface RunningService {
  base: string;
  logs: string[];
  close: () => Promise<void>;
}

// The real job API on a loopback port; the Gemini caller is stubbed and
// throws a canary text for VIDEO_B so the test can prove upstream text never
// reaches a tool result or a log line.
async function startService(
  calls: GeminiCall[],
  overrides: Partial<ServiceOptions> = {},
): Promise<RunningService> {
  const logs: string[] = [];
  const server: Server = createService({
    callerFactory: (apiKey) => async (req) => {
      calls.push({ apiKey, req });
      if (req.videoUrl.includes(VIDEO_B_ID)) throw new Error(CANARY);
      return {
        text: (req.startOffsetSeconds ?? 0) > 0 ? 'LANGUAGE: en' : GOOD,
        status: 'completed',
      };
    },
    model: 'test-model',
    maxBlockSeconds: 8,
    cacheDir: mkdtempSync(join(tmpdir(), 'fa-mcp-svc-cache-')),
    log: (line) => logs.push(line),
    ...overrides,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    logs,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test('M1: a stdio client lists exactly one tool with a JSON schema; the call returns the transcript JSON', async () => {
  const mcp = await connectMcp(['--import', 'tsx', DRIVER], {
    FISHERAIAGENT_URL: '',
    GEMINI_API_KEY: KEY,
    GEMINI_MODEL: 'test-model',
    CACHE_DIR: mkdtempSync(join(tmpdir(), 'fa-mcp-cache-')),
  });
  try {
    const { tools } = await mcp.client.listTools();
    assert.equal(tools.length, 1);
    const tool = tools[0];
    assert.equal(tool.name, 'get_transcript');
    const schema = tool.inputSchema as {
      type?: string;
      properties?: Record<string, { type?: string }>;
      required?: string[];
    };
    assert.equal(schema.type, 'object');
    assert.equal(schema.properties?.url?.type, 'string');
    assert.equal(schema.properties?.max_block_seconds?.type, 'number');
    assert.deepEqual(schema.required, ['url']);

    const result = await mcp.client.callTool({
      name: 'get_transcript',
      arguments: { url: VIDEO_URL },
    });
    assert.ok(!result.isError);
    const doc = JSON.parse(resultText(result)) as {
      video_id?: string;
      source_url?: string;
      language?: string;
      blocks?: { start: number; end: number; text: string }[];
    };
    assert.equal(doc.video_id, VIDEO_ID);
    assert.equal(doc.language, 'en');
    assert.equal(doc.blocks?.length, 5);
  } finally {
    await mcp.close();
  }
});

test('M2: remote mode submits and polls the HTTP service; missing key -> missing_key; upstream canary text never appears', async () => {
  const calls: GeminiCall[] = [];
  const svc = await startService(calls, { serviceToken: TOKEN });
  try {
    const mcp = await connectMcp(['--import', 'tsx', MCP_ENTRY], {
      FISHERAIAGENT_URL: svc.base,
      FISHERAIAGENT_TOKEN: TOKEN,
      GEMINI_API_KEY: KEY,
    });
    try {
      const ok = await mcp.client.callTool({
        name: 'get_transcript',
        arguments: { url: VIDEO_URL },
      });
      assert.ok(!ok.isError);
      const doc = JSON.parse(resultText(ok)) as { video_id?: string; blocks?: unknown[] };
      assert.equal(doc.video_id, VIDEO_ID);
      assert.equal(doc.blocks?.length, 5);
      // The caller's key reached the service only as X-Gemini-Key.
      assert.ok(calls.length > 0);
      assert.ok(calls.every((call) => call.apiKey === KEY));

      const failed = await mcp.client.callTool({
        name: 'get_transcript',
        arguments: { url: VIDEO_B_URL },
      });
      assert.equal(resultErrorCode(failed), 'internal_error');
      assert.ok(!resultText(failed).includes(CANARY));
    } finally {
      await mcp.close();
    }
    assert.ok(!mcp.stderrText().includes(CANARY));
    assert.ok(!svc.logs.join('\n').includes(CANARY));

    // Missing key: the fixed missing_key code comes back without any job.
    const callsBefore = calls.length;
    const noKey = await connectMcp(['--import', 'tsx', MCP_ENTRY], {
      FISHERAIAGENT_URL: svc.base,
      FISHERAIAGENT_TOKEN: TOKEN,
      GEMINI_API_KEY: '',
    });
    try {
      const res = await noKey.client.callTool({
        name: 'get_transcript',
        arguments: { url: VIDEO_URL },
      });
      assert.equal(resultErrorCode(res), 'missing_key');
      assert.equal(calls.length, callsBefore);
    } finally {
      await noKey.close();
    }
  } finally {
    await svc.close();
  }
});
