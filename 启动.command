#!/bin/bash
cd "$(dirname "$0")"
command -v node >/dev/null 2>&1 || { echo "请先安装 Node.js（https://nodejs.org）"; read -n 1; exit 1; }
[ -d node_modules ] || npm install
[ -d web/dist ] || npm run build
# 若存在企业根证书，让 Node 信任它（解决企业网络 TLS 拦截导致的 fetch failed）
[ -f certs/corp-ca.pem ] && export NODE_EXTRA_CA_CERTS="$(pwd)/certs/corp-ca.pem"
export PORT=4399
# 端口占用时不自动杀进程，避免误杀用户正在运行的其它服务
OLD_PID="$(lsof -nP -tiTCP:$PORT -sTCP:LISTEN 2>/dev/null)"
if [ -n "$OLD_PID" ]; then
  echo "端口 $PORT 已被占用，PID: $OLD_PID"
  echo "请先手动关闭占用进程，或在终端运行：PORT=5001 npm start"
  read -n 1 -s -r -p "按任意键退出…"
  exit 1
fi
( sleep 2 && open "http://localhost:$PORT" ) &
node server/index.js
