import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdir, readFile, readdir, writeFile, rm, symlink, truncate,
} from 'node:fs/promises';
import { join } from 'node:path';
import {
  assertRuntimeReady, isDependencyInstallCurrent, isFrontendCurrent, launcherFailureMessage,
  recordDependencyInstall, recordFrontendBuild, verifyInstalledDependencies,
} from '../launcher-preflight.js';
import { cleanupTestTempDirs, makeTestTempDir } from './test-temp-dir.js';

test.afterEach(cleanupTestTempDirs);

async function writeJson(path, value) {
  await writeFile(path, JSON.stringify(value), 'utf8');
}

test('依赖预检按锁文件核对已安装版本并允许缺失的平台可选包', async () => {
  const root = makeTestTempDir('novelbox-launcher-deps-');
  await mkdir(join(root, 'node_modules', 'required'), { recursive: true });
  await writeJson(join(root, 'package.json'), {
    dependencies: { required: '1.0.0' },
  });
  await writeJson(join(root, 'package-lock.json'), { packages: {
    '': { dependencies: { required: '1.0.0' } },
    'node_modules/required': { version: '1.0.0' },
    'node_modules/optional': { version: '2.0.0', optional: true },
    'node_modules/dev-only': { version: '3.0.0', dev: true },
  } });
  await writeJson(join(root, 'node_modules', 'required', 'package.json'), {
    name: 'required', version: '1.0.0',
  });
  await writeFile(
    join(root, 'node_modules', 'required', 'index.js'),
    "module.exports = require('./internal.js');",
    'utf8',
  );
  await writeFile(
    join(root, 'node_modules', 'required', 'internal.js'),
    'module.exports = {};',
    'utf8',
  );

  assert.equal(await verifyInstalledDependencies(root), true);
  assert.equal(await isDependencyInstallCurrent(root), false);
  await recordDependencyInstall(root);
  assert.equal(await verifyInstalledDependencies(root, { verifyContent: true }), true);
  await rm(join(root, 'node_modules', 'required', 'internal.js'));
  assert.equal(await verifyInstalledDependencies(root), true);
  assert.equal(await verifyInstalledDependencies(root, { verifyContent: true }), false);
  await writeFile(
    join(root, 'node_modules', 'required', 'internal.js'),
    'module.exports = {};',
    'utf8',
  );
  assert.equal(await verifyInstalledDependencies(root, { verifyContent: true }), true);
  await writeFile(join(root, 'node_modules', 'required', 'injected.js'), 'malicious', 'utf8');
  assert.equal(await verifyInstalledDependencies(root, { verifyContent: true }), false);
  await rm(join(root, 'node_modules', 'required', 'injected.js'));
  assert.equal(await verifyInstalledDependencies(root, { verifyContent: true }), true);
  await rm(join(root, 'node_modules', 'required', 'index.js'));
  assert.equal(await verifyInstalledDependencies(root), false);
  await writeFile(join(root, 'node_modules', 'required', 'index.js'), 'module.exports = {};', 'utf8');
  await writeJson(join(root, 'package-lock.json'), { packages: {
    '': { dependencies: { required: '1.0.0' } },
  } });
  assert.equal(await verifyInstalledDependencies(root), false);
  await writeJson(join(root, 'package-lock.json'), { packages: {
    '': { dependencies: { required: '1.0.0' } },
    'node_modules/required': { version: '1.0.0' },
    'node_modules/optional': { version: '2.0.0', optional: true },
    'node_modules/dev-only': { version: '3.0.0', dev: true },
  } });
  await writeJson(join(root, 'package.json'), {
    dependencies: { required: '2.0.0' },
  });
  assert.equal(await verifyInstalledDependencies(root), false);
  await writeJson(join(root, 'package.json'), {
    dependencies: { required: '1.0.0' },
  });
  await writeJson(join(root, 'node_modules', 'required', 'package.json'), {
    name: 'required', version: '0.9.0',
  });
  assert.equal(await verifyInstalledDependencies(root), false);
});

