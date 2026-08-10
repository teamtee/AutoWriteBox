import {
  activateApiProfile as storeActivateProfile,
  configRevision, deleteApiProfile as storeDeleteProfile,
  readApiProfiles as storeReadProfiles, readConfig,
  saveApiBookBinding as storeSaveBookBinding, saveApiProfile as storeSaveProfile,
  saveApiTaskRoutes as storeSaveTaskRoutes,
  writeConfig,
} from '../store.js';
import { sendJsonError } from '../http-error.js';
import { createClientAbortTracker } from '../client-abort.js';
import { API_PROFILE_ID_PATTERN } from '../api-profile-schema.js';

const REVISION_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const mask = (cfg) => ({
  ...cfg,
  apiKey: cfg.apiKey ? 'sk-****' : '',
  revision: configRevision(cfg),
});
const maskProfiles = (library) => ({
  ...library,
  profiles: library.profiles.map((profile) => ({
    ...profile,
    apiKey: profile.apiKey ? 'sk-****' : '',
  })),
});

function expectedConfigRevision(value) {
  if (typeof value !== 'string' || !REVISION_PATTERN.test(value)) {
    throw new Error('BAD_CONFIG_REVISION');
  }
  return value;
}

function expectedProfilesRevision(value) {
  if (typeof value !== 'string' || !REVISION_PATTERN.test(value)) {
    throw new Error('BAD_API_PROFILES_REVISION');
  }
  return value;
}

function sendRouteError(res, error) {
  if (res.destroyed || res.writableEnded) return;
  if (res.headersSent) res.destroy(error);
  else sendJsonError(res, error);
}

export function mountConfigRoutes(app, deps = {}) {
  app.get('/api/config', async (req, res) => {
    try { res.json(mask(await readConfig())); }
    catch (e) { sendJsonError(res, e); }
  });
  app.post('/api/config', async (req, res) => {
    try {
      const body = req.body;
      // 保留存储层对 null / 数组的原始校验语义，不让对象解构把非法请求伪装成补丁。
      if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        await writeConfig(body);
      }
      const { expectedRevision, ...patch } = body;
      const saved = await writeConfig(patch, {
        expectedRevision: expectedConfigRevision(expectedRevision),
      });
      res.json(mask(saved));
    } catch (e) { sendJsonError(res, e); }
  });
  app.get('/api/config/profiles', async (req, res) => {
    try { res.json(maskProfiles(await storeReadProfiles())); }
    catch (e) { sendJsonError(res, e); }
  });
  app.post('/api/config/profiles', async (req, res) => {
    try {
      const { expectedRevision, expectedConfigRevision, ...input } = req.body ?? {};
      const saved = await storeSaveProfile(input, {
        expectedRevision, expectedConfigRevision,
      });
      res.json({ ...saved, profile: maskProfiles({ profiles: [saved.profile] }).profiles[0] });
    } catch (e) { sendJsonError(res, e); }
  });
  app.delete('/api/config/profiles/:id', async (req, res) => {
    try {
      res.json(await storeDeleteProfile(req.params.id, {
        expectedRevision: req.body?.expectedRevision,
      }));
    } catch (e) { sendJsonError(res, e); }
  });
  app.post('/api/config/profiles/:id/activate', async (req, res) => {
    try {
      const result = await storeActivateProfile(req.params.id, req.body?.model, {
        expectedProfilesRevision: req.body?.expectedProfilesRevision,
        expectedConfigRevision: req.body?.expectedConfigRevision,
      });
      res.json({ config: mask(result.config), library: maskProfiles(result.library) });
    } catch (e) { sendJsonError(res, e); }
  });
  app.post('/api/config/profiles/routing', async (req, res) => {
    try {
      const result = await storeSaveTaskRoutes(req.body?.taskRoutes, {
        expectedRevision: req.body?.expectedRevision,
      });
      res.json(maskProfiles(result));
    } catch (e) { sendJsonError(res, e); }
  });
  app.post('/api/config/profiles/books/:bookId', async (req, res) => {
    try {
      const result = await storeSaveBookBinding(req.params.bookId, req.body?.binding, {
        expectedRevision: req.body?.expectedRevision,
      });
      res.json(maskProfiles(result));
    } catch (e) { sendJsonError(res, e); }
  });
  app.post('/api/config/models', async (req, res) => {
    const client = createClientAbortTracker(req, res);
    try {
      if (typeof deps.discoverLlmModels !== 'function') throw new Error('INTERNAL_ERROR');
      const target = req.body?.target;
      let config;
      if (target === 'current') {
        const revision = expectedConfigRevision(req.body?.expectedConfigRevision);
        config = await readConfig({ signal: client.signal });
        if (configRevision(config) !== revision) throw new Error('CONFIG_CONFLICT');
      } else if (target === 'profile') {
        if (typeof req.body?.profileId !== 'string'
          || !API_PROFILE_ID_PATTERN.test(req.body.profileId)) {
          throw new Error('BAD_API_PROFILE_ID');
        }
        const revision = expectedProfilesRevision(req.body?.expectedProfilesRevision);
        const library = await storeReadProfiles({ signal: client.signal });
        if (library.revision !== revision) throw new Error('API_PROFILES_CONFLICT');
        const profile = library.profiles.find((item) => item.id === req.body?.profileId);
        if (!profile) throw new Error('API_PROFILE_NOT_FOUND');
        config = {
          baseUrl: profile.baseUrl, model: profile.selectedModel, apiKey: profile.apiKey,
        };
      } else {
        throw new Error('BAD_MODEL_DISCOVERY_TARGET');
      }
      const result = await deps.discoverLlmModels({ config, signal: client.signal });
      await client.assertAliveAfterIo();
      if (!res.destroyed && !res.writableEnded) res.json({
        ok: true,
        models: result.models,
        truncated: result.truncated,
        currentModel: config.model,
        currentModelAvailable: result.models.includes(config.model),
      });
    } catch (error) {
      sendRouteError(res, error);
    } finally {
      client.dispose();
    }
  });
}
