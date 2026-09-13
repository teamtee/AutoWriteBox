import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const bookId = `book_${'a'.repeat(32)}`;
const title = 'E2E 候选安全测试';

async function json(response) {
  if (!response.ok) {
    const detail = await response.text();
    assert.fail(`${response.status} ${detail}`);
  }
  return response.json();
}

async function poll(check, { timeoutMs = 5_000, intervalMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error('E2E_POLL_TIMEOUT');
}

export async function runAiCandidateSafety({ page, baseURL }) {
  await json(await fetch(`${baseURL}/api/books`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      requestedBookId: bookId, title,
      premise: '落魄修复师在停电城市寻找妹妹',
    }),
  }));
  const section = await json(await fetch(`${baseURL}/api/books/${bookId}/sections`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: '切章隔离测试', expectedLastSectionId: null }),
  }));
  const chapterOne = await json(await fetch(
    `${baseURL}/api/books/${bookId}/sections/${section.id}/chapters`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '延迟第一章', expectedLastChapterId: null }),
    },
  ));
  const chapterTwo = await json(await fetch(
    `${baseURL}/api/books/${bookId}/sections/${section.id}/chapters`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '目标第二章', expectedLastChapterId: chapterOne.id }),
    },
  ));
  await page.goto(baseURL);
  await page.getByRole('button', { name: title }).click();
  await page.getByRole('button', { name: /核心设定/ }).click();

  const cost = page.getByLabel('每轮付出什么代价');
  await page.getByRole('button', { name: /AI 填充核心循环草稿/ }).click();
  await page.getByText('正在填充核心循环草稿…').waitFor();
  await page.getByRole('button', { name: '停止' }).click();
  await page.getByText(/已停止核心循环草稿生成/).waitFor();
  await new Promise((resolve) => setTimeout(resolve, 450));
  assert.equal(await cost.inputValue(), '');

  await page.getByRole('button', { name: /AI 填充核心循环草稿/ }).click();
  await page.getByText('正在填充核心循环草稿…').waitFor();
  await cost.fill('作者等待期间手工填写的现实代价');
  await page.getByText(/已保留人工草稿，未自动覆盖/).waitFor();
  assert.equal(await cost.inputValue(), '作者等待期间手工填写的现实代价');
  await page.locator('.story-engine-card').getByText('已保存', { exact: true })
    .waitFor({ timeout: 5_000 });
  await page.getByText(/进阶资料：人物、承诺、创作资产与长期记忆/).click();

  await page.getByRole('button', { name: /AI 自动生成人物与关系/ }).click();
  await page.getByText(/AI 已自动保存 1 个人物和 0 组关系/).waitFor();
  const craft = await json(await fetch(`${baseURL}/api/books/${bookId}/character-craft`));
  assert.equal(craft.characters[0].name, '林砚');

  await page.getByRole('button', { name: /AI 自动生成计划承诺/ }).click();
  await page.getByText(/AI 已自动保存 1 条计划承诺/).waitFor();
  const ledger = await json(await fetch(`${baseURL}/api/books/${bookId}/promise-ledger`));
  assert.equal(ledger.entries[0].promise, '林砚何时用旧城密钥改写停电规则');

  const delayedChapterUrl = `**/api/books/${bookId}/sections/${section.id}/chapters/${chapterOne.id}`;
  await page.route(delayedChapterUrl, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    await new Promise((resolve) => setTimeout(resolve, 450));
    await route.continue().catch(() => {});
  });
  await page.getByRole('button', { name: /延迟第一章/ }).click();
  await page.evaluate((secondTitle) => {
    const second = [...document.querySelectorAll('.chapter-list button')]
      .find((button) => button.textContent?.includes(secondTitle));
    if (!(second instanceof HTMLButtonElement)) throw new Error('E2E_CHAPTER_BUTTON_MISSING');
    // 模拟首次点击已经入队、禁用态尚未来得及阻挡第二次原生事件的极窄竞态。
    second.disabled = false;
    second.click();
  }, '目标第二章');
  await page.getByRole('heading', { name: /目标第二章/ }).waitFor();
  await new Promise((resolve) => setTimeout(resolve, 550));
  assert.equal(await page.getByRole('heading', { name: /目标第二章/ }).count(), 1);
  await page.unroute(delayedChapterUrl);

  await page.getByRole('button', { name: /延迟第一章/ }).click();
  await page.getByRole('heading', { name: /延迟第一章/ }).waitFor();
  await page.getByRole('button', { name: /^✍️ 生成本章/ }).click();
  await page.getByText('✍️ 正在生成本章…').waitFor();
  await new Promise((resolve) => setTimeout(resolve, 120));
  await page.getByRole('button', { name: '⏹ 停止' }).first().click();
  await page.getByRole('button', { name: /^✍️ 生成本章/ }).waitFor();
  await new Promise((resolve) => setTimeout(resolve, 750));
  const stoppedChapter = await json(await fetch(
    `${baseURL}/api/books/${bookId}/sections/${section.id}/chapters/${chapterOne.id}`,
  ));
  assert.equal(stoppedChapter.body.versions[stoppedChapter.body.cursor], '');
  assert.equal(await page.getByLabel(/延迟第一章内容/).inputValue(), '');

  const secondPage = await page.context().newPage();
  await secondPage.goto(baseURL);
  await secondPage.getByRole('button', { name: title }).click();
  await secondPage.getByRole('heading', { name: /延迟第一章/ }).waitFor();
  const firstTabText = '第一标签页保存的可信正文。';
  const secondTabDraft = '第二标签页基于旧版本写下、不得覆盖第一页的草稿。';
  await page.getByLabel(/延迟第一章内容/).fill(firstTabText);
  await page.getByLabel(/延迟第一章内容/).press('ControlOrMeta+S');
  await page.getByText('✓ 已保存', { exact: true }).waitFor();
  await secondPage.getByLabel(/延迟第一章内容/).fill(secondTabDraft);
  await secondPage.getByLabel(/延迟第一章内容/).press('ControlOrMeta+S');
  await secondPage.getByText(/保存时检测到另一页面已更新内容/).waitFor();
  await secondPage.getByText(/服务器内容已变化，草稿已保留/).waitFor();
  assert.equal(await secondPage.getByLabel(/延迟第一章内容/).inputValue(), secondTabDraft);
  const conflictedChapter = await json(await fetch(
    `${baseURL}/api/books/${bookId}/sections/${section.id}/chapters/${chapterOne.id}`,
  ));
  assert.equal(conflictedChapter.body.versions[conflictedChapter.body.cursor], firstTabText);
  let dirtyBeforeUnloadSeen = false;
  secondPage.once('dialog', async (dialog) => {
    dirtyBeforeUnloadSeen = dialog.type() === 'beforeunload';
    await dialog.accept();
  });
  await secondPage.close({ runBeforeUnload: true });
  await poll(() => dirtyBeforeUnloadSeen);

  await page.getByRole('button', { name: /目标第二章/ }).click();
  await page.getByRole('heading', { name: /目标第二章/ }).waitFor();
  const planPage = await page.context().newPage();
  await planPage.goto(baseURL);
  await planPage.getByRole('button', { name: title }).click();
  await planPage.getByRole('button', { name: /目标第二章/ }).click();
  await planPage.getByRole('heading', { name: /目标第二章/ }).waitFor();
  if (!await page.getByLabel('本章目标').count()) {
    await page.getByText('编辑策划表单', { exact: true }).click();
  }
  if (!await planPage.getByLabel('本章目标').count()) {
    await planPage.getByText('编辑策划表单', { exact: true }).click();
  }
  const firstPlanGoal = '第一页策划：修复师必须拿回备用电源。';
  const secondPlanDraft = '第二页旧策划：修复师改去追踪陌生信号。';
  await page.getByLabel('本章目标').fill(firstPlanGoal);
  await page.getByText(/章节策划卡已自动保存/).waitFor({ timeout: 5_000 });
  await planPage.getByLabel('本章目标').fill(secondPlanDraft);
  await planPage.getByText(/已刷新最新版本，本地草稿仍保留/)
    .waitFor({ timeout: 5_000 });
  assert.equal(await planPage.getByLabel('本章目标').inputValue(), secondPlanDraft);
  const plannedChapter = await json(await fetch(
    `${baseURL}/api/books/${bookId}/sections/${section.id}/chapters/${chapterTwo.id}`,
  ));
  assert.equal(plannedChapter.plan.goal, firstPlanGoal);
  await planPage.close();

  await page.getByRole('button', { name: /^✍️ 生成本章/ }).click();
  await page.getByText('✍️ 正在生成本章…').waitFor();
  await new Promise((resolve) => setTimeout(resolve, 120));
  await page.getByRole('button', { name: /书架/ }).click();
  await page.getByRole('heading', { name: /我的书架/ }).waitFor();
  await new Promise((resolve) => setTimeout(resolve, 750));
  let secondChapter = await json(await fetch(
    `${baseURL}/api/books/${bookId}/sections/${section.id}/chapters/${chapterTwo.id}`,
  ));
  assert.equal(secondChapter.body.versions[secondChapter.body.cursor], '');

  await page.getByRole('button', { name: title }).click();
  await page.getByRole('button', { name: /目标第二章/ }).click();
  await page.getByRole('heading', { name: /目标第二章/ }).waitFor();
  await page.getByRole('button', { name: /^✍️ 生成本章/ }).click();
  await page.getByText('✍️ 正在生成本章…').waitFor();
  await new Promise((resolve) => setTimeout(resolve, 120));
  let beforeUnloadSeen = false;
  page.once('dialog', async (dialog) => {
    beforeUnloadSeen = dialog.type() === 'beforeunload';
    await dialog.accept();
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  assert.equal(beforeUnloadSeen, true);
  await page.getByRole('heading', { name: /我的书架/ }).waitFor();
  await new Promise((resolve) => setTimeout(resolve, 750));
  secondChapter = await json(await fetch(
    `${baseURL}/api/books/${bookId}/sections/${section.id}/chapters/${chapterTwo.id}`,
  ));
  assert.equal(secondChapter.body.versions[secondChapter.body.cursor], '');

  const usage = await json(await fetch(`${baseURL}/api/llm-usage`));
  assert.ok(usage.totals.calls >= 3);
  const tasks = usage.recent.map((entry) => entry.task);
  for (const task of [
    'story-engine-draft', 'character-craft-draft', 'promise-ledger-draft',
    'chapter-generate',
  ]) assert.ok(tasks.includes(task), `missing usage task ${task}`);
  assert.ok(usage.recent.some((entry) =>
    entry.task === 'chapter-generate' && entry.status === 'cancelled'));
  assert.ok(usage.models.some((entry) =>
    entry.provider === 'http://127.0.0.1:4500/v1' && entry.model === 'e2e-model'));
  assert.doesNotMatch(JSON.stringify(usage), /落魄修复师在停电城市寻找妹妹/u);

  await page.getByRole('heading', { name: /我的书架/ }).waitFor();
  const sourceCard = page.locator('.shelf-card').filter({ hasText: title });
  const downloadPromise = page.waitForEvent('download');
  await sourceCard.getByRole('button', { name: /备份/ }).click();
  const download = await downloadPromise;
  const backupPath = await download.path();
  assert.ok(backupPath, 'backup download path is missing');
  const backupText = await readFile(backupPath, 'utf8');
  assert.doesNotMatch(backupText, /e2e-secret-key-not-in-backup/u);
  assert.match(backupText, /作者等待期间手工填写的现实代价/u);

  const fileChooserPromise = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /导入备份/ }).click();
  const chooser = await fileChooserPromise;
  await chooser.setFiles(backupPath);
  await page.getByText(/已导入为新的小说副本/).waitFor();
  const importedBook = await poll(async () => {
    const books = await json(await fetch(`${baseURL}/api/books`));
    return books.find((book) => book.id !== bookId);
  });
  const importedTree = await json(await fetch(`${baseURL}/api/books/${importedBook.id}/tree`));
  assert.equal(importedTree.sections.length, 1);
  assert.equal(importedTree.sections[0].chapters.length, 2);
  assert.equal(
    importedTree.book.settings.storyEngine.cost,
    '作者等待期间手工填写的现实代价',
  );
  const importedCraft = await json(await fetch(
    `${baseURL}/api/books/${importedBook.id}/character-craft`,
  ));
  assert.equal(importedCraft.characters[0].name, '林砚');
  const importedLedger = await json(await fetch(
    `${baseURL}/api/books/${importedBook.id}/promise-ledger`,
  ));
  assert.equal(importedLedger.entries[0].promise, '林砚何时用旧城密钥改写停电规则');

  const beforeDelete = await json(await fetch(`${baseURL}/api/books`));
  const deleteCard = page.locator('.shelf-card').filter({ hasText: title }).last();
  await deleteCard.getByRole('button', { name: /移入回收站$/ }).click();
  await deleteCard.getByRole('button', { name: '移入回收站？' }).click();
  await page.getByText(/已移入回收站，可随时恢复/).waitFor();
  const missingBook = await poll(async () => {
    const current = await json(await fetch(`${baseURL}/api/books`));
    return beforeDelete.find((book) => !current.some((entry) => entry.id === book.id));
  });
  await page.locator('.trash-panel').getByText(/回收站/).click();
  const trashRow = page.locator('.trash-row').filter({ hasText: title });
  await trashRow.getByRole('button', { name: '恢复' }).click();
  await page.getByText(/已从回收站恢复/).waitFor();
  await poll(async () => {
    const current = await json(await fetch(`${baseURL}/api/books`));
    return current.some((book) => book.id === missingBook.id);
  });
  const restoredTree = await json(await fetch(`${baseURL}/api/books/${missingBook.id}/tree`));
  assert.equal(restoredTree.sections.length, 1);
  assert.equal(restoredTree.sections[0].chapters.length, 2);
}
