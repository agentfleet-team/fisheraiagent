// Shared test doubles for the hosted-instance tests: a Drive store that
// records files in memory, and an offline OpenID provider that serves
// discovery, the authorize redirect, code exchange and a JWKS — with a real
// RSA signature the service must verify. No network, no credentials.
import { generateKeyPairSync, createHash, createSign, type JsonWebKey } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { DriveStore } from '../src/drive.js';

export interface FakeStored {
  id: string;
  folder: string;
  name: string;
  content: string;
  url: string;
  props: Record<string, string>;
}

export class FakeDrive implements DriveStore {
  readonly files: FakeStored[] = [];
  private seq = 0;

  filesIn(folder: string): FakeStored[] {
    return this.files.filter((f) => f.folder === folder);
  }

  async findFileByVideoId(folderId: string, videoId: string) {
    return this.filesIn(folderId).find((f) => f.props.videoId === videoId) ?? null;
  }

  async createFile(
    folderId: string,
    name: string,
    content: string,
    _mimeType?: string,
    appProperties: Record<string, string> = {},
  ) {
    const file: FakeStored = {
      id: `fake-drive-${++this.seq}`,
      folder: folderId,
      name,
      content,
      url: `https://drive.google.com/file/d/fake-drive-${this.seq}/view`,
      props: appProperties,
    };
    this.files.push(file);
    return { id: file.id, name, url: file.url };
  }

  async updateFile(fileId: string, content: string, _mimeType?: string) {
    const file = this.files.find((f) => f.id === fileId);
    if (!file) throw new Error(`no such file ${fileId}`);
    file.content = content;
    return { id: file.id, name: file.name, url: file.url };
  }
}

// A minimal OIDC provider: discovery doc, an /authorize that records the
// PKCE challenge and 302s back like a real consent redirect, a /token that
// verifies the code_verifier against that challenge, and a /jwks serving
// the public half of a generated RSA key. id_token is signed for real.
export class FakeOidcProvider {
  issuer = '';
  email = 'alice@example.com';
  readonly clientId = 'test-client';
  readonly clientSecret = 'test-secret';
  readonly expectedCode = 'fake-auth-code';
  // What the provider recorded from /authorize and /token — assertions can
  // check that PKCE actually ran.
  seenChallenge = '';
  seenState = '';
  seenNonce = '';
  seenVerifier = '';
  tokenCalls = 0;

  private server?: Server;
  private readonly privateKey: string;
  private readonly jwk: JsonWebKey;

  constructor() {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    this.privateKey = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
    const jwk = publicKey.export({ format: 'jwk' });
    this.jwk = { kty: 'RSA', n: jwk.n, e: jwk.e, kid: 'fake-key-1' };
  }

  async start(): Promise<string> {
    this.server = createServer((req, res) => {
      void this.handle(req, res).catch(() => {
        res.writeHead(500).end();
      });
    });
    await new Promise<void>((resolve) => this.server?.listen(0, '127.0.0.1', resolve));
    const address = this.server.address();
    if (address === null || typeof address === 'string') throw new Error('no address');
    this.issuer = `http://127.0.0.1:${address.port}`;
    return this.issuer;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }

  private idToken(): string {
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'fake-key-1' })).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({
        iss: this.issuer,
        aud: this.clientId,
        sub: 'fake-user-1',
        email: this.email,
        email_verified: true,
        nonce: this.seenNonce,
        iat: now,
        exp: now + 300,
      }),
    ).toString('base64url');
    const signature = createSign('RSA-SHA256')
      .update(`${header}.${payload}`)
      .sign(this.privateKey);
    return `${header}.${payload}.${Buffer.from(signature).toString('base64url')}`;
  }

  private async handle(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', this.issuer || 'http://fake.local');
    if (req.method === 'GET' && url.pathname === '/.well-known/openid-configuration') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          issuer: this.issuer,
          authorization_endpoint: `${this.issuer}/authorize`,
          token_endpoint: `${this.issuer}/token`,
          jwks_uri: `${this.issuer}/jwks`,
        }),
      );
      return;
    }
    if (req.method === 'GET' && url.pathname === '/authorize') {
      this.seenChallenge = url.searchParams.get('code_challenge') ?? '';
      this.seenState = url.searchParams.get('state') ?? '';
      this.seenNonce = url.searchParams.get('nonce') ?? '';
      const redirectUri = url.searchParams.get('redirect_uri') ?? '';
      if (url.searchParams.get('client_id') !== this.clientId || !redirectUri) {
        res.writeHead(400).end('bad authorize request');
        return;
      }
      const target = new URL(redirectUri);
      target.searchParams.set('code', this.expectedCode);
      target.searchParams.set('state', this.seenState);
      res.writeHead(302, { location: target.toString() }).end();
      return;
    }
    if (req.method === 'POST' && url.pathname === '/token') {
      this.tokenCalls += 1;
      const body = await new Promise<string>((resolve) => {
        let data = '';
        req.on('data', (chunk: Buffer) => {
          data += chunk.toString('utf8');
        });
        req.on('end', () => resolve(data));
      });
      const form = new URLSearchParams(body);
      this.seenVerifier = form.get('code_verifier') ?? '';
      const ok =
        form.get('grant_type') === 'authorization_code' &&
        form.get('code') === this.expectedCode &&
        form.get('client_id') === this.clientId &&
        form.get('client_secret') === this.clientSecret &&
        this.seenVerifier !== '' &&
        createHash('sha256').update(this.seenVerifier).digest('base64url') === this.seenChallenge;
      if (!ok) {
        res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'invalid_grant' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({ id_token: this.idToken(), token_type: 'Bearer', expires_in: 3600 }),
      );
      return;
    }
    if (req.method === 'GET' && url.pathname === '/jwks') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ keys: [this.jwk] }));
      return;
    }
    res.writeHead(404).end('not found');
  }
}

// Runs the browser-side of the sign-in flow against a service: hit
// /auth/login, follow the provider's redirect back to /auth/callback, and
// return the Set-Cookie value. Rejects when any step is not a 302.
export async function signInFlow(serviceBase: string): Promise<string> {
  const login = await fetch(`${serviceBase}/auth/login`, { redirect: 'manual' });
  if (login.status !== 302) throw new Error(`login: expected 302, got ${login.status}`);
  const authorizeUrl = login.headers.get('location');
  if (!authorizeUrl) throw new Error('login: no location');
  const authorize = await fetch(authorizeUrl, { redirect: 'manual' });
  if (authorize.status !== 302) throw new Error(`authorize: expected 302, got ${authorize.status}`);
  const callbackUrl = authorize.headers.get('location');
  if (!callbackUrl) throw new Error('authorize: no location');
  const callback = await fetch(callbackUrl, { redirect: 'manual' });
  if (callback.status !== 302) throw new Error(`callback: expected 302, got ${callback.status}`);
  const cookie = callback.headers.get('set-cookie');
  if (!cookie) throw new Error('callback: no set-cookie');
  return cookie;
}

// The af_session=... pair from a Set-Cookie header value.
export function cookiePair(setCookie: string): string {
  return setCookie.split(';')[0] ?? '';
}

// A port that was free a moment ago — for services whose config needs the
// port before listen (the OIDC redirect_uri names the service itself).
export async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const address = probe.address();
  const port = address !== null && typeof address === 'object' ? address.port : 0;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}
