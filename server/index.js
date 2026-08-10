import express from 'express';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { lstat } from 'node:fs/promises';
import { mountConfigRoutes } from './routes/config.js';
import { mountBookRoutes } from './routes/books.js';
import { mountGenRoutes } from './routes/gen.js';
import { mountAssetRoutes } from './routes/assets.js';
import {
  cleanupAbandonedTransferDirs, cleanupPreparedBackups, mountStorageRoutes,
} from './routes/storage.js';
import {
  discoverLlmModels, streamChat, nonStreamChat, extractDigest,
} from './llm.js';
import { isLoopbackHostname, mountRequestSecurity } from './request-security.js';
import {
  acquireDataRootLease, cleanupAbandonedImports, recoverInterruptedTransactions,
} from './store.js';
import { JSON_BODY_LIMIT } from './limits.js';
import { sendJsonError } from './http-error.js';
import { openBrowser } from './launcher-preflight.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
let WEB_DIST = join(__dirname, '..', 'web', 'dist');
export function setWebDist(p) { WEB_DIST = p; }

function staticRequestPathSegments(path) {
  let decoded;
  try { decoded = decodeURIComponent(path); }
  catch {
    const error = new Error('STATIC_PATH_INVALID');
    error.status = 400;
    throw error;
  }
  const segments = decoded.split('/').filter(Boolean);
  if (segments.some((segment) => segment === '.' || segment === '..'
    || /[\\\u0000-\u001f\u007f]/u.test(segment))) {
    const error = new Error('STATIC_PATH_INVALID');
    error.status = 400;
    throw error;
  }
  return segments;
}

async function verifyStaticRequestPath(root, path) {
  let rootMetadata;
  try { rootMetadata = await lstat(root); }
  catch (error) {
    if (error?.code === 'ENOENT') return 'missing';
    throw error;
  }
  if (!rootMetadata.isDirectory()) throw new Error('STATIC_ROOT_INVALID');

  let current = root;
  const segments = staticRequestPathSegments(path);
  for (let index = 0; index < segments.length; index += 1) {
    current = join(current, segments[index]);
    let metadata;
    try { metadata = await lstat(current); }
    catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return 'missing';
      throw error;
    }
    if (metadata.isSymbolicLink()) return 'unsafe';
    const isLast = index === segments.length - 1;
    if (!isLast && !metadata.isDirectory()) return 'missing';
    if (isLast && !metadata.isDirectory() && !metadata.isFile()) return 'unsafe';
  }
  return 'safe';
}

async function verifySpaIndex(root) {
  let rootMetadata;
  let indexMetadata;
  try {
    rootMetadata = await lstat(root);
    indexMetadata = await lstat(join(root, 'index.html'));
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return false;
    throw error;
  }
  if (!rootMetadata.isDirectory() || !indexMetadata.isFile()) {
    throw new Error('STATIC_ROOT_INVALID');
  }
  return true;
}

export function resolveListenHost(rawHost) {
  return typeof rawHost === 'string' && rawHost.trim() ? rawHost.trim() : '127.0.0.1';
}
export function isAllowedListenHost(rawHost, allowNetworkAccess = '') {
  return isLoopbackHostname(resolveListenHost(rawHost)) || allowNetworkAccess === '1';
}
export function resolveListenPort(rawPort) {
  if (typeof rawPort !== 'string' || !/^\d+$/.test(rawPort.trim())) return 4399;
  const port = Number(rawPort.trim());
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : 4399;
}

export function configureHttpServerLimits(server) {
  // requestTimeout 只约束请求体接收，不会截断已开始返回的长篇模型生成；模型调用
  // 另有用户可配置的上游超时。显式固定这些值，避免 Node 默认值变化后出现慢请求
  // 无限占用、超大头部集合或单个 keep-alive socket 永久复用。
  server.requestTimeout = 5 * 60 * 1000;
  server.headersTimeout = 30 * 1000;
  server.timeout = 0;
  server.keepAliveTimeout = 5 * 1000;
  server.maxHeadersCount = 100;
  server.maxRequestsPerSocket = 1000;
  return server;
}

