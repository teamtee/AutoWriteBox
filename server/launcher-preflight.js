import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants, createReadStream } from 'node:fs';
import {
  lstat, open, readdir, realpath, rename, unlink,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { isIP } from 'node:net';
import {
  dirname, isAbsolute, join, relative, resolve, sep,
} from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFileHandleBounded } from './bounded-io.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(HERE, '..');
const FRONTEND_STAMP_VERSION = '2';
const FRONTEND_STAMP = '.novelbox-build.sha256';
const DEPENDENCY_STAMP_VERSION = '1';
const DEPENDENCY_STAMP = '.novelbox-dependencies.sha256';
const MAX_PACKAGE_JSON_BYTES = 2 * 1024 * 1024;
const MAX_PACKAGE_LOCK_BYTES = 32 * 1024 * 1024;
const MAX_STAMP_BYTES = 4096;
const MAX_HTML_BYTES = 4 * 1024 * 1024;
const MAX_FINGERPRINT_FILE_BYTES = 64 * 1024 * 1024;
const MAX_FINGERPRINT_FILES = 50_000;
const MAX_FINGERPRINT_TREE_ENTRIES = 100_000;
const MAX_FINGERPRINT_DEPTH = 64;
const MAX_DEPENDENCY_FINGERPRINT_BYTES = 512 * 1024 * 1024;
const MAX_FRONTEND_SOURCE_FINGERPRINT_BYTES = 128 * 1024 * 1024;
const MAX_FRONTEND_BUILD_FINGERPRINT_BYTES = 256 * 1024 * 1024;

async function assertPlainDirectory(path, invalidCode) {
  try {
    const metadata = await lstat(path);
    if (!metadata.isDirectory()) throw new Error(invalidCode);
  } catch (error) {
    if (error?.message === invalidCode) throw error;
    throw new Error(invalidCode);
  }
}

