#!/bin/bash
cd "$(dirname "$0")" || {
  echo "无法进入应用目录，请确认项目文件夹仍存在且当前账号有访问权限。"
  read -n 1
  exit 1
}
command -v node >/dev/null 2>&1 || { echo "请先安装 Node.js（https://nodejs.org）"; read -n 1; exit 1; }
node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 20 ? 0 : 1)" >/dev/null 2>&1 || {
  echo "Node.js 版本过低，请升级到 20 或更高版本（https://nodejs.org）。"
  read -n 1
  exit 1
}
# 首次安装依赖前就启用企业根证书，避免 TLS 代理导致 npm 下载失败。
[ -f certs/corp-ca.pem ] && export NODE_EXTRA_CA_CERTS="$(pwd)/certs/corp-ca.pem"
export PORT=4399
export NOVELBOX_OPEN_BROWSER=1
# 在可能耗时的安装和构建前检查端口，避免最后才发现已有实例。
OLD_PID="$(lsof -nP -tiTCP:$PORT -sTCP:LISTEN 2>/dev/null)"
if [ -n "$OLD_PID" ]; then
  echo "端口 $PORT 已被占用，PID: $OLD_PID"
  echo "请先手动关闭占用进程，或在终端运行：PORT=5001 npm start"
  read -n 1 -s -r -p "按任意键退出…"
  exit 1
fi
if ! node server/launcher-preflight.js dependencies; then
  npm ci --ignore-scripts || {
    echo "依赖恢复失败，请确认 package-lock.json 未被修改，并检查网络或 npm 配置后重试。"
    read -n 1 -s -r -p "按任意键退出…"
    exit 1
  }
  node server/launcher-preflight.js record-dependencies || {
    echo "依赖内容校验失败，未执行第三方运行时代码。"
    read -n 1 -s -r -p "按任意键退出…"
    exit 1
  }
  node server/launcher-preflight.js dependencies || {
    echo "依赖恢复后仍不完整，请检查上方错误信息。"
    read -n 1 -s -r -p "按任意键退出…"
    exit 1
  }
fi
if ! node server/launcher-preflight.js frontend; then
  npm run build || {
    echo "前端构建失败，请查看上方错误信息。"
    read -n 1 -s -r -p "按任意键退出…"
    exit 1
  }
  node server/launcher-preflight.js record-frontend || {
    echo "前端构建产物校验失败，请查看上方错误信息。"
    read -n 1 -s -r -p "按任意键退出…"
    exit 1
  }
fi
node server/index.js
STATUS=$?
if [ "$STATUS" -ne 0 ]; then
  echo "服务异常退出（状态码 $STATUS），请查看上方错误信息。"
  read -n 1 -s -r -p "按任意键退出…"
fi
exit "$STATUS"