export function createInFlightRequestTracker() {
  let active = 0;
  const idleWaiters = new Set();
  const finishOne = () => {
    active -= 1;
    if (active !== 0) return;
    for (const resolve of idleWaiters) resolve();
    idleWaiters.clear();
  };
  return {
    run(task) {
      active += 1;
      let result;
      try { result = task(); }
      catch (error) { result = Promise.reject(error); }
      return Promise.resolve(result).finally(finishOne);
    },
    waitForIdle() {
      if (active === 0) return Promise.resolve();
      return new Promise((resolve) => idleWaiters.add(resolve));
    },
    get active() { return active; },
  };
}

function createTrackedRouteRegistrar(app, requestTracker) {
  const registrar = {};
  for (const method of ['get', 'post', 'put', 'patch', 'delete', 'head']) {
    registrar[method] = (path, ...handlers) => app[method](
      path,
      ...handlers.map((handler) => (req, res, next) => {
        requestTracker.run(() => handler(req, res, next)).catch(next);
      }),
    );
  }
  return registrar;
}

const MAX_RECOVERY_FAILURE_LOG_DETAILS = 5;

function safeRecoveryLocation(failure) {
  const parts = [failure?.bookId, failure?.sectionId]
    .filter((value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value));
  return parts.length ? parts.join(' / ') : '未知位置';
}

function safeLogErrorCode(value) {
  return typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,127}$/.test(value)
    ? value
    : 'UNKNOWN';
}

function safeLogHost(value) {
  return typeof value === 'string'
    && /^[A-Za-z0-9._:%-]{1,255}$/.test(value)
    ? value
    : '无效地址';
}

function safeLogPort(value) {
  return Number.isInteger(value) && value >= 1 && value <= 65535
    ? String(value)
    : '无效端口';
}

export function reportStructureRecovery(recovery, logger = console) {
  const recovered = Number.isSafeInteger(recovery?.recovered) && recovery.recovered > 0
    ? recovery.recovered
    : 0;
  const failures = Array.isArray(recovery?.failures) ? recovery.failures : [];
  if (recovered) logger.log(`已恢复 ${recovered} 个中断的结构事务`);
  if (!failures.length) return;

  logger.warn(`有 ${failures.length} 个结构事务无法自动恢复${recovery?.truncated ? '，已达到安全上限并停止扫描' : ''}：`);
  for (const failure of failures.slice(0, MAX_RECOVERY_FAILURE_LOG_DETAILS)) {
    logger.warn(
      `- ${safeRecoveryLocation(failure)}（${safeLogErrorCode(failure?.error)}）`,
    );
  }
  if (failures.length > MAX_RECOVERY_FAILURE_LOG_DETAILS) {
    logger.warn(
      `- 其余 ${failures.length - MAX_RECOVERY_FAILURE_LOG_DETAILS} 个未展开，请查看书架完整性告警`,
    );
  }
  if (recovery?.truncated) {
    logger.warn('- 后续结构事务未继续自动扫描，请在书架运行完整性检查');
  }
  logger.warn('应用未自动覆盖或删除冲突数据；请先备份 data/ 目录，再查看书架完整性告警');
}

export function announceServerListening({
  host,
  port,
  shouldOpenBrowser = false,
  browserOpener = openBrowser,
  logger = console,
}) {
  const displayHost = host.includes(':') ? `[${host}]` : host;
  const url = `http://${displayHost}:${port}`;
  const logHost = safeLogHost(host);
  const logDisplayHost = logHost.includes(':') ? `[${logHost}]` : logHost;
  logger.log(`自动小说盒子已启动：http://${logDisplayHost}:${safeLogPort(port)}`);
  if (!shouldOpenBrowser) return url;
  if (!isLoopbackHostname(host)) {
    logger.warn('已跳过自动打开浏览器：服务监听地址不是本机回环地址');
    return url;
  }
  const reportBrowserFailure = (error) => {
    logger.warn(
      `浏览器自动打开失败，请手动访问上述地址（${safeLogErrorCode(error?.code || error?.message)}）`,
    );
  };
  try {
    const launched = browserOpener(url);
    // child_process.spawn 的可执行文件缺失等错误会在返回后异步触发，
    // 单靠上面的 try/catch 无法给用户留下手动访问提示。
    launched?.once?.('error', reportBrowserFailure);
  } catch (error) {
    reportBrowserFailure(error);
  }
  return url;
}