test('依赖内容指纹在读取前拒绝异常大的单文件', async () => {
  const root = makeTestTempDir('novelbox-launcher-large-dependency-');
  await mkdir(join(root, 'node_modules', 'required'), { recursive: true });
  await writeJson(join(root, 'package.json'), {
    dependencies: { required: '1.0.0' },
  });
  await writeJson(join(root, 'package-lock.json'), { packages: {
    '': { dependencies: { required: '1.0.0' } },
    'node_modules/required': { version: '1.0.0' },
  } });
  await writeJson(join(root, 'node_modules', 'required', 'package.json'), {
    name: 'required', version: '1.0.0', main: 'index.js',
  });
  await writeFile(join(root, 'node_modules', 'required', 'index.js'), 'module.exports = {};');
  const oversized = join(root, 'node_modules', 'required', 'oversized.bin');
  await writeFile(oversized, '');
  await truncate(oversized, 64 * 1024 * 1024 + 1);

  await assert.rejects(
    () => recordDependencyInstall(root),
    /FINGERPRINT_FILE_TOO_LARGE/,
  );
});

test('记录依赖指纹时原子替换戳链接且不改写链接目标', {
  skip: process.platform === 'win32',
}, async () => {
  const root = makeTestTempDir('novelbox-launcher-stamp-link-');
  const outside = makeTestTempDir('novelbox-launcher-stamp-target-');
  const outsideFile = join(outside, 'do-not-overwrite.txt');
  await mkdir(join(root, 'node_modules'), { recursive: true });
  await writeJson(join(root, 'package.json'), {});
  await writeJson(join(root, 'package-lock.json'), { packages: { '': {} } });
  await writeFile(outsideFile, 'KEEP_ME', 'utf8');
  await symlink(
    outsideFile,
    join(root, 'node_modules', '.novelbox-dependencies.sha256'),
    'file',
  );

  await recordDependencyInstall(root);

  assert.equal(await isDependencyInstallCurrent(root), true);
  assert.equal(await readFile(outsideFile, 'utf8'), 'KEEP_ME');
});

test('记录依赖指纹拒绝作为链接的 node_modules 根目录', {
  skip: process.platform === 'win32',
}, async () => {
  const root = makeTestTempDir('novelbox-launcher-node-modules-link-');
  const outside = makeTestTempDir('novelbox-launcher-node-modules-target-');
  await writeJson(join(root, 'package.json'), {});
  await writeJson(join(root, 'package-lock.json'), { packages: { '': {} } });
  await symlink(outside, join(root, 'node_modules'), 'dir');

  await assert.rejects(() => recordDependencyInstall(root), /DEPENDENCY_INSTALL_INVALID/);
  assert.deepEqual(await readdir(outside), []);
});

test('前端依赖预检覆盖 devDependencies 并拒绝未批准的安装脚本', async () => {
  const root = makeTestTempDir('novelbox-launcher-web-deps-');
  await mkdir(join(root, 'node_modules', 'runtime'), { recursive: true });
  await mkdir(join(root, 'node_modules', 'builder'), { recursive: true });
  await writeJson(join(root, 'package.json'), {
    dependencies: { runtime: '1.0.0' },
    devDependencies: { builder: '2.0.0' },
    allowScripts: { 'builder@2.0.0': true },
  });
  const lock = { packages: {
    '': {
      dependencies: { runtime: '1.0.0' },
      devDependencies: { builder: '2.0.0' },
    },
    'node_modules/runtime': { version: '1.0.0' },
    'node_modules/builder': { version: '2.0.0', dev: true, hasInstallScript: true },
  } };
  await writeJson(join(root, 'package-lock.json'), lock);
  await writeJson(join(root, 'node_modules', 'runtime', 'package.json'), {
    name: 'runtime', version: '1.0.0',
  });
  await writeFile(
    join(root, 'node_modules', 'runtime', 'index.js'),
    'module.exports = {};',
    'utf8',
  );
  await writeJson(join(root, 'node_modules', 'builder', 'package.json'), {
    name: 'builder', version: '2.0.0',
  });

  const options = { includeDev: true, verifyScripts: true };
  assert.equal(await verifyInstalledDependencies(root, options), true);

  await mkdir(join(root, 'node_modules', 'unreviewed'));
  await writeJson(join(root, 'node_modules', 'unreviewed', 'package.json'), {
    name: 'unreviewed', version: '3.0.0',
  });
  lock.packages['node_modules/unreviewed'] = {
    version: '3.0.0', dev: true, hasInstallScript: true,
  };
  await writeJson(join(root, 'package-lock.json'), lock);
  assert.equal(await verifyInstalledDependencies(root, options), false);

  await writeJson(join(root, 'package.json'), {
    dependencies: { runtime: '1.0.0' },
    devDependencies: { builder: '2.0.0' },
    allowScripts: {
      'builder@2.0.0': true,
      'unreviewed@3.0.0': true,
    },
  });
  assert.equal(await verifyInstalledDependencies(root, options), true);
});

