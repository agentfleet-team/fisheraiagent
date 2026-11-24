import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import ts from 'typescript';

// Structural guard for R-13: no boundary may put caught or request-derived
// text into a log line or a reply. src/log.ts is the only place that writes
// logs; replies come only from fixed code-to-message tables.
// The scan is advisory coverage under the round-4 amendment: the compile-time
// guarantee is that every reply/HTTP error sink accepts only branded text
// (SafeText) and every id field a branded id, so a scan miss alone is not a
// failure — but a scan hit still flags a real problem the compiler cannot
// see (for example free text inside an `unknown` response body).

const SRC = join(import.meta.dirname, '..', 'src');
const FIXTURES = join(import.meta.dirname, 'fixtures', 'scan');

// Calls that emit text to a log, a user, or an HTTP client.
const SINK_NAMES = new Set([
  'log', 'sendError', 'send', 'reply', 'replyEphemeral', 'end', 'write', 'writeHead',
  'error', 'warn', 'info', 'debug', 'sink',
]);

// Functions whose return type is a closed union of codes; they cannot leak text.
// driveFailureFields (save.ts) returns only an HTTP status and a reason
// identifier that drive.ts validated by format.
const CODE_MAPPERS = new Set(['codeOf', 'errorCode', 'driveFailureFields']);

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

  // Names bound to a caught value or to another alias of one: the scan must
  // follow `const detail = err.message` so the alias cannot carry caught
  // text into a sink under a fresh name. File-global on purpose — an alias
  // may be assigned in one scope and used in another.
  const aliased = new Set<string>();

  // Whether a subtree mentions a name that holds caught text. `caught` is
  // scoped: a catch binding applies only inside its own clause, so a
  // parameter named `err` elsewhere is not treated as the caught value.
  const holdsCaughtText = (n: ts.Node, caught: ReadonlySet<string>): boolean => {
    let found = false;
    const walk = (node: ts.Node): void => {
      if (found) return;
      // A mapper that returns only a fixed code union produces clean output.
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && CODE_MAPPERS.has(node.expression.text)) return;
      if (ts.isIdentifier(node) && (caught.has(node.text) || aliased.has(node.text))) {
        found = true;
        return;
      }
      ts.forEachChild(node, walk);
    };
    walk(n);
    return found;
  };

  // A function used as a .catch((e) => ...) callback binds e like a catch.
  const catchCallbackParam = (n: ts.Node): string | undefined => {
    if (!ts.isArrowFunction(n) && !ts.isFunctionExpression(n)) return undefined;
    const p = n.parent;
    if (
      !ts.isCallExpression(p) ||
      !ts.isPropertyAccessExpression(p.expression) ||
      p.expression.name.text !== 'catch' ||
      !p.arguments.some((a) => a === n)
    ) {
      return undefined;
    }
    const param = n.parameters[0];
    return param && ts.isIdentifier(param.name) ? param.name.text : undefined;
  };

  const checkArg = (arg: ts.Node, sink: string, caught: ReadonlySet<string>): void => {
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
      } else if (ts.isIdentifier(n) && aliased.has(n.text)) {
        at(n, `alias "${n.text}" of caught text passed to ${sink}()`);
      }
      ts.forEachChild(n, walk);
    };
    walk(arg);
  };

  const visit = (n: ts.Node, caught: ReadonlySet<string>): void => {
    let inner = caught;
    if (ts.isCatchClause(n) && n.variableDeclaration && ts.isIdentifier(n.variableDeclaration.name)) {
      inner = new Set(inner).add(n.variableDeclaration.name.text);
    }
    const bound = catchCallbackParam(n);
    if (bound !== undefined) inner = new Set(inner).add(bound);

    if (ts.isVariableDeclaration(n) && n.initializer && ts.isIdentifier(n.name) && holdsCaughtText(n.initializer, inner)) {
      aliased.add(n.name.text);
    }
    if (
      ts.isBinaryExpression(n) &&
      n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(n.left) &&
      holdsCaughtText(n.right, inner)
    ) {
      aliased.add(n.left.text);
    }
    if ((ts.isForOfStatement(n) || ts.isForInStatement(n)) && holdsCaughtText(n.expression, inner)) {
      const decl = ts.isVariableDeclarationList(n.initializer) ? n.initializer.declarations[0] : undefined;
      if (decl && ts.isIdentifier(decl.name)) aliased.add(decl.name.text);
    }
    if (ts.isCallExpression(n)) {
      if (isConsole(n.expression) && !isLogModule) at(n, 'console output outside src/log.ts');
      const name = calleeName(n.expression);
      if (name && SINK_NAMES.has(name)) for (const a of n.arguments) checkArg(a, name, inner);
    }
    ts.forEachChild(n, (c) => visit(c, inner));
  };
  visit(sf, new Set());
  return problems;
}