export function attachServerLifecycle(server, {
  processRef = process,
  host = '127.0.0.1',
  port = 4399,
  shutdownTimeoutMs = 5000,
  waitForRequests = async () => {},
  cleanup = async () => {},
  logger = console,
} = {}) {
  let shuttingDown = false;
  let finished = false;
  let forced = false;
  let serverClosed = false;
  let closeError = null;
  let forceTimer = null;
  let resolveClosed;
  const closed = new Promise((resolve) => { resolveClosed = resolve; });

  const removeSignalListeners = () => {
    processRef.off('SIGINT', onSigint);
    processRef.off('SIGTERM', onSigterm);
    processRef.off('SIGHUP', onSighup);
  };
  const finish = async (closeError) => {
    if (finished) return;
    finished = true;
    if (forceTimer) clearTimeout(forceTimer);
    removeSignalListeners();
    server.off('error', onServerError);
    if (closeError) {
      processRef.exitCode = 1;
      logger.error(`服务关闭失败（${safeLogErrorCode(closeError?.code || closeError?.message)}）`);
    }
    try {
      await cleanup({ forced });
    } catch (error) {
      processRef.exitCode = 1;
      logger.warn(`关闭清理失败（${safeLogErrorCode(error?.code || error?.message)}）`);
    }
    resolveClosed();
  };
  const shutdown = (signal) => {
    if (shuttingDown) {
      forced = true;
      processRef.exitCode = 1;
      logger.warn(`再次收到 ${signal}，正在强制断开剩余连接`);
      server.closeAllConnections?.();
      if (serverClosed) void finish(closeError);
      return;
    }
    shuttingDown = true;
    logger.log(`收到 ${signal}，正在等待进行中的请求安全结束…`);
    forceTimer = setTimeout(() => {
      forced = true;
      processRef.exitCode = 1;
      logger.warn(`等待超过 ${shutdownTimeoutMs}ms，正在强制断开剩余连接`);
      server.closeAllConnections?.();
      if (serverClosed) void finish(closeError);
    }, Math.max(0, shutdownTimeoutMs));
    forceTimer.unref?.();
    try {
      server.close((error) => {
        serverClosed = true;
        closeError = error ?? null;
        if (error || forced) {
          if (error) forced = true;
          void finish(error);
          return;
        }
        // server.close 只证明连接已经结束。客户端可能在一次不可逆写入的
        // 提交边界后断开，此时 Express 的异步路由仍会继续收尾；必须等所有
        // 已登记路由 Promise 归零后才可清理资源并释放数据目录租约。
        Promise.resolve()
          .then(() => waitForRequests())
          .then(() => { if (!finished) void finish(); })
          .catch((waitError) => {
            forced = true;
            processRef.exitCode = 1;
            void finish(waitError);
          });
      });
    } catch (error) {
      forced = true;
      void finish(error);
    }
  };
  function onSigint() { shutdown('SIGINT'); }
  function onSigterm() { shutdown('SIGTERM'); }
  function onSighup() { shutdown('SIGHUP'); }
  const onServerError = (error) => {
    processRef.exitCode = 1;
    if (error?.code === 'EADDRINUSE') {
      logger.error(`启动失败：${safeLogHost(host)}:${safeLogPort(port)} 已被占用，请关闭占用程序或改用 PORT=5001`);
    } else if (error?.code === 'EACCES') {
      logger.error(`启动失败：没有权限监听 ${safeLogHost(host)}:${safeLogPort(port)}`);
    } else {
      logger.error(`服务错误（${safeLogErrorCode(error?.code || error?.message)}）`);
    }
    // listen 失败时不会收到 SIGTERM，也没有可关闭的监听句柄；立即执行清理，
    // 尤其要释放数据目录租约，避免下次启动只能走陈旧租约接管。
    if (!server.listening) void finish();
  };

  processRef.on('SIGINT', onSigint);
  processRef.on('SIGTERM', onSigterm);
  // 双击启动后直接关闭终端窗口通常会发送 SIGHUP；也走同一关闭链，避免
  // 跳过进行中请求取消、预备备份清理和数据目录租约释放。
  processRef.on('SIGHUP', onSighup);
  server.on('error', onServerError);
  return {
    shutdown,
    closed,
    dispose() {
      if (forceTimer) clearTimeout(forceTimer);
      removeSignalListeners();
      server.off('error', onServerError);
    },
  };
}

