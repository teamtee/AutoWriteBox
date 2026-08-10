import test from 'node:test';
import assert from 'node:assert/strict';
import { syncCommittedDirectories } from '../store.js';

test('syncCommittedDirectories 在首个父目录失败后仍同步其余目录', async (t) => {
  const firstFailure = Object.assign(new Error('source sync failed'), { code: 'EIO' });
  const calls = [];
  t.mock.method(console, 'warn', () => {});

  await assert.rejects(
    () => syncCommittedDirectories(['/source-parent', '/destination-parent'], {
      sync: async (absDir) => {
        calls.push(absDir);
        if (absDir === '/source-parent') throw firstFailure;
      },
    }),
    (error) => error === firstFailure,
  );
  assert.deepEqual(calls, ['/source-parent', '/destination-parent']);
});

test('syncCommittedDirectories 去重同一父目录并上报后续故障', async (t) => {
  const destinationFailure = Object.assign(new Error('destination sync failed'), {
    code: 'ENOSPC',
  });
  const calls = [];
  t.mock.method(console, 'warn', () => {});

  await assert.rejects(
    () => syncCommittedDirectories(['/shared-parent', '/shared-parent', '/destination-parent'], {
      sync: async (absDir) => {
        calls.push(absDir);
        if (absDir === '/destination-parent') throw destinationFailure;
      },
    }),
    (error) => error === destinationFailure,
  );
  assert.deepEqual(calls, ['/shared-parent', '/destination-parent']);
});
