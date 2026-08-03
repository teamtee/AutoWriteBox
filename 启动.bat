@echo off
cd /d "%~dp0"
where node >nul 2>nul || (echo 请先安装 Node.js https://nodejs.org & pause & exit /b 1)
if not exist node_modules ( call npm install )
if not exist web\dist ( call npm run build )
if exist certs\corp-ca.pem set NODE_EXTRA_CA_CERTS=%~dp0certs\corp-ca.pem
set PORT=4399
rem 端口占用时不自动结束进程，避免误杀用户正在运行的其它服务
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":4399 " ^| findstr LISTENING') do (
  echo 端口 4399 已被占用，PID: %%p
  echo 请先手动关闭占用进程，或在终端运行：set PORT=5001 ^&^& npm start
  pause
  exit /b 1
)
start "" cmd /c "timeout /t 2 >nul & start "" http://localhost:4399"
node server\index.js