export function createApp({
  listenHost = resolveListenHost(process.env.HOST),
  allowedHosts = process.env.ALLOWED_HOSTS,
  publicOrigin = process.env.PUBLIC_ORIGIN,
  requestTracker = createInFlightRequestTracker(),
} = {}) {
  const app = express();
  const apiRoutes = createTrackedRouteRegistrar(app, requestTracker);
  app.locals.requestTracker = requestTracker;
  const webDist = WEB_DIST;
  // API 与静态资源路径只有小写这一套规范入口。若沿用 Express 默认的
  // 大小写不敏感匹配，`/API/...` 会成为容易遗漏安全中间件的隐藏别名。
  app.enable('case sensitive routing');
  mountRequestSecurity(app, {
    listenHost,
    allowedHosts,
    publicOrigin,
  });
  // 只有 API 会消费 JSON。若把解析器挂在全站，跨站页面可向任意静态路径
  // POST 大体积 JSON，虽不能改数据，仍会无意义地占用最多 2 MiB 解析开销。
  app.use('/api', express.json({ limit: JSON_BODY_LIMIT }));

  apiRoutes.get('/api/health', (req, res) => res.json({ ok: true }));
  mountConfigRoutes(apiRoutes, { discoverLlmModels });
  mountStorageRoutes(apiRoutes);
  mountBookRoutes(apiRoutes, { nonStreamChat });
  mountGenRoutes(apiRoutes, { streamChat, nonStreamChat, extractDigest });
  mountAssetRoutes(apiRoutes, { nonStreamChat });

  // 同时收敛全局 JSON 与备份上传解析错误，确保 API 不回落为 Express HTML。
  app.use((err, req, res, next) => {
    if (err?.type === 'entity.parse.failed' || err?.type === 'entity.too.large') {
      const tooLarge = err?.type === 'entity.too.large';
      const error = tooLarge
        ? (req.path === '/api/backups/import' ? 'BACKUP_TOO_LARGE' : 'REQUEST_TOO_LARGE')
        : 'INVALID_JSON';
      return res.status(tooLarge ? 413 : 400).json({ error });
    }
    if (res.headersSent) return next(err);
    return sendJsonError(res, err);
  });

  // 未匹配的 /api 一律 404（避免被 SPA 回退吞掉）
  app.use((req, res, next) => {
    const path = typeof req.path === 'string' ? req.path.toLowerCase() : '';
    if (path === '/api' || path.startsWith('/api/')) {
      return res.status(404).json({ error: 'NOT_FOUND' });
    }
    return next();
  });

  // 静态资源 + SPA 回退。启动器会对构建产物做全量指纹校验，
  // 但 npm start / 直接运行服务不能依赖启动器作为唯一安全边界。
  // 每个静态请求都拒绝路径中的软链接和特殊文件，避免把 data/
  // 或其它目录的内容透过 dist 内链接对外返回。
  app.use(async (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    try {
      const status = await verifyStaticRequestPath(webDist, req.path);
      if (status === 'unsafe') {
        res.setHeader('Cache-Control', 'no-store');
        return res.status(404).type('text/plain').send('NOT_FOUND');
      }
      return next();
    } catch (error) {
      return next(error);
    }
  });
  app.use(express.static(webDist, {
    index: false,
    setHeaders(res, path) {
      // Vite 产物名包含内容哈希，可长期缓存且不会在内容变化后复用 URL；
      // 普通文件仍需每次重验证，避免未来加入未指纹资源后被长期卡旧。
      const fingerprintedAsset = /[\\/]assets[\\/][^\\/]+-[A-Za-z0-9_-]{8,}\.[^\\/]+$/u
        .test(path);
      res.setHeader('Cache-Control', fingerprintedAsset
        ? 'public, max-age=31536000, immutable'
        : 'no-cache');
    },
  }));
  app.get('*', async (req, res, next) => {
    const index = join(webDist, 'index.html');
    try {
      // HTML 必须在每次导航时向当前服务确认，否则新构建可能继续引用
      // 已删除的旧哈希资源。no-cache 仍允许浏览器复用经 304 验证的正文。
      res.setHeader('Cache-Control', 'no-cache');
      if (await verifySpaIndex(webDist)) return res.sendFile(index);
      return res.status(200).send('前端尚未构建，请运行 npm run build');
    } catch (error) {
      return next(error);
    }
  });

  // express.static / sendFile 位于 API 错误中间件之后，Range 越界、
  // 文件权限异常等错误会在这一层才产生。若没有最终兜底，Express
  // 默认开发错误页会把服务端绝对路径和调用栈返回给客户端。
  app.use((err, req, res, next) => {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    const path = typeof req.path === 'string' ? req.path.toLowerCase() : '';
    if (path === '/api' || path.startsWith('/api/')) return sendJsonError(res, err);

    const candidateStatus = err?.statusCode ?? err?.status;
    const status = Number.isInteger(candidateStatus)
      && candidateStatus >= 400 && candidateStatus < 500
      ? candidateStatus
      : 500;
    const publicCode = new Map([
      [400, 'BAD_REQUEST'],
      [403, 'FORBIDDEN'],
      [404, 'NOT_FOUND'],
      [416, 'RANGE_NOT_SATISFIABLE'],
    ]).get(status) || 'STATIC_RESOURCE_ERROR';
    res.setHeader('Cache-Control', 'no-store');
    return res.status(status).type('text/plain').send(publicCode);
  });

  return app;
}

