import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const root = process.cwd();

test('macOS 启动脚本默认不强杀占用 4399 的进程', async () => {
  const script = await readFile(join(root, '启动.command'), 'utf8');

  assert.doesNotMatch(script, /\bkill\s+-9\b/);
  assert.match(script, /-sTCP:LISTEN/);
  assert.match(script, /PORT=5001/);
  assert.match(script, /\bexit\s+1\b/);
  assert.match(script, /process\.versions\.node/);
  assert.match(script, />=\s*20/);
  assert.match(script, /cd "\$\(dirname "\$0"\)"\s*\|\|\s*\{/);
});

test('Windows 启动脚本默认不强杀占用 4399 的进程', async () => {
  const script = await readFile(join(root, '启动.bat'), 'utf8');

  assert.doesNotMatch(script, /\btaskkill\b/i);
  assert.match(script, /LISTENING/i);
  assert.match(script, /PORT=5001/i);
  assert.match(script, /exit\s+\/b\s+1/i);
  assert.match(script, /process\.versions\.node/i);
  assert.match(script, /\^>=\s*20/);
  assert.match(script, /cd \/d "%~dp0"[\s\S]*?if errorlevel 1/i);
});

test('Windows 启动脚本使用安全的变量赋值，特殊字符路径不会变成命令', async () => {
  const script = await readFile(join(root, '启动.bat'), 'utf8');

  assert.match(script, /set "NODE_EXTRA_CA_CERTS=%~dp0certs\\corp-ca\.pem"/i);
  assert.match(script, /set "PORT=4399"/i);
  assert.match(script, /set "NOVELBOX_OPEN_BROWSER=1"/i);
});

test('Windows 启动脚本的端口检查跟随 PORT 变量', async () => {
  const script = await readFile(join(root, '启动.bat'), 'utf8');

  assert.match(script, /findstr\s+"?:%PORT%\s/i);
  assert.match(script, /端口 %PORT% 已被占用/i);
});

test('启动脚本完成依赖与前端预检，并由服务就绪回调打开浏览器', async () => {
  const mac = await readFile(join(root, '启动.command'), 'utf8');
  const windows = await readFile(join(root, '启动.bat'), 'utf8');

  for (const script of [mac, windows]) {
    assert.match(script, /launcher-preflight\.js dependencies/i);
    assert.match(script, /launcher-preflight\.js record-dependencies/i);
    assert.match(script, /launcher-preflight\.js frontend/i);
    assert.match(script, /launcher-preflight\.js record-frontend/i);
    assert.match(script, /NOVELBOX_OPEN_BROWSER=1/i);
    assert.doesNotMatch(script, /launcher-preflight\.js wait-open/i);
  }
  assert.doesNotMatch(mac, /sleep\s+2/);
  assert.doesNotMatch(windows, /timeout\s+\/t\s+2/i);
});

test('启动脚本在安装前启用企业证书，并在耗时预检前检查端口', async () => {
  const mac = await readFile(join(root, '启动.command'), 'utf8');
  const windows = await readFile(join(root, '启动.bat'), 'utf8');

  assert.ok(mac.indexOf('NODE_EXTRA_CA_CERTS') < mac.indexOf('npm ci --ignore-scripts'));
  assert.ok(mac.indexOf('lsof -nP') < mac.indexOf('launcher-preflight.js dependencies'));
  assert.ok(windows.indexOf('NODE_EXTRA_CA_CERTS') < windows.indexOf('call npm ci --ignore-scripts'));
  assert.ok(windows.indexOf('netstat -ano') < windows.indexOf('launcher-preflight.js dependencies'));
});

test('macOS 启动脚本在安装、构建或服务失败时停止并保留错误提示', async () => {
  const script = await readFile(join(root, '启动.command'), 'utf8');

  assert.match(script, /npm ci --ignore-scripts\s*\|\|\s*\{/);
  assert.match(script, /npm run build\s*\|\|\s*\{/);
  assert.match(script, /STATUS=\$\?/);
  assert.match(script, /exit "\$STATUS"/);
});

test('Windows 启动脚本在安装、构建或服务失败时停止并保留错误提示', async () => {
  const script = await readFile(join(root, '启动.bat'), 'utf8');

  assert.match(script, /call npm ci --ignore-scripts[\s\S]*?if errorlevel 1/i);
  assert.match(script, /call npm run build[\s\S]*?if errorlevel 1/i);
  assert.match(script, /node server\\index\.js[\s\S]*?if errorlevel 1/i);
  assert.match(script, /pause[\s\S]*?exit \/b 1/i);
});

test('依赖恢复锁定安装且前端原生脚本只定向执行批准版本', async () => {
  const manifest = JSON.parse(await readFile(join(root, 'web', 'package.json'), 'utf8'));
  const lock = JSON.parse(await readFile(join(root, 'web', 'package-lock.json'), 'utf8'));
  const rootManifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const rootLock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));

  assert.deepEqual(manifest.allowScripts, {
    'esbuild@0.25.12': true,
    'fsevents@2.3.3': true,
  });
  const lockedInstallScripts = Object.entries(lock.packages)
    .filter(([, metadata]) => metadata?.hasInstallScript)
    .map(([path, metadata]) => `${path.slice('node_modules/'.length)}@${metadata.version}`)
    .sort();
  assert.deepEqual(lockedInstallScripts, Object.keys(manifest.allowScripts).sort());
  for (const spec of Object.keys(manifest.allowScripts)) {
    const separator = spec.lastIndexOf('@');
    const name = spec.slice(0, separator);
    const version = spec.slice(separator + 1);
    const locked = lock.packages[`node_modules/${name}`];
    assert.equal(locked?.version, version);
    assert.equal(locked?.hasInstallScript, true);
  }
  assert.equal(rootManifest.private, true);
  assert.deepEqual(rootManifest.engines, { node: '>=20' });
  assert.match(
    rootManifest.scripts.start,
    /launcher-preflight\.js runtime[\s\S]*node server\/index\.js/,
  );
  assert.ok(
    rootManifest.scripts.start.indexOf('launcher-preflight.js runtime')
      < rootManifest.scripts.start.indexOf('node server/index.js'),
  );
  assert.match(rootManifest.scripts.build, /launcher-preflight\.js record-frontend/);
  assert.match(rootManifest.scripts.build, /npm --prefix web ci --ignore-scripts/);
  assert.match(
    rootManifest.scripts.build,
    /launcher-preflight\.js frontend-dependencies[\s\S]*npm --prefix web rebuild esbuild@0\.25\.12 fsevents@2\.3\.3 --ignore-scripts=false --foreground-scripts[\s\S]*launcher-preflight\.js frontend-dependencies/,
  );
  assert.equal(
    (await readFile(join(root, 'web', '.npmrc'), 'utf8')).trim(),
    'ignore-scripts=true',
  );
  assert.deepEqual(manifest.engines, { node: '>=20' });
  assert.deepEqual(rootLock.packages[''].engines, rootManifest.engines);
  assert.deepEqual(lock.packages[''].engines, manifest.engines);
  assert.deepEqual(
    Object.entries(rootLock.packages).filter(([, metadata]) => metadata?.hasInstallScript),
    [],
  );
  for (const script of [
    await readFile(join(root, '启动.command'), 'utf8'),
    await readFile(join(root, '启动.bat'), 'utf8'),
  ]) {
    assert.match(script, /npm ci --ignore-scripts/i);
    assert.doesNotMatch(script, /\bnpm install\b/i);
    assert.ok(
      script.search(/npm ci --ignore-scripts/i)
        < script.search(/launcher-preflight\.js record-dependencies/i),
    );
    assert.match(
      script,
      /npm ci --ignore-scripts[\s\S]*launcher-preflight\.js record-dependencies[\s\S]*launcher-preflight\.js dependencies/i,
    );
  }
});

test('本地作品、API 配置和导出备份不会进入 Git 或 npm 发布包', async () => {
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const gitignore = await readFile(join(root, '.gitignore'), 'utf8');
  const npmignore = await readFile(join(root, '.npmignore'), 'utf8');

  assert.equal(manifest.private, true);
  for (const pattern of ['data/', '.env', '.env.*', '*.novelbox.json']) {
    assert.match(gitignore, new RegExp(`^${pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
    assert.match(npmignore, new RegExp(`^${pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
  }
  for (const pattern of ['node_modules/', 'web/dist/', '.superpowers/', '.worktrees/', 'certs/']) {
    assert.match(npmignore, new RegExp(`^${pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
  }
});

test('README 将在线单书导出与离线整目录备份明确区分', async () => {
  const readme = await readFile(join(root, 'README.md'), 'utf8');

  assert.match(
    readme,
    /npm ci --ignore-scripts[\s\S]*launcher-preflight\.js record-dependencies[\s\S]*npm start/,
  );
  assert.doesNotMatch(readme, /\bnpm install\b/);
  assert.match(readme, /服务运行时请优先[\s\S]{0,120}「备份」[\s\S]{0,80}\.novelbox\.json/);
  assert.match(readme, /「TXT 正文」[\s\S]{0,180}不会夹带大纲、摘要、审稿、长期记忆/);
  assert.match(readme, /复制整个 `data\/` 前[\s\S]{0,120}`Ctrl\+C` 正常关闭服务/);
  assert.match(readme, /不要在服务运行时逐文件复制该目录/);
  assert.match(readme, /完整的 `data\/` 备份包含明文 API Key/);
  assert.match(readme, /从完整目录备份恢复时也要先关闭服务/);
  assert.match(readme, /不要从仍在运行的实例复制或手工删除 `\.instance-lock\.json`/);
});