async function atomicWriteStamp(path, text, invalidCode) {
  // 固定戳路径可能被损坏的依赖树预先放成符号链接；普通 writeFile 会
  // 跟随它并改写项目外文件。私有随机临时文件使用 O_EXCL 创建，刷盘后
  // rename 只替换目录项本身，不会跟随最终目标链接。
  const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  try {
    await assertPlainDirectory(dirname(path), invalidCode);
    handle = await open(
      tempPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
    await handle.writeFile(text, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await assertPlainDirectory(dirname(path), invalidCode);
    await rename(tempPath, path);
  } catch (error) {
    await handle?.close().catch(() => {});
    await unlink(tempPath).catch(() => {});
    throw error;
  }
}

async function readRegularFileBounded(path, maxBytes, invalidCode) {
  let handle;
  try {
    handle = await open(
      path,
      constants.O_RDONLY
        | (constants.O_NOFOLLOW ?? 0)
        | (constants.O_NONBLOCK ?? 0),
    );
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new Error(invalidCode);
    const bytes = await readFileHandleBounded(handle, maxBytes);
    if (bytes === null) throw new Error(invalidCode);
    return bytes;
  } catch (error) {
    if (error?.code === 'ELOOP') throw new Error(invalidCode);
    throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

function decodeUtf8(bytes, invalidCode) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new Error(invalidCode); }
}

async function readJson(path) {
  const isLock = path.endsWith('package-lock.json');
  const bytes = await readRegularFileBounded(
    path,
    isLock ? MAX_PACKAGE_LOCK_BYTES : MAX_PACKAGE_JSON_BYTES,
    isLock ? 'DEPENDENCY_LOCK_INVALID' : 'DEPENDENCY_MANIFEST_INVALID',
  );
  return JSON.parse(decodeUtf8(
    bytes, isLock ? 'DEPENDENCY_LOCK_INVALID' : 'DEPENDENCY_MANIFEST_INVALID',
  ));
}

function dependencyPathSegments(packagePath) {
  const segments = packagePath.split('/');
  if (segments.length < 2 || segments[0] !== 'node_modules'
    || segments.some((segment) => !segment || segment === '.' || segment === '..'
      || /[\\\u0000-\u001f\u007f]/u.test(segment))) return null;
  return segments;
}

async function readInstalledPackage(root, packagePath) {
  const segments = dependencyPathSegments(packagePath);
  if (!segments) throw new Error('DEPENDENCY_PATH_INVALID');
  let packageRoot = root;
  for (const segment of segments) {
    packageRoot = join(packageRoot, segment);
    if (!(await lstat(packageRoot)).isDirectory()) {
      throw new Error('DEPENDENCY_PATH_INVALID');
    }
  }
  const manifestPath = join(packageRoot, 'package.json');
  if (!(await lstat(manifestPath)).isFile()) {
    throw new Error('DEPENDENCY_PATH_INVALID');
  }
  return readJson(manifestPath);
}

function packageNameFromLockPath(packagePath) {
  const marker = 'node_modules/';
  const markerIndex = packagePath.lastIndexOf(marker);
  if (markerIndex < 0) return null;
  const parts = packagePath.slice(markerIndex + marker.length).split('/');
  if (parts[0]?.startsWith('@')) {
    return parts.length === 2 && parts[0].length > 1 && parts[1]
      ? parts[0] + '/' + parts[1]
      : null;
  }
  return parts.length === 1 && parts[0] ? parts[0] : null;
}

function verifyInstallScriptPolicy(manifest, lock) {
  const lockedScripts = [];
  for (const [packagePath, metadata] of Object.entries(lock.packages)) {
    if (!metadata?.hasInstallScript) continue;
    const name = packageNameFromLockPath(packagePath);
    if (!name || typeof metadata.version !== 'string' || !metadata.version) return false;
    lockedScripts.push(name + '@' + metadata.version);
  }
  lockedScripts.sort();
  const policy = manifest?.allowScripts;
  if (policy === undefined) return lockedScripts.length === 0;
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) return false;
  if (Object.values(policy).some((allowed) => allowed !== true)) return false;
  return JSON.stringify(Object.keys(policy).sort()) === JSON.stringify(lockedScripts);
}

export async function verifyInstalledDependencies(root = DEFAULT_ROOT, {
  includeDev = false,
  verifyScripts = false,
  verifyContent = false,
} = {}) {
  try {
    await assertPlainDirectory(join(root, 'node_modules'), 'DEPENDENCY_INSTALL_INVALID');
    const manifest = await readJson(join(root, 'package.json'));
    const lock = await readJson(join(root, 'package-lock.json'));
    if (!lock?.packages || typeof lock.packages !== 'object') return false;
    const lockedRoot = lock.packages[''];
    const directPackagePaths = new Set();
    const productionPackagePaths = new Set();
    const dependencyFields = includeDev
      ? ['dependencies', 'optionalDependencies', 'devDependencies']
      : ['dependencies', 'optionalDependencies'];
    for (const field of dependencyFields) {
      const declared = manifest?.[field] || {};
      const recorded = lockedRoot?.[field] || {};
      if (typeof declared !== 'object' || Array.isArray(declared)
        || typeof recorded !== 'object' || Array.isArray(recorded)) return false;
      const declaredEntries = Object.entries(declared).sort();
      const recordedEntries = Object.entries(recorded).sort();
      if (JSON.stringify(declaredEntries) !== JSON.stringify(recordedEntries)) return false;
      for (const [name] of declaredEntries) {
        const packagePath = 'node_modules/' + name;
        directPackagePaths.add(packagePath);
        if (field !== 'devDependencies') productionPackagePaths.add(packagePath);
      }
    }
    if (verifyScripts && !verifyInstallScriptPolicy(manifest, lock)) return false;
    for (const packagePath of directPackagePaths) {
      if (!dependencyPathSegments(packagePath)
        || !Object.hasOwn(lock.packages, packagePath)) return false;
      const metadata = lock.packages[packagePath];
      if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)
        || (metadata.dev && productionPackagePaths.has(packagePath))
        || metadata.link) return false;
    }
    for (const [packagePath, metadata] of Object.entries(lock.packages)) {
      if (!packagePath.startsWith('node_modules/') || (metadata?.dev && !includeDev)) continue;
      if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return false;
      if (metadata?.link) return false;
      let installed;
      try {
        installed = await readInstalledPackage(root, packagePath);
      } catch (error) {
        if (metadata?.optional && error?.code === 'ENOENT') continue;
        return false;
      }
      if (installed?.version !== metadata?.version) return false;
    }
    const requireFromRoot = createRequire(join(root, 'package.json'));
    for (const name of Object.keys(manifest.dependencies || {})) {
      let packageRoot;
      let entryPoint;
      try {
        packageRoot = await realpath(resolve(root, 'node_modules', name));
        entryPoint = requireFromRoot.resolve(name);
      }
      catch { return false; }
      const entryRelative = relative(packageRoot, entryPoint);
      if (!entryRelative || entryRelative === '..' || entryRelative.startsWith(`..${sep}`)
        || isAbsolute(entryRelative)) return false;
      try {
        if (!(await lstat(entryPoint)).isFile()) return false;
      } catch { return false; }
    }
    if (verifyContent && !await isDependencyInstallCurrent(root)) return false;
    return true;
  } catch {
    return false;
  }
}

