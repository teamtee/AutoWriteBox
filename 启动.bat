@echo off
cd /d "%~dp0"
where node >nul 2>nul || (echo 请先安装 Node.js https://nodejs.org & pause & exit /b 1)
if not exist node_modules ( call npm install )
if not exist web\dist ( call npm run build )
start "" "http://localhost:4399"
node server\index.js
