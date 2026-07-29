import express from 'express';
import { pathToFileURL } from 'node:url';

export function createApp() {
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.get('/api/health', (req, res) => res.json({ ok: true }));
  return app;
}

// 直接运行时启动服务（用 pathToFileURL 兼容含中文/特殊字符的路径）
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = process.env.PORT || 4399;
  createApp().listen(port, () => console.log(`自动小说盒子已启动：http://localhost:${port}`));
}