async function listFilesRecursively(root, { invalidCode } = {}) {
  const files = [];
  let treeEntries = 0;
  const visit = async (directory, depth = 0) => {
    if (depth > MAX_FINGERPRINT_DEPTH) throw new Error(invalidCode || 'FINGERPRINT_TREE_LIMIT');
    const entries = await readdir(directory, { withFileTypes: true });
    treeEntries += entries.length;
    if (treeEntries > MAX_FINGERPRINT_TREE_ENTRIES) {
      throw new Error(invalidCode || 'FINGERPRINT_TREE_LIMIT');
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path, depth + 1);
      else if (entry.isFile()) {
        files.push(path);
        if (files.length > MAX_FINGERPRINT_FILES) {
          throw new Error(invalidCode || 'FINGERPRINT_TREE_LIMIT');
        }
      }
      else if (invalidCode) throw new Error(invalidCode);
    }
  };
  try {
    if (invalidCode) {
      const metadata = await lstat(root);
      if (!metadata.isDirectory()) throw new Error(invalidCode);
    }
    await visit(root);
  }
  catch (error) { if (error?.code !== 'ENOENT') throw error; }
  return files;
}

function createFingerprintBudget(maxBytes) {
  return { bytes: 0, files: 0, maxBytes };
}

function accountFingerprintBytes(budget, byteLength) {
  budget.bytes += byteLength;
  if (budget.bytes > budget.maxBytes) throw new Error('FINGERPRINT_CONTENT_LIMIT');
}

