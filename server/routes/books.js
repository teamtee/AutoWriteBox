import * as store from '../store.js';

export function mountBookRoutes(app) {
  app.get('/api/books', async (req, res) => {
    try { res.json(await store.listBooks()); }
    catch (e) { res.status(400).json({ error: String(e.message || e) }); }
  });

  app.post('/api/books', async (req, res) => {
    try {
      const { premise, title } = req.body || {};
      if (!premise) return res.status(400).json({ error: 'PREMISE_REQUIRED' });
      res.json(await store.createBook({ premise, title }));
    } catch (e) { res.status(400).json({ error: String(e.message || e) }); }
  });

  app.get('/api/books/:id/tree', async (req, res) => {
    try {
      const book = await store.readBook(req.params.id);
      const sections = [];
      for (const sid of book.sections) {
        const section = await store.readSection(book.id, sid);
        const chapters = [];
        for (const cid of section.chapters) chapters.push(await store.readChapter(book.id, sid, cid));
        sections.push({ ...section, chapters });
      }
      res.json({ book, sections });
    } catch (e) {
      const message = String(e.message || e);
      const status = message === 'BOOK_NOT_FOUND' ? 404 : 400;
      res.status(status).json({ error: message });
    }
  });

  app.post('/api/books/:id/sections', async (req, res) => {
    try {
      res.json(await store.addSection(req.params.id, {
        title: req.body?.title,
        titleSource: req.body?.titleSource,
      }));
    } catch (e) { res.status(400).json({ error: String(e.message || e) }); }
  });

  app.post('/api/books/:id/sections/:sid/chapters', async (req, res) => {
    try { res.json(await store.addChapter(req.params.id, req.params.sid, { title: req.body?.title })); }
    catch (e) { res.status(400).json({ error: String(e.message || e) }); }
  });

  // ——— 统一版本操作 ———
  app.post('/api/books/:id/version/move', async (req, res) => {
    try {
      const delta = req.body?.delta;
      if (delta !== -1 && delta !== 1) throw new Error('BAD_DELTA');
      const vf = await store.versionMove(req.params.id, req.body?.path, delta);
      res.json(vf);
    } catch (e) { res.status(400).json({ error: String(e.message || e) }); }
  });
  app.post('/api/books/:id/version/clear', async (req, res) => {
    try { res.json(await store.versionSet(req.params.id, req.body?.path, '')); }
    catch (e) { res.status(400).json({ error: String(e.message || e) }); }
  });
  app.post('/api/books/:id/version/save', async (req, res) => {
    try { res.json(await store.versionSet(req.params.id, req.body?.path, req.body?.text ?? '')); }
    catch (e) { res.status(400).json({ error: String(e.message || e) }); }
  });

  // ——— 书架管理 ———
  app.delete('/api/books/:id', async (req, res) => {
    try { await store.deleteBook(req.params.id); res.json({ ok: true }); }
    catch (e) { res.status(400).json({ error: String(e.message || e) }); }
  });
  app.patch('/api/books/:id', async (req, res) => {
    try { res.json(await store.renameBook(req.params.id, req.body?.title)); }
    catch (e) { res.status(400).json({ error: String(e.message || e) }); }
  });
}