test('依赖预检拒绝跟随软链接执行项目外的包', {
  skip: process.platform === 'win32',
}, async () => {
  const root = makeTestTempDir('novelbox-launcher-deps-link-');
  const external = makeTestTempDir('novelbox-launcher-deps-external-');
  await mkdir(join(root, 'node_modules'), { recursive: true });
  await mkdir(join(external, 'required'), { recursive: true });
  await writeJson(join(root, 'package.json'), {
    dependencies: { required: '1.0.0' },
  });
  await writeJson(join(root, 'package-lock.json'), { packages: {
    '': { dependencies: { required: '1.0.0' } },
    'node_modules/required': { version: '1.0.0' },
  } });
  await writeJson(join(external, 'required', 'package.json'), {
    name: 'required', version: '1.0.0',
  });

  await symlink(join(external, 'required'), join(root, 'node_modules', 'required'), 'dir');
  assert.equal(await verifyInstalledDependencies(root), false);

  await rm(join(root, 'node_modules', 'required'));
  await mkdir(join(root, 'node_modules', 'required'));
  await symlink(
    join(external, 'required', 'package.json'),
    join(root, 'node_modules', 'required', 'package.json'),
    'file',
  );
  assert.equal(await verifyInstalledDependencies(root), false);

  await writeJson(join(root, 'package-lock.json'), { packages: {
    '': { dependencies: { required: '1.0.0' } },
    'node_modules/required': { version: '1.0.0', link: true },
  } });
  assert.equal(await verifyInstalledDependencies(root), false);
});

test('依赖预检拒绝锁文件中越出 node_modules 的路径', async () => {
  const root = makeTestTempDir('novelbox-launcher-deps-path-');
  await writeJson(join(root, 'package.json'), {});
  await writeJson(join(root, 'package-lock.json'), { packages: {
    '': {},
    'node_modules/../outside': { version: '1.0.0', optional: true },
  } });

  assert.equal(await verifyInstalledDependencies(root), false);
});

test('前端源码或构建资源变化会让启动预检要求重新构建', async () => {
  const root = makeTestTempDir('novelbox-launcher-web-');
  await mkdir(join(root, 'web', 'src'), { recursive: true });
  await mkdir(join(root, 'web', 'dist', 'assets'), { recursive: true });
  await writeFile(join(root, 'web', 'src', 'main.ts'), 'console.log("v1")', 'utf8');
  await writeJson(join(root, 'web', 'package.json'), { name: 'fixture' });
  await writeJson(join(root, 'web', 'package-lock.json'), { lockfileVersion: 3 });
  await writeFile(
    join(root, 'web', 'dist', 'index.html'),
    '<script type="module" src="/assets/app.js"></script>',
    'utf8',
  );
  await writeFile(join(root, 'web', 'dist', 'assets', 'app.js'), 'built', 'utf8');

  assert.equal(await isFrontendCurrent(root), false);
  await recordFrontendBuild(root);
  assert.equal(await isFrontendCurrent(root), true);
  await writeFile(join(root, 'web', 'src', 'main.ts'), 'console.log("v2")', 'utf8');
  assert.equal(await isFrontendCurrent(root), false);
  await recordFrontendBuild(root);
  await mkdir(join(root, 'web', 'public'), { recursive: true });
  await writeFile(join(root, 'web', 'public', 'icon.svg'), '<svg/>', 'utf8');
  assert.equal(await isFrontendCurrent(root), false);
  await recordFrontendBuild(root);
  await writeFile(join(root, 'web', 'dist', 'assets', 'app.js'), 'corrupted', 'utf8');
  assert.equal(await isFrontendCurrent(root), false);
  await writeFile(join(root, 'web', 'dist', 'assets', 'app.js'), 'built', 'utf8');
  await recordFrontendBuild(root);
  await writeFile(join(root, 'web', 'dist', 'unexpected.js'), 'stale', 'utf8');
  assert.equal(await isFrontendCurrent(root), false);
  await rm(join(root, 'web', 'dist', 'unexpected.js'));
  await recordFrontendBuild(root);
  await writeFile(join(root, 'web', '.npmrc'), 'ignore-scripts=true\n', 'utf8');
  assert.equal(await isFrontendCurrent(root), false);
  await recordFrontendBuild(root);
  await rm(join(root, 'web', 'dist', 'assets', 'app.js'));
  assert.equal(await isFrontendCurrent(root), false);
});

