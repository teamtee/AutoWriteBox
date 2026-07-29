#!/bin/bash
cd "$(dirname "$0")"
command -v node >/dev/null 2>&1 || { echo "请先安装 Node.js（https://nodejs.org）"; read -n 1; exit 1; }
[ -d node_modules ] || npm install
[ -d web/dist ] || npm run build
# 若存在企业根证书，让 Node 信任它（解决企业网络 TLS 拦截导致的 fetch failed）
[ -f certs/corp-ca.pem ] && export NODE_EXTRA_CA_CERTS="$(pwd)/certs/corp-ca.pem"
export PORT=4399
( sleep 2 && open "http://localhost:$PORT" ) &
node server/index.js
