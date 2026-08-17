import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const source = (path) => readFileSync(join(root, path), 'utf8');
const lineCount = (path) => {
  const content = source(path);
  if (!content) return 0;
  const lines = content.split(/\r?\n/u).length;
  return /\r?\n$/u.test(content) ? lines - 1 : lines;
};

const MAX_AUTHORED_LINES = 1_500;
const PREFERRED_AUTHORED_LINES = 800;
const AUDITED_EXTENSIONS = new Set([
  '.bat', '.command', '.css', '.html', '.js', '.json', '.md', '.pem',
  '.ts', '.tsx', '.yml', '.yaml',
]);
const GENERATED_OR_EXTERNAL_EXCEPTIONS = new Map([
  ['package-lock.json', 'npm 生成的根依赖锁文件'],
  ['web/package-lock.json', 'npm 生成的依赖锁文件'],
  ['certs/corp-ca.pem', '不可分片的外部证书链资产'],
]);
const IGNORED_DIRECTORIES = new Set(['.git', 'data', 'dist', 'node_modules']);

function authoredFiles(directory = root) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!IGNORED_DIRECTORIES.has(entry.name)) files.push(...authoredFiles(absolute));
      continue;
    }
    if (!entry.isFile()) continue;
    const extension = entry.name.includes('.')
      ? entry.name.slice(entry.name.lastIndexOf('.'))
      : '';
    if (AUDITED_EXTENSIONS.has(extension)) {
      files.push(relative(root, absolute).replaceAll('\\', '/'));
    }
  }
  return files;
}

test('人工维护文件不超过 1500 行，生成或外部资产只能使用显式例外', (t) => {
  const architecture = source('ARCHITECTURE.md');
  for (const [path, reason] of GENERATED_OR_EXTERNAL_EXCEPTIONS) {
    assert.match(architecture, new RegExp(path.replaceAll('.', '\\.'), 'u'));
    assert.ok(reason.length > 0);
  }

  const oversized = [];
  const preferredWarnings = [];
  for (const path of authoredFiles()) {
    const actual = lineCount(path);
    if (actual > MAX_AUTHORED_LINES && !GENERATED_OR_EXTERNAL_EXCEPTIONS.has(path)) {
      oversized.push(`${path}: ${actual}`);
    } else if (actual > PREFERRED_AUTHORED_LINES
      && !GENERATED_OR_EXTERNAL_EXCEPTIONS.has(path)) {
      preferredWarnings.push(`${path}: ${actual}`);
    }
  }
  assert.deepEqual(oversized, [], `以下人工维护文件超过硬上限：\n${oversized.join('\n')}`);
  if (preferredWarnings.length) {
    t.diagnostic(`超过 ${PREFERRED_AUTHORED_LINES} 行建议线（仍符合硬上限）：\n${preferredWarnings.join('\n')}`);
  }
});

test('热点 facade 使用增长棘轮，新增大职责必须进入独立模块', () => {
  const budgets = new Map([
    ['server/store.js', 1_200],
    ['server/generation-context.js', 400],
    ['web/src/api.ts', 800],
    ['web/src/App.tsx', 1_400],
  ]);
  for (const [path, maximum] of budgets) {
    const actual = lineCount(path);
    assert.ok(actual <= maximum, `${path} 已增长到 ${actual} 行（预算 ${maximum}）`);
  }
});

test('关键目录提供可发现的职责索引', () => {
  const indexes = [
    'ARCHITECTURE.md', 'docs/README.md', 'docs/superpowers/plans/README.md',
    'server/README.md', 'server/routes/README.md', 'server/store/README.md',
    'server/test/README.md', 'web/src/README.md', 'web/src/components/README.md',
  ];
  for (const path of indexes) {
    assert.ok(source(path).trim().length > 0, `${path} 必须存在且非空`);
  }
});

test('路由只依赖 store facade，存储子模块不反向依赖 facade', () => {
  const routeRoot = join(root, 'server/routes');
  for (const name of readdirSync(routeRoot).filter((item) => item.endsWith('.js'))) {
    assert.doesNotMatch(
      readFileSync(join(routeRoot, name), 'utf8'),
      /from\s+['"]\.\.\/store\//u,
      `${name} 不应绕过 store.js facade`,
    );
  }

  const moduleRoot = join(root, 'server/store');
  for (const name of readdirSync(moduleRoot).filter((item) => item.endsWith('.js'))) {
    const moduleSource = readFileSync(join(moduleRoot, name), 'utf8');
    assert.doesNotMatch(
      moduleSource,
      /from\s+['"]\.\.\/store\.js['"]/u,
      `${name} 不应反向导入 store.js`,
    );
    assert.doesNotMatch(
      moduleSource,
      /(?:process\.cwd\(\)|\bDATA_ROOT\b)/u,
      `${name} 必须通过 StoreContext 读取动态数据根`,
    );
  }
});

test('页面组件通过 api facade 访问后端，不绑定 SSE 内部模块', () => {
  const componentRoot = join(root, 'web/src/components');
  const componentFiles = readdirSync(componentRoot)
    .filter((name) => /\.(?:ts|tsx)$/u.test(name) && !name.includes('.test.'))
    .map((name) => ({ name, path: join(componentRoot, name) }));
  const consumers = [
    { name: 'App.tsx', path: join(root, 'web/src/App.tsx') },
    ...componentFiles,
  ];
  for (const item of consumers) {
    assert.doesNotMatch(
      readFileSync(item.path, 'utf8'),
      /from\s+['"](?:\.\.\/|\.\/)api-(?:sse|contract)['"]/u,
      `${item.name} 应通过 api.ts facade 导入`,
    );
  }
  assert.match(source('web/src/api.ts'), /export \{ parseSSELines \} from '\.\/api-sse';/u);
});