test('构建产物校验拒绝越出 dist 的资源引用', async () => {
  const root = makeTestTempDir('novelbox-launcher-assets-');
  await mkdir(join(root, 'web', 'src'), { recursive: true });
  await mkdir(join(root, 'web', 'dist', 'assets'), { recursive: true });
  await writeFile(join(root, 'web', 'src', 'main.ts'), 'export {}', 'utf8');
  await writeFile(join(root, 'web', 'outside.js'), 'outside', 'utf8');
  await writeFile(
    join(root, 'web', 'dist', 'index.html'),
    '<script type="module" src="/assets/../../outside.js"></script>',
    'utf8',
  );

  assert.equal(await isFrontendCurrent(root), false);
  await assert.rejects(() => recordFrontendBuild(root), /FRONTEND_BUILD_INVALID/);

  await writeFile(
    join(root, 'web', 'dist', 'index.html'),
    '<script type="module" src="/assets/%2e%2e/%2e%2e/outside.js"></script>',
    'utf8',
  );
  await assert.rejects(() => recordFrontendBuild(root), /FRONTEND_BUILD_INVALID/);
});

test('正式运行预检同时锁定根依赖内容和前端构建产物', async () => {
  const root = makeTestTempDir('novelbox-launcher-runtime-');
  await mkdir(join(root, 'node_modules'), { recursive: true });
  await mkdir(join(root, 'web', 'src'), { recursive: true });
  await mkdir(join(root, 'web', 'dist', 'assets'), { recursive: true });
  await writeJson(join(root, 'package.json'), {});
  await writeJson(join(root, 'package-lock.json'), { packages: { '': {} } });
  await writeFile(join(root, 'web', 'src', 'main.ts'), 'export {}', 'utf8');
  await writeJson(join(root, 'web', 'package.json'), { name: 'fixture' });
  await writeJson(join(root, 'web', 'package-lock.json'), { lockfileVersion: 3 });
  await writeFile(
    join(root, 'web', 'dist', 'index.html'),
    '<script type="module" src="/assets/app.js"></script>',
    'utf8',
  );
  await writeFile(join(root, 'web', 'dist', 'assets', 'app.js'), 'built', 'utf8');

  await assert.rejects(() => assertRuntimeReady(root), /DEPENDENCY_INSTALL_NOT_CURRENT/);
  await recordDependencyInstall(root);
  await assert.rejects(() => assertRuntimeReady(root), /FRONTEND_BUILD_NOT_CURRENT/);
  await recordFrontendBuild(root);
  assert.equal(await assertRuntimeReady(root), true);

  await writeFile(join(root, 'web', 'dist', 'assets', 'app.js'), 'corrupted', 'utf8');
  await assert.rejects(() => assertRuntimeReady(root), /FRONTEND_BUILD_NOT_CURRENT/);
  await writeFile(join(root, 'web', 'dist', 'assets', 'app.js'), 'built', 'utf8');
  await recordFrontendBuild(root);
  await writeFile(join(root, 'package.json'), '{"private":true}', 'utf8');
  await assert.rejects(() => assertRuntimeReady(root), /DEPENDENCY_INSTALL_NOT_CURRENT/);
});

test('预检命令异常输出只保留稳定错误码', () => {
  assert.equal(launcherFailureMessage(new Error('FRONTEND_BUILD_INVALID')),
    '[launcher] FRONTEND_BUILD_INVALID');
  assert.equal(launcherFailureMessage(Object.assign(new Error('private'), { code: 'EACCES' })),
    '[launcher] EACCES');
  assert.equal(launcherFailureMessage(new Error('failed at /Users/private/project')),
    '[launcher] UNKNOWN');
});
