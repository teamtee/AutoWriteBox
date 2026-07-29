#!/bin/bash
cd "$(dirname "$0")"
command -v node >/dev/null 2>&1 || { echo "请先安装 Node.js（https://nodejs.org）"; read -n 1; exit 1; }
[ -d node_modules ] || npm install
[ -d web/dist ] || npm run build
PORT=4399
( sleep 2 && open "http://localhost:$PORT" ) &
node server/index.js
