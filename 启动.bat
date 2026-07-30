@echo off
cd /d "%~dp0"
where node >nul 2>nul || (echo 请先安装 Node.js https://nodejs.org & pause & exit /b 1)
if not exist node_modules ( call npm install )
if not exist web\dist ( call npm run build )
if exist certs\corp-ca.pem set NODE_EXTRA_CA_CERTS=%~dp0certs\corp-ca.pem
set PORT=4399
rem 释放端口：结束占用 4399 的旧进程，避免旧版服务残留
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":4399 " ^| findstr LISTENING') do taskkill /f /pid %%p >nul 2>nul
start "" cmd /c "timeout /t 2 >nul & start "" http://localhost:4399"
node server\index.js
