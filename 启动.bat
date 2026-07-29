@echo off
cd /d "%~dp0"
where node >nul 2>nul || (echo 请先安装 Node.js https://nodejs.org & pause & exit /b 1)
if not exist node_modules ( call npm install )
if not exist web\dist ( call npm run build )
if exist certs\corp-ca.pem set NODE_EXTRA_CA_CERTS=%~dp0certs\corp-ca.pem
set PORT=4399
start "" cmd /c "timeout /t 2 >nul & start "" http://localhost:4399"
node server\index.js
