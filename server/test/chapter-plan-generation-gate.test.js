import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import * as store from '../store.js';
import { mountGenRoutes } from '../routes/gen.js';
import { cleanupTestTempDirs, makeTestTempDir } from './test-temp-dir.js';
import { startTestServer, stopTestServer } from './http-test-server.js';

let root;
beforeEach(async () => {
  root = makeTestTempDir('novelbox-plan-gate-');
  store.setDataRoot(root);
  await store.writeConfig({
    baseUrl: 'https://model.test/v1', model: 'writer-model', apiKey: 'test-key',
  });
});
afterEach(cleanupTestTempDirs);

async function createTarget() {
  const book = await store.createBook({ premise: '黑客营救妹妹', title: '深网回声' });
  const section = await store.addSection(book.id, { title: '潜入' });
  const chapter = await store.addChapter(book.id, section.id, { title: '封锁线' });
  return { book, section, chapter };
}

function appWithWriter(onStream) {
  const app = express();
  app.use(express.json());
  mountGenRoutes(app, {
    async *streamChat() { onStream(); yield '主角破解闸机，却让追捕系统重新锁定自己。'; },
    async nonStreamChat() { return '{}'; },
  });
  return app;
}

async function generate(base, target, extra = {}) {
  return fetch(`${base}/api/gen/chapter`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      bookId: target.book.id, sectionId: target.section.id,
      chapterId: target.chapter.id, mode: 'rewrite',
      expectedRevision: store.versionRevision(target.chapter.body),
      ...extra,
    }),
  });
}

test('空策划卡不再阻断生成，而是把作者留白的判断交给模型', async () => {
  const target = await createTarget();
  let streamCalls = 0;
  let instruction = '';
  const app = express();
  app.use(express.json());
  mountGenRoutes(app, {
    async *streamChat(options) {
      streamCalls += 1;
      instruction = options.messages[0].content;
      yield '主角破解闸机，却让追捕系统重新锁定自己。';
    },
    async nonStreamChat() { return '{}'; },
  });
  const started = await startTestServer(app);
  try {
    const response = await generate(started.base, target);
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.doesNotMatch(body, /CHAPTER_PLAN_NOT_READY/);
    assert.equal(streamCalls, 1);
    // 留白作为上下文交给模型，而不是让作者拿不到任何结果。
    assert.match(instruction, /作者在策划卡上留白的部分/);
    assert.match(instruction, /现在由你决定/);
    assert.match(instruction, /故事推进/);
    assert.match(instruction, /场景因果/);
    const stored = await store.readChapter(target.book.id, target.section.id, target.chapter.id);
    assert.ok(store.currentText(stored.body).trim());
  } finally {
    await stopTestServer(started.server);
  }
});

test('页面显式要求先补齐策划时，门槛仍然生效且不调用模型', async () => {
  const target = await createTarget();
  let streamCalls = 0;
  const started = await startTestServer(appWithWriter(() => { streamCalls += 1; }));
  try {
    const response = await generate(started.base, target, { requireReadyPlan: true });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /"error":"CHAPTER_PLAN_NOT_READY"/);
    assert.equal(streamCalls, 0);
    const stored = await store.readChapter(target.book.id, target.section.id, target.chapter.id);
    assert.equal(store.currentText(stored.body), '');
  } finally {
    await stopTestServer(started.server);
  }
});

test('正式路由拒绝旧版 next 无策划续写，且不创建空章或调用模型', async () => {
  const target = await createTarget();
  const emptySection = await store.addSection(target.book.id, { title: '下一部' });
  let streamCalls = 0;
  const started = await startTestServer(appWithWriter(() => { streamCalls += 1; }));
  try {
    const response = await fetch(`${started.base}/api/gen/chapter`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bookId: target.book.id, sectionId: emptySection.id, mode: 'next',
        expectedLastChapterId: null,
      }),
    });
    assert.match(await response.text(), /CHAPTER_PLAN_NOT_READY/);
    assert.equal(streamCalls, 0);
    assert.deepEqual((await store.readSection(target.book.id, emptySection.id)).chapters, []);
  } finally {
    await stopTestServer(started.server);
  }
});