async function hashFileInto(hash, path, budget) {
  if (budget.files >= MAX_FINGERPRINT_FILES) throw new Error('FINGERPRINT_FILE_LIMIT');
  let handle;
  try {
    handle = await open(
      path,
      constants.O_RDONLY
        | (constants.O_NOFOLLOW ?? 0)
        | (constants.O_NONBLOCK ?? 0),
    );
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new Error('FINGERPRINT_CONTENT_INVALID');
    if (metadata.size > MAX_FINGERPRINT_FILE_BYTES) {
      throw new Error('FINGERPRINT_FILE_TOO_LARGE');
    }
    budget.files += 1;
    let fileBytes = 0;
    for await (const chunk of createReadStream(path, {
      fd: handle.fd,
      autoClose: false,
      start: 0,
      highWaterMark: 64 * 1024,
    })) {
      fileBytes += chunk.length;
      if (fileBytes > MAX_FINGERPRINT_FILE_BYTES) {
        throw new Error('FINGERPRINT_FILE_TOO_LARGE');
      }
      accountFingerprintBytes(budget, chunk.length);
      hash.update(chunk);
    }
  } catch (error) {
    if (error?.code === 'ELOOP') throw new Error('FINGERPRINT_CONTENT_INVALID');
    throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function dependencyContentFingerprint(root) {
  await assertPlainDirectory(join(root, 'node_modules'), 'DEPENDENCY_CONTENT_INVALID');
  const [manifestBytes, lockBytes] = await Promise.all([
    readRegularFileBounded(
      join(root, 'package.json'), MAX_PACKAGE_JSON_BYTES, 'DEPENDENCY_MANIFEST_INVALID',
    ),
    readRegularFileBounded(
      join(root, 'package-lock.json'), MAX_PACKAGE_LOCK_BYTES, 'DEPENDENCY_LOCK_INVALID',
    ),
  ]);
  const lock = JSON.parse(decodeUtf8(lockBytes, 'DEPENDENCY_LOCK_INVALID'));
  if (!lock?.packages || typeof lock.packages !== 'object') {
    throw new Error('DEPENDENCY_LOCK_INVALID');
  }
  const packagePaths = Object.entries(lock.packages)
    .filter(([packagePath, metadata]) =>
      packagePath.startsWith('node_modules/') && metadata && !metadata.dev)
    .map(([packagePath]) => packagePath)
    .sort();
  const hash = createHash('sha256');
  const budget = createFingerprintBudget(MAX_DEPENDENCY_FINGERPRINT_BYTES);
  hash.update('auto-novel-box-dependencies\0' + DEPENDENCY_STAMP_VERSION + '\0');
  accountFingerprintBytes(budget, manifestBytes.length);
  hash.update(manifestBytes);
  hash.update('\0');
  accountFingerprintBytes(budget, lockBytes.length);
  hash.update(lockBytes);
  hash.update('\0');
  for (const packagePath of packagePaths) {
    const metadata = lock.packages[packagePath];
    if (!dependencyPathSegments(packagePath)
      || !metadata || typeof metadata !== 'object' || Array.isArray(metadata)
      || metadata.link) {
      throw new Error('DEPENDENCY_PATH_INVALID');
    }
    try {
      await readInstalledPackage(root, packagePath);
    } catch (error) {
      if (metadata.optional && error?.code === 'ENOENT') continue;
      throw error;
    }
    const packageRoot = join(root, ...dependencyPathSegments(packagePath));
    const files = await listFilesRecursively(packageRoot, {
      invalidCode: 'DEPENDENCY_CONTENT_INVALID',
    });
    hash.update(packagePath);
    hash.update('\0');
    for (const file of files.sort()) {
      hash.update(relative(root, file));
      hash.update('\0');
      await hashFileInto(hash, file, budget);
      hash.update('\0');
    }
  }
  return hash.digest('hex');
}

export async function isDependencyInstallCurrent(root = DEFAULT_ROOT) {
  try {
    const recorded = decodeUtf8(await readRegularFileBounded(
      join(root, 'node_modules', DEPENDENCY_STAMP),
      MAX_STAMP_BYTES,
      'DEPENDENCY_STAMP_INVALID',
    ), 'DEPENDENCY_STAMP_INVALID').trim().split(/\r?\n/);
    if (recorded.length !== 2 || recorded[0] !== DEPENDENCY_STAMP_VERSION) return false;
    return recorded[1] === await dependencyContentFingerprint(root);
  } catch {
    return false;
  }
}

export async function recordDependencyInstall(root = DEFAULT_ROOT) {
  if (!await verifyInstalledDependencies(root)) {
    throw new Error('DEPENDENCY_INSTALL_INVALID');
  }
  const fingerprint = await dependencyContentFingerprint(root);
  await atomicWriteStamp(
    join(root, 'node_modules', DEPENDENCY_STAMP),
    DEPENDENCY_STAMP_VERSION + '\n' + fingerprint + '\n',
    'DEPENDENCY_INSTALL_INVALID',
  );
  if (!await verifyInstalledDependencies(root, { verifyContent: true })) {
    throw new Error('DEPENDENCY_INSTALL_INVALID');
  }
  return fingerprint;
}

export async function frontendFingerprint(root = DEFAULT_ROOT) {
  const webRoot = join(root, 'web');
  await assertPlainDirectory(webRoot, 'FRONTEND_SOURCE_INVALID');
  const candidates = [
    ...await listFilesRecursively(join(webRoot, 'src'), {
      invalidCode: 'FRONTEND_SOURCE_INVALID',
    }),
    ...await listFilesRecursively(join(webRoot, 'public'), {
      invalidCode: 'FRONTEND_SOURCE_INVALID',
    }),
  ];
  for (const name of [
    'index.html', 'package.json', 'package-lock.json', '.npmrc',
    'tsconfig.json', 'tsconfig.app.json', 'tsconfig.node.json',
    'vite.config.js', 'vite.config.mjs', 'vite.config.ts',
  ]) {
    const path = join(webRoot, name);
    try {
      const metadata = await lstat(path);
      if (!metadata.isFile()) throw new Error('FRONTEND_SOURCE_INVALID');
      candidates.push(path);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  candidates.sort();
  if (!candidates.length) throw new Error('FRONTEND_SOURCE_MISSING');
  const hash = createHash('sha256');
  const budget = createFingerprintBudget(MAX_FRONTEND_SOURCE_FINGERPRINT_BYTES);
  hash.update(`auto-novel-box-frontend\0${FRONTEND_STAMP_VERSION}\0`);
  for (const path of candidates) {
    hash.update(relative(root, path));
    hash.update('\0');
    await hashFileInto(hash, path, budget);
    hash.update('\0');
  }
  return hash.digest('hex');
}

async function verifyBuiltAssets(root) {
  const distRoot = join(root, 'web', 'dist');
  let html;
  try {
    await assertPlainDirectory(join(root, 'web'), 'FRONTEND_BUILD_INVALID');
    await assertPlainDirectory(distRoot, 'FRONTEND_BUILD_INVALID');
    html = decodeUtf8(await readRegularFileBounded(
      join(distRoot, 'index.html'), MAX_HTML_BYTES, 'FRONTEND_BUILD_INVALID',
    ), 'FRONTEND_BUILD_INVALID');
  }
  catch { return false; }
  const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"?#]+)"/g)]
    .map((match) => match[1]);
  if (!assets.length) return false;
  for (const asset of assets) {
    let decoded;
    try { decoded = decodeURIComponent(asset); }
    catch { return false; }
    const segments = decoded.slice(1).split('/');
    if (segments[0] !== 'assets'
      || segments.some((segment) => !segment || segment === '.' || segment === '..'
        || /[\\\u0000-\u001f\u007f]/u.test(segment))) return false;
    try {
      if (!(await lstat(join(distRoot, ...segments))).isFile()) return false;
    } catch { return false; }
  }
  return true;
}

async function builtAssetsFingerprint(root) {
  if (!await verifyBuiltAssets(root)) throw new Error('FRONTEND_BUILD_INVALID');
  const distRoot = join(root, 'web', 'dist');
  const files = (await listFilesRecursively(distRoot, {
    invalidCode: 'FRONTEND_BUILD_INVALID',
  }))
    .filter((path) => path !== join(distRoot, FRONTEND_STAMP))
    .sort();
  if (!files.length) throw new Error('FRONTEND_BUILD_INVALID');
  const hash = createHash('sha256');
  const budget = createFingerprintBudget(MAX_FRONTEND_BUILD_FINGERPRINT_BYTES);
  hash.update(`auto-novel-box-dist\0${FRONTEND_STAMP_VERSION}\0`);
  for (const path of files) {
    hash.update(relative(distRoot, path));
    hash.update('\0');
    await hashFileInto(hash, path, budget);
    hash.update('\0');
  }
  return hash.digest('hex');
}

export async function isFrontendCurrent(root = DEFAULT_ROOT) {
  try {
    const recorded = decodeUtf8(await readRegularFileBounded(
      join(root, 'web', 'dist', FRONTEND_STAMP),
      MAX_STAMP_BYTES,
      'FRONTEND_BUILD_INVALID',
    ), 'FRONTEND_BUILD_INVALID').trim().split(/\r?\n/);
    if (recorded.length !== 3 || recorded[0] !== FRONTEND_STAMP_VERSION) return false;
    const [sourceFingerprint, distFingerprint] = await Promise.all([
      frontendFingerprint(root), builtAssetsFingerprint(root),
    ]);
    return recorded[1] === sourceFingerprint && recorded[2] === distFingerprint;
  } catch {
    return false;
  }
}

export async function assertRuntimeReady(root = DEFAULT_ROOT) {
  if (!await verifyInstalledDependencies(root, { verifyContent: true })) {
    throw new Error('DEPENDENCY_INSTALL_NOT_CURRENT');
  }
  if (!await isFrontendCurrent(root)) {
    throw new Error('FRONTEND_BUILD_NOT_CURRENT');
  }
  return true;
}

export async function recordFrontendBuild(root = DEFAULT_ROOT) {
  const [sourceFingerprint, distFingerprint] = await Promise.all([
    frontendFingerprint(root), builtAssetsFingerprint(root),
  ]);
  await atomicWriteStamp(
    join(root, 'web', 'dist', FRONTEND_STAMP),
    `${FRONTEND_STAMP_VERSION}\n${sourceFingerprint}\n${distFingerprint}\n`,
    'FRONTEND_BUILD_INVALID',
  );
  return sourceFingerprint;
}

function validateLaunchUrl(baseUrl) {
  let base;
  try { base = new URL(baseUrl); }
  catch { throw new Error('LAUNCH_URL_INVALID'); }
  const hostname = base.hostname.startsWith('[') && base.hostname.endsWith(']')
    ? base.hostname.slice(1, -1) : base.hostname;
  const isLoopback = hostname === 'localhost' || hostname === '::1'
    || (isIP(hostname) === 4 && hostname.split('.')[0] === '127');
  if (!isLoopback || base.protocol !== 'http:' || base.username || base.password
    || base.pathname !== '/' || base.search || base.hash) {
    throw new Error('LAUNCH_URL_INVALID');
  }
  return base;
}

export function openBrowser(baseUrl, platform = process.platform) {
  const target = validateLaunchUrl(baseUrl).href;
  let child;
  if (platform === 'darwin') child = spawn('open', [target], { stdio: 'ignore', detached: true });
  else if (platform === 'win32') {
    child = spawn('cmd', ['/c', 'start', '', target], {
      stdio: 'ignore', detached: true, windowsHide: true,
    });
  } else child = spawn('xdg-open', [target], { stdio: 'ignore', detached: true });
  child.once('error', () => {});
  child.unref();
  return child;
}

export function launcherFailureMessage(error) {
  const candidate = error?.code || error?.message;
  const code = typeof candidate === 'string' && /^[A-Z][A-Z0-9_]{0,127}$/.test(candidate)
    ? candidate
    : 'UNKNOWN';
  return `[launcher] ${code}`;
}

async function runCli(args) {
  const [mode] = args;
  if (mode === 'runtime') await assertRuntimeReady();
  else if (mode === 'dependencies') {
    process.exitCode = await verifyInstalledDependencies(DEFAULT_ROOT, {
      verifyContent: true,
    }) ? 0 : 1;
  }
  else if (mode === 'record-dependencies') await recordDependencyInstall();
  else if (mode === 'frontend-dependencies') {
    process.exitCode = await verifyInstalledDependencies(join(DEFAULT_ROOT, 'web'), {
      includeDev: true,
      verifyScripts: true,
    }) ? 0 : 1;
  }
  else if (mode === 'frontend') process.exitCode = await isFrontendCurrent() ? 0 : 1;
  else if (mode === 'record-frontend') await recordFrontendBuild();
  else throw new Error('UNKNOWN_PREFLIGHT_MODE');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await runCli(process.argv.slice(2)); }
  catch (error) {
    console.error(launcherFailureMessage(error));
    process.exitCode = 1;
  }
}
