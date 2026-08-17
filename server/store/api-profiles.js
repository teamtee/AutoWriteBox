import { createHash, randomUUID } from 'node:crypto';
import { normalizeLlmConfig } from '../llm-config.js';
import {
  API_MODEL_TASKS, API_PROFILE_ID_PATTERN, emptyApiTaskRoutes, isApiModelTask,
  normalizeApiBookBindingInput, normalizeApiProfileInput,
  normalizeApiProfileLibrary, normalizeApiTaskRoutes,
} from '../api-profile-schema.js';
import {
  MAX_API_BOOK_BINDINGS, MAX_API_PROFILES, MAX_API_PROFILES_JSON_BYTES,
} from '../limits.js';
import { API_KEY_MASK } from './config.js';

const API_PROFILES_LOCK_KEY = 'api-profiles:library';
const REVISION_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function emptyApiProfileLibrary() {
  return {
    version: 1,
    activeProfileId: null,
    profiles: [],
    taskRoutes: emptyApiTaskRoutes(),
    bookBindings: [],
  };
}

function reconcileApiTaskRoutes(taskRoutes, profiles) {
  const byId = new Map(profiles.map((profile) => [profile.id, profile]));
  return Object.fromEntries(API_MODEL_TASKS.map((task) => {
    const route = taskRoutes[task];
    const profile = route ? byId.get(route.profileId) : null;
    return [task, profile?.models.includes(route.model) ? route : null];
  }));
}

function reconcileApiBookBindings(bookBindings, profiles) {
  const byId = new Map(profiles.map((profile) => [profile.id, profile]));
  return bookBindings.filter((binding) =>
    byId.get(binding.profileId)?.models.includes(binding.model));
}

