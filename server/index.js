import express from 'express';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { mountConfigRoutes } from './routes/config.js';
import { mountBookRoutes } from './routes/books.js';
import { mountGenRoutes } from './routes/gen.js';
import { streamChat, nonStreamChat, extractDigest } from './llm.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
let WEB_DIST = join(__dirname, '..', 'web', 'dist');
export function setWebDist(p) { WEB_DIST = p; }

export function createApp() {
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use((err, req, res, next) => {
    if (err?.type === 'entity.parse.failed') {
      return res.status(400).json({ error: String(err.message || err) });
    }
    next(err);
  });

  app.get('/api/health', (req, res) => res.json({ ok: true }));
  mountConfigRoutes(app);
  mountBookRoutes(app);
  mountGenRoutes(app, { streamChat, nonStreamChat, extractDigest });

  // 未匹配的 /api 一律 404（避免被 SPA 回退吞掉）
  app.use('/api', (req, res) => res.status(404).json({ error: 'NOT_FOUND' }));

  // 静态资源 + SPA 回退
  app.use(express.static(WEB_DIST));
  app.get('*', (req, res) => {
    const index = join(WEB_DIST, 'index.html');
    if (existsSync(index)) return res.sendFile(index);
    res.status(200).send('前端尚未构建，请运行 npm run build');
  });

  return app;
}

// 直接运行时启动服务（用 pathToFileURL 兼容含中文/特殊字符的路径）
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = process.env.PORT || 4399;
  createApp().listen(port, () => console.log(`自动小说盒子已启动：http://localhost:${port}`));
}
