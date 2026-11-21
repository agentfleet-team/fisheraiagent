import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import ts from 'typescript';

// Structural guard for R-13: no boundary may put caught or request-derived
// text into a log line or a reply. src/log.ts is the only place that writes
// logs; replies come only from fixed code-to-message tables.

const SRC = join(import.meta.dirname, '..', 'src');
const FIXTURES = join(import.meta.dirname, 'fixtures', 'scan');

// Calls that emit text to a log, a user, or an HTTP client.
const SINK_NAMES = new Set([
  'log', 'sendError', 'send', 'reply', 'replyEphemeral', 'end', 'write', 'writeHead',
  'error', 'warn', 'info', 'debug', 'sink',
]);

// Functions whose return type is a closed union of codes; they cannot leak text.
const CODE_MAPPERS = new Set(['codeOf', 'errorCode']);

function listTs(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? listTs(p) : p.endsWith('.ts') ? [p] : [];
  });
}

function calleeName(expr: ts.Expression): string | undefined {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  return undefined;
}

function isConsole(expr: ts.Expression): boolean {
  return ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.expression) && expr.expression.text === 'console';
}

export function scanSource(fileName: string, text: string): string[] {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.ES2022, true);
  const problems: string[] = [];
  const at = (n: ts.Node, what: string) => {
    const { line } = sf.getLineAndCharacterOfPosition(n.getStart());
    problems.push(`${relative(process.cwd(), fileName)}:${line + 1}: ${what}`);
  };
  const isLogModule = fileName.endsWith(join('src', 'log.ts'));

  // Names bound by catch clauses and .catch((e) => ...) callbacks.
  const caught = new Set<string>();
  const collect = (n: ts.Node): void => {
    if (ts.isCatchClause(n) && n.variableDeclaration && ts.isIdentifier(n.variableDeclaration.name)) {
      caught.add(n.variableDeclaration.name.text);
    }
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      n.expression.name.text === 'catch'
    ) {
      for (const a of n.arguments) {
        if ((ts.isArrowFunction(a) || ts.isFunctionExpression(a)) && a.parameters[0] && ts.isIdentifier(a.parameters[0].name)) {
          caught.add(a.parameters[0].name.text);
        }
      }
    }
    ts.forEachChild(n, collect);
  };
  collect(sf);

  const checkArg = (arg: ts.Node, sink: string): void => {
    const walk = (n: ts.Node): void => {
      // A mapper that returns only a fixed code union may take the caught value.
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && CODE_MAPPERS.has(n.expression.text)) return;
      if (ts.isPropertyAccessExpression(n) && (n.name.text === 'message' || n.name.text === 'stack')) {
        at(n, `.${n.name.text} passed to ${sink}()`);
      }
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'String') {
        at(n, `String(...) passed to ${sink}()`);
      }
      if (ts.isIdentifier(n) && caught.has(n.text)) {
        at(n, `caught value "${n.text}" passed to ${sink}()`);
      }
      ts.forEachChild(n, walk);
    };
    walk(arg);
  };

  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      if (isConsole(n.expression) && !isLogModule) at(n, 'console output outside src/log.ts');
      const name = calleeName(n.expression);
      if (name && SINK_NAMES.has(name)) for (const a of n.arguments) checkArg(a, name);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return problems;
}

test('R-13: no file in src/ passes caught or free text into a log or reply call', () => {
  const problems = listTs(SRC).flatMap((f) => scanSource(f, readFileSync(f, 'utf8')));
  assert.deepEqual(problems, []);
});

test('R-13: the scan rejects deliberately bad fixtures', () => {
  const log = scanSource('bad-log.ts', readFileSync(join(FIXTURES, 'bad-log.ts.txt'), 'utf8'));
  assert.ok(log.some((p) => p.includes('.message')), log.join('\n'));
  assert.ok(log.some((p) => p.includes('String(')), log.join('\n'));
    const reply = scanSource('bad-reply.ts', readFileSync(join(FIXTURES, 'bad-reply.ts.txt'), 'utf8'));
  assert.ok(reply.some((p) => p.includes('caught value')), reply.join('\n'));
  assert.ok(reply.some((p) => p.includes('console output')), reply.join('\n'));
});

test('R-13: the logger type rejects an Error, free-text fields and free-text events at compile time', () => {
  const file = join(FIXTURES, 'bad-typecheck.ts.txt');
  const text = readFileSync(file, 'utf8');
  const virtual = join(import.meta.dirname, 'fixtures', 'scan', 'bad-typecheck.ts');
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    types: ['node'],
  };
  const host = ts.createCompilerHost(options);
  const readFile = host.readFile.bind(host);
  host.readFile = (f) => (f === virtual ? text : readFile(f));
  const fileExists = host.fileExists.bind(host);
  host.fileExists = (f) => f === virtual || fileExists(f);
  const program = ts.createProgram([virtual], options, host);
  const errorLines = new Set(
    ts
      .getPreEmitDiagnostics(program)
      .filter((d) => d.file?.fileName === virtual)
      .map((d) => d.file!.getLineAndCharacterOfPosition(d.start!).line + 1),
  );
  // Lines 2-5 each pass something the logger must refuse.
  assert.deepEqual([...errorLines].sort(), [2, 3, 4, 5]);
});
