import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/index.js';
import * as store from '../server/store.js';

const APP_HOST = '127.0.0.1';
const APP_PORT = 4499;
const MODEL_PORT = 4500;
const dataRoot = await mkdtemp(join(tmpdir(), 'novelbox-e2e-'));
store.setDataRoot(dataRoot);
await store.writeConfig({
  baseUrl: `http://${APP_HOST}:${MODEL_PORT}/v1`,
  model: 'e2e-model', apiKey: 'e2e-secret-key-not-in-backup', modelContextChars: 500_000,
  chapterWordTarget: 3_000, requestTimeoutMs: 30_000,
});

function sse(res, text) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
  });
  res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
  res.end('data: [DONE]\n\n');
}

const modelServer = createServer((req, res) => {
  if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
    res.writeHead(404).end();
    return;
  }
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    let prompt = '';
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      prompt = body.messages?.map((message) => message.content).join('\n') ?? '';
    } catch {
      res.writeHead(400).end();
      return;
    }
    let output;
    let delay = 10;
    if (prompt.includes('作品级“核心循环”')) {
      delay = 350;
      output = JSON.stringify({
        readerExperience: '看落魄修复师如何用旧机器救下一座城',
        protagonistAction: '诊断故障、交换零件并承担修复后果',
        progression: '每次修复获得更深权限和新的城市线索',
        cost: '修复会暴露身份并消耗不可再生零件',
        escalation: '从街区设备升级到城市基础设施与旧文明网络',
      });
    } else if (/请(?:写|重写)第 \d+ 章正文/u.test(prompt)) {
      delay = 650;
      output = '这是停止操作之后才返回、绝不应该保存的迟到章节正文。';
    } else if (prompt.includes('人物导演卡')) {
      output = JSON.stringify({
        characters: [{
          name: '林砚', importance: 5, currentDesire: '找回被扣押的维修箱',
          fear: '妹妹发现他曾替公司销毁证据', secret: '维修箱里藏着旧城密钥',
          pressureResponse: '先拖延观察，退路被堵后主动承担最危险的拆解',
          speechPattern: '短句，用操作指令代替解释', speechAvoid: '不讲大道理', notes: '',
        }],
        relationships: [],
      });
    } else if (prompt.includes('计划向读者建立的承诺')) {
      output = JSON.stringify({ entries: [{
        kind: 'main', importance: 5, promise: '林砚何时用旧城密钥改写停电规则',
        expectedStartChapter: 1, expectedEndChapter: 4, notes: '必须由修复行动兑现',
      }] });
    } else {
      output = JSON.stringify({ ok: true });
    }
    setTimeout(() => sse(res, output), delay);
  });
});

await new Promise((resolve, reject) => {
  modelServer.once('error', reject);
  modelServer.listen(MODEL_PORT, APP_HOST, resolve);
});
const appServer = createApp({ listenHost: APP_HOST }).listen(APP_PORT, APP_HOST);
await new Promise((resolve, reject) => {
  appServer.once('listening', resolve);
  appServer.once('error', reject);
});
console.error(`E2E_READY http://${APP_HOST}:${APP_PORT}`);

let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await Promise.all([
    new Promise((resolve) => appServer.close(resolve)),
    new Promise((resolve) => modelServer.close(resolve)),
  ]);
  await rm(dataRoot, { recursive: true, force: true });
}
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.once(signal, () => { void close().finally(() => process.exit(0)); });
}
