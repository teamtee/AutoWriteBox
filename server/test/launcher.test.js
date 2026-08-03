import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const root = process.cwd();

test('macOS 启动脚本默认不强杀占用 4399 的进程', async () => {
  const script = await readFile(join(root, '启动.command'), 'utf8');

  assert.doesNotMatch(script, /\bkill\s+-9\b/);
  assert.match(script, /-sTCP:LISTEN/);
  assert.match(script, /PORT=5001/);
  assert.match(script, /\bexit\s+1\b/);
});

test('Windows 启动脚本默认不强杀占用 4399 的进程', async () => {
  const script = await readFile(join(root, '启动.bat'), 'utf8');

  assert.doesNotMatch(script, /\btaskkill\b/i);
  assert.match(script, /LISTENING/i);
  assert.match(script, /PORT=5001/i);
  assert.match(script, /exit\s+\/b\s+1/i);
});