export async function startStandaloneServer({
  port = resolveListenPort(process.env.PORT),
  host = resolveListenHost(process.env.HOST),
  allowNetworkAccess = process.env.ALLOW_NETWORK_ACCESS,
  allowedHosts = process.env.ALLOWED_HOSTS,
  publicOrigin = process.env.PUBLIC_ORIGIN,
  shouldOpenBrowser = process.env.NOVELBOX_OPEN_BROWSER === '1',
  logger = console,
  appFactory = createApp,
  acquireLease = acquireDataRootLease,
  cleanupTransfers = cleanupAbandonedTransferDirs,
  cleanupImports = cleanupAbandonedImports,
  recoverTransactions = recoverInterruptedTransactions,
  cleanupBackups = cleanupPreparedBackups,
  createRequestTracker = createInFlightRequestTracker,
  processRef = process,
} = {}) {
  if (!isAllowedListenHost(host, allowNetworkAccess)) {
    const error = new Error('NETWORK_ACCESS_NOT_ALLOWED');
    error.listenHost = host;
    throw error;
  }

  const lease = await acquireLease({ host, port });
  let lifecycle;
  try {
    try {
      const cleanup = await cleanupTransfers();
      if (cleanup.truncated) {
        logger.warn(
          '备份临时目录子项过多，本次残留清理只扫描前 '
            + String(cleanup.scannedEntries) + ' 项',
        );
      }
      if (cleanup.removed) logger.log(`已清理 ${cleanup.removed} 个中断的备份传输临时目录`);
    } catch (error) {
      logger.warn(`备份传输临时目录清理失败，服务仍将启动：${safeLogErrorCode(error?.code || error?.message)}`);
    }
    try {
      const cleanup = await cleanupImports();
      if (cleanup.removed) logger.log(`已清理 ${cleanup.removed} 个中断的新建/导入暂存目录`);
    } catch (error) {
      logger.warn(`新建/导入暂存目录清理失败，服务仍将启动：${safeLogErrorCode(error?.code || error?.message)}`);
    }
    try {
      const recovery = await recoverTransactions();
      reportStructureRecovery(recovery, logger);
    } catch (error) {
      logger.warn(
        `结构事务恢复失败，服务仍将启动：${safeLogErrorCode(error?.code || error?.message)}`,
      );
    }

    const requestTracker = createRequestTracker();
    const server = appFactory({
      listenHost: host, allowedHosts, publicOrigin, requestTracker,
    }).listen(
      port,
      host,
      () => announceServerListening({ host, port, shouldOpenBrowser, logger }),
    );
    configureHttpServerLimits(server);
    lifecycle = attachServerLifecycle(server, {
      processRef,
      host,
      port,
      logger,
      waitForRequests: () => requestTracker.waitForIdle(),
      cleanup: async ({ forced = false } = {}) => {
        try {
          const removed = await cleanupBackups();
          if (removed) logger.log(`已清理 ${removed} 个尚未下载的预备备份`);
        } finally {
          // closeAllConnections 只证明 socket 已断开，不证明 Express 异步处理
          // 已停止。强制关闭时保留租约直到进程真正退出，避免新实例与旧进程
          // 仍在收尾的原子写并发；下次启动会凭死亡 PID 安全接管该租约。
          if (forced) {
            logger.warn('服务已强制关闭连接；数据目录租约将保留到进程退出');
            return;
          }
          const released = await lease.release();
          if (!released) logger.warn('数据目录租约已不属于当前进程；未删除其他实例的租约');
        }
      },
    });
    return { server, lifecycle, lease };
  } catch (error) {
    if (!lifecycle) await lease.release().catch(() => {});
    throw error;
  }
}

