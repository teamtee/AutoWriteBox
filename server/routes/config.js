import { readConfig, writeConfig } from '../store.js';

const mask = (cfg) => ({ ...cfg, apiKey: cfg.apiKey ? 'sk-****' : '' });

export function mountConfigRoutes(app) {
  app.get('/api/config', async (req, res) => {
    res.json(mask(await readConfig()));
  });
  app.post('/api/config', async (req, res) => {
    const saved = await writeConfig(req.body || {});
    res.json(mask(saved));
  });
}