test('完整的质量合同、人物行动、场景因果与代价会解锁首次正文生成', async () => {
  const target = await createTarget();
  await store.saveChapterPlan(target.book.id, target.section.id, target.chapter.id, {
    qualityProtocolVersion: 3,
    designProtocolVersion: 1,
    rhythmIntentVersion: 1,
    rhythmIntent: {
      pressurePattern: 'false-relief', resolutionMethod: 'wit', payoffScale: 'chapter',
      hookMechanism: 'new-information', costType: 'identity',
    },
    goal: '潜入封锁区找到妹妹', obstacle: '生物闸机与巡逻无人机同时核验身份',
    choice: '主角调用自己的旧后门并留下可追踪签名', payoff: '确认妹妹仍保有自主意识',
    hook: '妹妹反向发来只有兄妹知道的求救暗号',
    tensionArc: '压力来源：隔离层即将断网；变化链：员工卡被闸机拒绝→主角重放维护指令使闸机开启→指令暴露旧身份并触发警报召来无人机；选择高点：主角留下可追踪签名换取通路；兑现与余波：确认妹妹仍有意识但天穹重新锁定主角',
    foreshadowing: '旧线/阅读债务：推进妹妹意识异常；叙事节拍：变义；认知变化：读者以为妹妹只能被动发送系统消息→读者怀疑妹妹仍能主动选择求救内容；具体载体：兄妹暗号；当下作用：验证消息不是诱饵；行动影响：主角放弃撤离继续下潜；世界线作用：深化当前层的人机控制边界；保留未知：不揭示妹妹如何夺回控制权',
    worldExpansion: '展开前认知：主角与读者只知道员工身份会被本区闸机核验，尚不知道维护后门是否联网；既有依据：天穹的身份追踪制度；可验证证据：旧身份警报跨区同步；边界增量/机制深化：确认维护后门也受中央追踪；选择与代价：主角使用后门并暴露存活状态；保留未知：不揭示中央节点位置',
    decisionChain: '当前误判/未决：主角以为自己写入的旧后门仍不会触发追踪；验证/争取行动：主角主动重放维护指令进入隔离层；利益受损者：天穹内务组失去对封锁区入口的独占控制；针对性反制：内务组依据本次维护签名重新锁定主角身份并派出无人机；状态改写：主角身份隐藏且无法进入→主角进入隔离层但身份暴露并被追踪；后续索债：主角必须在无人机合围前找到妹妹信号源',
    knowledgeDesign: '当前问题：妹妹发来的信号是否代表她仍能自主选择；可见依据：系统消息中出现只有兄妹知道的暗号且发送时间早于本次潜入；允许结论：信号内容并非普通系统模板；替代解释：妹妹主动嵌入暗号｜对手读取旧记录后伪造暗号；交叉验证：原始消息时间戳＋兄妹旧纸质暗号本；保留未知：不确认妹妹当前是否清醒或由谁发送',
    scenes: [{
      trigger: '承接上一章确认妹妹信号来自封锁区，本章立刻潜入隔离层',
      desire: '主角进入妹妹所在的隔离层', obstacle: '闸机拒绝员工卡并呼叫无人机',
      action: '主角重放自己写入系统的维护指令', turn: '闸机开启但旧身份警报被激活',
      cost: '天穹重新确认主角仍然活着并开始追踪',
    }],
  }, { expectedRevision: store.chapterPlanRevision(target.chapter.plan) });
  const current = await store.readChapter(target.book.id, target.section.id, target.chapter.id);
  target.chapter = current;
  let streamCalls = 0;
  const started = await startTestServer(appWithWriter(() => { streamCalls += 1; }));
  try {
    const response = await generate(started.base, target);
    assert.equal(response.status, 200);
    const events = await response.text();
    assert.match(events, /"saved":true/);
    assert.equal(streamCalls, 1);
    const stored = await store.readChapter(target.book.id, target.section.id, target.chapter.id);
    assert.match(store.currentText(stored.body), /破解闸机/);
  } finally {
    await stopTestServer(started.server);
  }
});
