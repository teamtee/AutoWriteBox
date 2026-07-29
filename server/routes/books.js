import * as store from '../store.js';

export function mountBookRoutes(app) {
  app.get('/api/books', async (req, res) => res.json(await store.listBooks()));

  app.post('/api/books', async (req, res) => {
    const { premise, title } = req.body || {};
    if (!premise) return res.status(400).json({ error: 'PREMISE_REQUIRED' });
    res.json(await store.createBook({ premise, title }));
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
    } catch { res.status(404).json({ error: 'BOOK_NOT_FOUND' }); }
  });

  app.post('/api/books/:id/sections', async (req, res) => {
    res.json(await store.addSection(req.params.id, { title: req.body?.title }));
  });

  app.post('/api/books/:id/sections/:sid/chapters', async (req, res) => {
    res.json(await store.addChapter(req.params.id, req.params.sid, { title: req.body?.title }));
  });

  app.put('/api/books/:id/outline', async (req, res) => {
    const book = await store.readBook(req.params.id);
    store.pushHistory(book, 'outline');
    book.outline.content = req.body?.content ?? '';
    await store.writeBook(req.params.id, book);
    res.json(book.outline);
  });

  app.put('/api/books/:id/core', async (req, res) => {
    const book = await store.readBook(req.params.id);
    book.settings.history = book.settings.history || [];
    book.settings.history.push(JSON.stringify(book.settings.core));  // 存档旧核心设定
    book.settings.core = { ...book.settings.core, ...(req.body?.core || {}) };
    await store.writeBook(req.params.id, book);
    res.json(book.settings);
  });

  app.put('/api/books/:id/sections/:sid/chapters/:cid', async (req, res) => {
    const ch = await store.readChapter(req.params.id, req.params.sid, req.params.cid);
    store.pushHistory(ch, 'content');
    ch.content = req.body?.content ?? '';
    await store.writeChapter(req.params.id, req.params.sid, req.params.cid, ch);
    res.json({ ok: true });
  });

  app.post('/api/books/:id/sections/:sid/chapters/:cid/rollback', async (req, res) => {
    const ch = await store.readChapter(req.params.id, req.params.sid, req.params.cid);
    const ok = store.rollback(ch, 'content');
    if (ok) await store.writeChapter(req.params.id, req.params.sid, req.params.cid, ch);
    res.json({ ok });
  });
}
