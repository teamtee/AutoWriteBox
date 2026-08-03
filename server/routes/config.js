import { readConfig, writeConfig } from '../store.js';

const mask = (cfg) => ({ ...cfg, apiKey: cfg.apiKey ? 'sk-****' : '' });

export function mountConfigRoutes(app) {
  app.get('/api/config', async (req, res) => {
    try { res.json(mask(await readConfig())); }
    catch (e) { res.status(400).json({ error: String(e.message || e) }); }
  });
  app.post('/api/config', async (req, res) => {
    try {
      const saved = await writeConfig(req.body || {});
      res.json(mask(saved));
    } catch (e) { res.status(400).json({ error: String(e.message || e) }); }
  });
}
