@echo off
cd /d "%~dp0"
if errorlevel 1 (
  echo 无法进入应用目录，请确认项目文件夹仍存在且当前账号有访问权限。
  pause
  exit /b 1
)
where node >nul 2>nul || (echo 请先安装 Node.js https://nodejs.org & pause & exit /b 1)
node -e "process.exit(Number(process.versions.node.split('.')[0]) ^>= 20 ? 0 : 1)" >nul 2>nul
if errorlevel 1 (
  echo Node.js 版本过低，请升级到 20 或更高版本 https://nodejs.org
  pause
  exit /b 1
)
rem 首次安装依赖前就启用企业根证书，避免 TLS 代理导致 npm 下载失败
if exist certs\corp-ca.pem set "NODE_EXTRA_CA_CERTS=%~dp0certs\corp-ca.pem"
set "PORT=4399"
set "NOVELBOX_OPEN_BROWSER=1"
rem 在可能耗时的安装和构建前检查端口，避免最后才发现已有实例
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":%PORT% " ^| findstr LISTENING') do (
  echo 端口 %PORT% 已被占用，PID: %%p
  echo 请先手动关闭占用进程，或在终端运行：set PORT=5001 ^&^& npm start
  pause
  exit /b 1
)
node server\launcher-preflight.js dependencies
if errorlevel 1 (
  call npm ci --ignore-scripts
  if errorlevel 1 (
    echo 依赖恢复失败，请确认 package-lock.json 未被修改，并检查网络或 npm 配置后重试。
    pause
    exit /b 1
  )
  node server\launcher-preflight.js record-dependencies
  if errorlevel 1 (
    echo 依赖内容校验失败，未执行第三方运行时代码。
    pause
    exit /b 1
  )
  node server\launcher-preflight.js dependencies
  if errorlevel 1 (
    echo 依赖恢复后仍不完整，请检查上方错误信息。
    pause
    exit /b 1
  )
)
node server\launcher-preflight.js frontend
if errorlevel 1 (
  call npm run build
  if errorlevel 1 (
    echo 前端构建失败，请查看上方错误信息。
    pause
    exit /b 1
  )
  node server\launcher-preflight.js record-frontend
  if errorlevel 1 (
    echo 前端构建产物校验失败，请查看上方错误信息。
    pause
    exit /b 1
  )
)
node server\index.js
if errorlevel 1 (
  echo 服务异常退出，请查看上方错误信息。
  pause
  exit /b 1
)