export function startupFailureMessage(error, { host, port } = {}) {
  if (error?.message === 'PUBLIC_ORIGIN_INVALID') {
    return '启动失败：PUBLIC_ORIGIN 必须是完整的 http(s) Origin，例如 https://novel.example，且不能包含路径、查询参数或账号密码。';
  }
  if (error?.message === 'NETWORK_ACCESS_NOT_ALLOWED') {
    return `已拒绝监听非本机地址 ${safeLogHost(error.listenHost || host)}：服务没有登录验证。如确需在可信网络中开放，请同时设置 ALLOW_NETWORK_ACCESS=1。`;
  }
  if (error?.message === 'INSTANCE_ALREADY_RUNNING') {
    const owner = error.owner;
    const location = owner && Number.isInteger(owner.pid) && owner.pid > 0
      ? `（PID ${owner.pid}，${safeLogHost(owner.host)}:${safeLogPort(owner.port)}）`
      : '';
    return `启动失败：另一个自动小说盒子实例正在使用 data 目录${location}。为避免作品并发写坏，本实例已退出。`;
  }
  if (error?.message === 'INSTANCE_LOCK_INVALID') {
    return '启动失败：data/.instance-lock.json 无法安全验证。请确认没有其他实例运行，备份 data 目录后再人工检查该文件。';
  }
  if (error?.message === 'INSTANCE_LOCK_BUSY') {
    return '启动失败：数据目录租约正在被另一个启动进程接管，请稍后重试。';
  }
  return `启动失败（${safeLogErrorCode(error?.code || error?.message)}，${safeLogHost(host)}:${safeLogPort(port)}）`;
}

// 直接运行时启动服务（用 pathToFileURL 兼容含中文/特殊字符的路径）
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = resolveListenPort(process.env.PORT);
  const host = resolveListenHost(process.env.HOST);
  try {
    await startStandaloneServer({ port, host });
  } catch (error) {
    console.error(startupFailureMessage(error, { host, port }));
    process.exitCode = 1;
  }
}