// The type-level guarantee (SafeText sinks, branded ids) holds only for code
// that compiles without casts: an `as` cast or a @ts- suppression could turn
// an arbitrary string into a brand. Any type assertion in src/ is a failure.
export function scanCasts(fileName: string, text: string): string[] {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.ES2022, true);
  const problems: string[] = [];
  const visit = (n: ts.Node): void => {
    if (
      ts.isAsExpression(n) ||
      n.kind === ts.SyntaxKind.TypeAssertionExpression ||
      ts.isNonNullExpression(n)
    ) {
      const { line } = sf.getLineAndCharacterOfPosition(n.getStart());
      problems.push(`${fileName}:${line + 1}: type assertion — compile without casts`);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  const suppression = /@ts-(ignore|expect-error|nocheck)/.exec(text);
  if (suppression) problems.push(`${fileName}: @ts- suppression comment`);
  return problems;
}

test('R-14: no `as` casts, type assertions or @ts- suppressions in src/', () => {
  const problems = listTs(SRC).flatMap((f) => scanCasts(f, readFileSync(f, 'utf8')));
  assert.deepEqual(problems, []);
});

test('R-13: no file in src/ passes caught or free text into a log or reply call', () => {
  const problems = listTs(SRC).flatMap((f) => scanSource(f, readFileSync(f, 'utf8')));
  assert.deepEqual(problems, []);
});

test('R-13: the scan rejects deliberately bad fixtures', () => {
  const log = scanSource('bad-log.ts', readFileSync(join(FIXTURES, 'bad-log.ts.txt'), 'utf8'));
  assert.ok(log.some((p) => p.includes('.message')), log.join('\n'));
  assert.ok(log.some((p) => p.includes('String(')), log.join('\n'));
  assert.ok(log.some((p) => p.includes('alias "detail"')), log.join('\n'));
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
  // Lines 2-6 each pass something the logger must refuse.
  assert.deepEqual([...errorLines].sort(), [2, 3, 4, 5, 6]);
});

test('R-14: every reply and HTTP error-body sink rejects plain string at compile time', () => {
  const file = join(FIXTURES, 'bad-sinks.ts.txt');
  const text = readFileSync(file, 'utf8');
  const virtual = join(import.meta.dirname, 'fixtures', 'scan', 'bad-sinks.ts');
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
  // The fixture looks up two table entries for the accepted calls, then on
  // these lines passes `err.message` directly, via a local alias, via
  // destructuring and via a helper parameter into reply, replyEphemeral and
  // react — plus a bare literal, a dynamic template through the code
  // lookup, a helper turning `string` into SafeText, an ErrorBody message
  // and a failed JobView message — and the same flows again through the
  // reply `link` parameter's branded DriveLink url, which must also reject
  // a bare literal — every one must be a compile error.
  assert.deepEqual(
    [...errorLines].sort((a, b) => a - b),
    [12, 14, 16, 17, 18, 19, 20, 22, 25, 26, 28, 37, 38, 39, 41, 44],
  );
});

test('F3: the WebDAV reply path has no string-to-brand route — the import is gone and plain strings are refused', () => {
  const file = join(FIXTURES, 'bad-webdav-path.ts.txt');
  const text = readFileSync(file, 'utf8');
  const virtual = join(import.meta.dirname, 'fixtures', 'scan', 'bad-webdav-path.ts');
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
  // Line 2 imports a string-to-WebdavPath parser that no longer exists;
  // lines 11-13 pass `err.message`, its alias and a bare literal as the
  // reply `path` — every one must be a compile error.
  assert.deepEqual([...errorLines].sort((a, b) => a - b), [2, 11, 12, 13]);
});
