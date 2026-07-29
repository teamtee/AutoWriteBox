import express from 'express';

export function createApp() {
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.get('/api/health', (req, res) => res.json({ ok: true }));
  return app;
}

// 直接运行时启动服务
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = process.env.PORT || 4399;
  createApp().listen(port, () => console.log(`自动小说盒子已启动：http://localhost:${port}`));
}