export function createApiProfileStore(context, configStore) {
  if (!configStore || typeof configStore.readConfig !== 'function'
    || typeof configStore.writeConfig !== 'function'
    || typeof configStore.configRevision !== 'function'
    || typeof configStore.withConfigLock !== 'function') {
    throw new TypeError('CONFIG_STORE_REQUIRED');
  }
  const revisionSalt = randomUUID();
  const apiProfilesPath = () => context.resolvePath('api-profiles.json');

  const readApiProfileLibrary = async ({ signal } = {}) => {
    try {
      return normalizeApiProfileLibrary(await context.readStoredJson(
        apiProfilesPath(), {
          mode: 0o600, signal, maxBytes: MAX_API_PROFILES_JSON_BYTES,
        },
      ));
    } catch (error) {
      context.throwIfAborted(signal);
      if (error?.code !== 'ENOENT') throw error;
      return emptyApiProfileLibrary();
    }
  };

  const apiProfilesRevision = (library) => createHash('sha256')
    .update(revisionSalt, 'utf8')
    .update('\0', 'utf8')
    .update(JSON.stringify(normalizeApiProfileLibrary(library)), 'utf8')
    .digest('base64url');

  const assertApiProfilesRevision = (library, expectedRevision) => {
    if (typeof expectedRevision !== 'string' || !REVISION_PATTERN.test(expectedRevision)) {
      throw new Error('BAD_API_PROFILES_REVISION');
    }
    if (apiProfilesRevision(library) !== expectedRevision) {
      throw new Error('API_PROFILES_CONFLICT');
    }
  };

  const readApiProfiles = async ({ signal } = {}) => {
    const library = await readApiProfileLibrary({ signal });
    return { ...library, revision: apiProfilesRevision(library) };
  };

  const readConfigForTaskSelection = async (task, { signal, bookId } = {}) => {
    if (!isApiModelTask(task)) throw new Error('BAD_API_MODEL_TASK');
    const normalizedBookId = bookId === undefined ? undefined : context.safeId(bookId);
    const [config, library] = await Promise.all([
      configStore.readConfig({ signal }), readApiProfileLibrary({ signal }),
    ]);
    const bookBinding = normalizedBookId === undefined
      ? null : library.bookBindings.find((item) => item.bookId === normalizedBookId);
    if (bookBinding) {
      const profile = library.profiles.find((item) => item.id === bookBinding.profileId);
      if (!profile || !profile.models.includes(bookBinding.model)) {
        throw new Error('STORAGE_DATA_INVALID');
      }
      return {
        config: normalizeLlmConfig({
          ...config,
          baseUrl: profile.baseUrl,
          model: bookBinding.model,
          apiKey: profile.apiKey,
          modelContextChars: profile.modelContextChars[bookBinding.model],
        }),
        routed: true,
        source: 'book',
      };
    }
    const route = library.taskRoutes[task];
    if (!route) return { config, routed: false, source: 'default' };
    const profile = library.profiles.find((item) => item.id === route.profileId);
    if (!profile || !profile.models.includes(route.model)) {
      throw new Error('STORAGE_DATA_INVALID');
    }
    return {
      config: normalizeLlmConfig({
        ...config,
        baseUrl: profile.baseUrl,
        model: route.model,
        apiKey: profile.apiKey,
        modelContextChars: profile.modelContextChars[route.model],
      }),
      routed: true,
      source: 'task',
    };
  };

  const readConfigForTask = async (task, options = {}) =>
    (await readConfigForTaskSelection(task, options)).config;

  const saveApiTaskRoutes = async (taskRoutes, {
    expectedRevision, signal,
  } = {}) => context.withStoreLock(API_PROFILES_LOCK_KEY, async () => {
    const library = await readApiProfileLibrary({ signal });
    assertApiProfilesRevision(library, expectedRevision);
    const normalizedRoutes = normalizeApiTaskRoutes(taskRoutes, library.profiles);
    const next = { ...library, taskRoutes: normalizedRoutes };
    await context.ensureDataRoot();
    await context.atomicWriteJson(apiProfilesPath(), next, { mode: 0o600 });
    return { ...next, revision: apiProfilesRevision(next) };
  }, { signal });

  const saveApiBookBinding = async (bookId, binding, {
    expectedRevision, signal,
  } = {}) => {
    const normalizedBookId = context.safeId(bookId);
    // 读取在方案锁之前完成，避免与作品写锁形成反向等待。
    await context.readBook(normalizedBookId, { signal });
    return context.withStoreLock(API_PROFILES_LOCK_KEY, async () => {
      const library = await readApiProfileLibrary({ signal });
      assertApiProfilesRevision(library, expectedRevision);
      const normalizedBinding = normalizeApiBookBindingInput(binding, library.profiles);
      const existingIndex = library.bookBindings.findIndex(
        (item) => item.bookId === normalizedBookId,
      );
      if (normalizedBinding && existingIndex < 0
        && library.bookBindings.length >= MAX_API_BOOK_BINDINGS) {
        throw new Error('API_BOOK_BINDING_LIMIT');
      }
      const bookBindings = [...library.bookBindings];
      if (!normalizedBinding) {
        if (existingIndex >= 0) bookBindings.splice(existingIndex, 1);
      } else {
        const nextBinding = { bookId: normalizedBookId, ...normalizedBinding };
        if (existingIndex >= 0) bookBindings[existingIndex] = nextBinding;
        else bookBindings.push(nextBinding);
      }
      const next = { ...library, bookBindings };
      await context.ensureDataRoot();
      await context.atomicWriteJson(apiProfilesPath(), next, { mode: 0o600 });
      return { ...next, revision: apiProfilesRevision(next) };
    }, { signal });
  };

  const saveApiProfile = async (input, {
    expectedRevision, expectedConfigRevision, signal,
  } = {}) => {
    const normalizedInput = normalizeApiProfileInput(input);
    const requestedId = input.id;
    if (requestedId !== undefined
      && (typeof requestedId !== 'string' || !API_PROFILE_ID_PATTERN.test(requestedId))) {
      throw new Error('BAD_API_PROFILE_ID');
    }
    return context.withStoreLock(API_PROFILES_LOCK_KEY, async () => {
      const library = await readApiProfileLibrary({ signal });
      assertApiProfilesRevision(library, expectedRevision);
      const existingIndex = requestedId === undefined
        ? -1 : library.profiles.findIndex((profile) => profile.id === requestedId);
      if (requestedId !== undefined && existingIndex < 0) {
        throw new Error('API_PROFILE_NOT_FOUND');
      }
      if (existingIndex < 0 && library.profiles.length >= MAX_API_PROFILES) {
        throw new Error('API_PROFILE_LIMIT');
      }
      const existing = existingIndex >= 0 ? library.profiles[existingIndex] : null;
      const commit = async (currentConfig = null) => {
        const rawBaseUrl = currentConfig?.baseUrl ?? input.baseUrl;
        let rawApiKey = currentConfig?.apiKey ?? input.apiKey;
        if (typeof rawApiKey === 'string' && rawApiKey.trim() === API_KEY_MASK) {
          if (!existing) throw new Error('API_KEY_REQUIRED_FOR_BASE_URL_CHANGE');
          rawApiKey = existing.apiKey;
        }
        const connection = normalizeLlmConfig({
          baseUrl: rawBaseUrl,
          model: normalizedInput.selectedModel,
          apiKey: rawApiKey,
        });
        if (existing && connection.baseUrl !== existing.baseUrl
          && typeof input.apiKey === 'string' && input.apiKey.trim() === API_KEY_MASK) {
          throw new Error('API_KEY_REQUIRED_FOR_BASE_URL_CHANGE');
        }
        const now = new Date().toISOString();
        const profile = {
          id: existing?.id ?? `profile_${randomUUID().replaceAll('-', '')}`,
          ...normalizedInput,
          baseUrl: connection.baseUrl,
          apiKey: connection.apiKey,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
        };
        const profiles = [...library.profiles];
        if (existingIndex >= 0) profiles[existingIndex] = profile;
        else profiles.push(profile);
        const activeConnectionChanged = existing && library.activeProfileId === existing.id
          && (profile.baseUrl !== existing.baseUrl
            || profile.apiKey !== existing.apiKey
            || profile.selectedModel !== existing.selectedModel);
        const next = {
          ...library,
          activeProfileId: activeConnectionChanged ? null : library.activeProfileId,
          profiles,
          taskRoutes: reconcileApiTaskRoutes(library.taskRoutes, profiles),
          bookBindings: reconcileApiBookBindings(library.bookBindings, profiles),
        };
        await context.ensureDataRoot();
        await context.atomicWriteJson(apiProfilesPath(), next, { mode: 0o600 });
        return { profile, revision: apiProfilesRevision(next) };
      };

      if (input.useCurrentConfig !== true) return commit();
      // 与激活方案保持相同加锁顺序：方案库 -> 当前配置。
      return configStore.withConfigLock(async () => {
        const currentConfig = await configStore.readConfig({ signal });
        if (typeof expectedConfigRevision !== 'string'
          || !REVISION_PATTERN.test(expectedConfigRevision)) {
          throw new Error('BAD_CONFIG_REVISION');
        }
        if (configStore.configRevision(currentConfig) !== expectedConfigRevision) {
          throw new Error('CONFIG_CONFLICT');
        }
        return commit(currentConfig);
      }, { signal });
    }, { signal });
  };

  const deleteApiProfile = async (id, {
    expectedRevision, signal,
  } = {}) => {
    if (typeof id !== 'string' || !API_PROFILE_ID_PATTERN.test(id)) {
      throw new Error('BAD_API_PROFILE_ID');
    }
    return context.withStoreLock(API_PROFILES_LOCK_KEY, async () => {
      const library = await readApiProfileLibrary({ signal });
      assertApiProfilesRevision(library, expectedRevision);
      if (!library.profiles.some((profile) => profile.id === id)) {
        throw new Error('API_PROFILE_NOT_FOUND');
      }
      const profiles = library.profiles.filter((profile) => profile.id !== id);
      const next = {
        version: 1,
        activeProfileId: library.activeProfileId === id ? null : library.activeProfileId,
        profiles,
        taskRoutes: reconcileApiTaskRoutes(library.taskRoutes, profiles),
        bookBindings: reconcileApiBookBindings(library.bookBindings, profiles),
      };
      await context.atomicWriteJson(apiProfilesPath(), next, { mode: 0o600 });
      return { ok: true, revision: apiProfilesRevision(next) };
    }, { signal });
  };

  const activateApiProfile = async (id, model, {
    expectedProfilesRevision, expectedConfigRevision, signal,
  } = {}) => {
    if (typeof id !== 'string' || !API_PROFILE_ID_PATTERN.test(id)) {
      throw new Error('BAD_API_PROFILE_ID');
    }
    return context.withStoreLock(API_PROFILES_LOCK_KEY, async () => {
      const library = await readApiProfileLibrary({ signal });
      const profileIndex = library.profiles.findIndex((item) => item.id === id);
      if (profileIndex < 0) throw new Error('API_PROFILE_NOT_FOUND');
      const profile = library.profiles[profileIndex];
      if (typeof model !== 'string' || !profile.models.includes(model)) {
        throw new Error('BAD_API_PROFILE_MODEL');
      }
      assertApiProfilesRevision(library, expectedProfilesRevision);
      const sameSelection = library.activeProfileId === id
        && profile.selectedModel === model;
      const config = await configStore.writeConfig({
        baseUrl: profile.baseUrl,
        model,
        apiKey: profile.apiKey,
        modelContextChars: profile.modelContextChars[model],
      }, { expectedRevision: expectedConfigRevision });
      if (sameSelection) {
        return {
          config,
          library: { ...library, revision: apiProfilesRevision(library) },
        };
      }
      const now = new Date().toISOString();
      const profiles = [...library.profiles];
      profiles[profileIndex] = { ...profile, selectedModel: model, updatedAt: now };
      const next = {
        version: 1,
        activeProfileId: id,
        profiles,
        taskRoutes: library.taskRoutes,
        bookBindings: library.bookBindings,
      };
      await context.atomicWriteJson(apiProfilesPath(), next, { mode: 0o600 });
      return {
        config,
        library: { ...next, revision: apiProfilesRevision(next) },
      };
    }, { signal });
  };

  return Object.freeze({
    activateApiProfile,
    apiProfilesRevision,
    deleteApiProfile,
    readApiProfiles,
    readConfigForTask,
    readConfigForTaskSelection,
    saveApiBookBinding,
    saveApiProfile,
    saveApiTaskRoutes,
  });
}
