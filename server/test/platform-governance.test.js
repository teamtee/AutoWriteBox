import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import * as store from '../store.js';
import {
  PLATFORM_SYNC_POLICY, normalizePlatformConfirmationInput,
  platformConfirmationReviewState, platformSyncGate,
} from '../platform-governance-schema.js';
import { cleanupTestTempDirs, makeTestTempDir } from './test-temp-dir.js';

let root;
beforeEach(() => {
  root = makeTestTempDir('novelbox-platform-governance-');
  store.setDataRoot(root);
});
afterEach(cleanupTestTempDirs);

function input(overrides = {}) {
  return {
    platform: '起点读书',
    rulesUrl: 'https://example.test/author-rules',
    aiPolicyUrl: 'https://example.test/ai-policy',
    contractReference: '已在作者后台核对当前合同第 8 条。',
    officialApiStatus: 'not-found',
    apiDocsUrl: '',
    confirmRules: true,
    confirmAiPolicy: true,
    confirmContract: true,
    confirmNoBypass: true,
    ...overrides,
  };
}

test('平台核对记录要求完整人工确认并拒绝带凭据或伪授权的链接', () => {
  const record = normalizePlatformConfirmationInput(input(), {
    id: `platform_${'a'.repeat(32)}`,
    checkedAt: '2026-08-10T00:00:00.000Z',
  });
  assert.equal(record.platform, '起点读书');
  assert.deepEqual(record.confirmations, {
    rules: true, aiPolicy: true, contract: true, noBypass: true,
  });
  assert.throws(() => normalizePlatformConfirmationInput(input({
    confirmContract: false,
  }), {
    id: `platform_${'b'.repeat(32)}`, checkedAt: '2026-08-10T00:00:00.000Z',
  }), /BAD_PLATFORM_CONFIRMATION/);
  assert.throws(() => normalizePlatformConfirmationInput(input({
    rulesUrl: 'https://user:secret@example.test/rules',
  }), {
    id: `platform_${'c'.repeat(32)}`, checkedAt: '2026-08-10T00:00:00.000Z',
  }), /BAD_PLATFORM_CONFIRMATION/);
  assert.throws(() => normalizePlatformConfirmationInput(input({
    officialApiStatus: 'authorized', apiDocsUrl: '',
  }), {
    id: `platform_${'d'.repeat(32)}`, checkedAt: '2026-08-10T00:00:00.000Z',
  }), /BAD_PLATFORM_CONFIRMATION/);
});

test('官方接口门禁永不开放当前自动同步，只标记近期授权证据为未来候选', () => {
  const record = normalizePlatformConfirmationInput(input({
    officialApiStatus: 'authorized',
    apiDocsUrl: 'https://example.test/official-api-docs',
  }), {
    id: `platform_${'e'.repeat(32)}`, checkedAt: '2026-08-10T00:00:00.000Z',
  });
  const current = new Date('2026-08-20T00:00:00.000Z');
  assert.deepEqual(platformSyncGate(record, current), {
    automaticSyncAvailable: false,
    eligibleForFutureIntegration: true,
    reason: 'OFFICIAL_API_REVIEW_REQUIRED_BEFORE_IMPLEMENTATION',
  });
  assert.equal(
    platformConfirmationReviewState(record, new Date('2026-09-20T00:00:00.000Z'))
      .reviewStatus,
    'stale',
  );
  assert.equal(
    platformSyncGate(record, new Date('2026-09-20T00:00:00.000Z'))
      .eligibleForFutureIntegration,
    false,
  );
  assert.equal(PLATFORM_SYNC_POLICY.mode, 'manual-only');
  assert.equal(PLATFORM_SYNC_POLICY.automaticSyncAvailable, false);
  assert.deepEqual(PLATFORM_SYNC_POLICY.prohibitedMethods, [
    'login-automation', 'captcha-bypass', 'platform-restriction-bypass',
  ]);
});

test('平台核对记录随书持久化和备份，并用修订号保护增删改', async () => {
  const book = await store.createBook({ premise: '平台治理', title: '治理测试' });
  const initial = (await store.readBookStructure(book.id)).book.settings.serialization;
  const saved = await store.savePlatformConfirmation(book.id, input(), {
    expectedRevision: initial.revision,
  });
  assert.equal(saved.platformConfirmations.length, 1);
  assert.equal(saved.platformConfirmations[0].reviewStatus, 'current');
  assert.equal(saved.syncPolicy.mode, 'manual-only');
  assert.equal(saved.syncPolicy.automaticSyncAvailable, false);
  assert.notEqual(saved.revision, initial.revision);

  await assert.rejects(
    () => store.savePlatformConfirmation(book.id, input({ platform: '番茄小说' }), {
      expectedRevision: initial.revision,
    }),
    /SERIALIZATION_CONFLICT/,
  );
  await assert.rejects(
    () => store.savePlatformConfirmation(book.id, input(), {
      expectedRevision: saved.revision,
    }),
    /PLATFORM_CONFIRMATION_DUPLICATE/,
  );

  const backup = await store.createBookBackup(book.id);
  assert.equal(backup.book.settings.serialization.platformConfirmations.length, 1);
  const imported = await store.importBookBackup(backup);
  const importedSettings = (await store.readBookStructure(imported.id))
    .book.settings.serialization;
  assert.equal(importedSettings.platformConfirmations[0].platform, '起点读书');
  assert.equal(importedSettings.syncPolicy.automaticSyncAvailable, false);

  const removed = await store.deletePlatformConfirmation(
    book.id, saved.platformConfirmations[0].id, { expectedRevision: saved.revision },
  );
  assert.deepEqual(removed.platformConfirmations, []);
  await assert.rejects(
    () => store.deletePlatformConfirmation(
      book.id, saved.platformConfirmations[0].id, { expectedRevision: removed.revision },
    ),
    /PLATFORM_CONFIRMATION_NOT_FOUND/,
  );
});
