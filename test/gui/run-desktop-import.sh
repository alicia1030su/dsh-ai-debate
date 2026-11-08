#!/usr/bin/env bash
# 真 DSH Desktop 上的离线导入全链路验收（v0.2.35 §8「手动导入」一路）。
#
# ## 与 `run-desktop-weibo.sh` 的分工
#
# 那个跑微博（假 CLI + 真工作台），这个跑**离线导入**：粘贴一段讨论 → 选主人
# → 选目标 → 生成 → 编辑 → 重新评估 → 批准 → 复制 → 刷新恢复 → 重启恢复。
#
# 两条路共用同一个隔离宿主与同一套 CDP 手法，差别只在被测路径与「有没有平台」。
# 离线导入这条路的价值在于：它是**唯一一条完全不碰平台的路径**，所以它可以证明
# 「产品自己的链路是通的」——当微博读取因为令牌失效而红时，这条仍然是绿的就说明
# 问题在授权，不在产品。
#
# ## 为什么需要拦截器
#
# 「零联网」这句话必须能验证。拦截器挂在宿主 fetch 上，任何一次出网都会被记下来，
# 报告里那条断言读的是拦截日志，不是页面的自述。
#
# ## 三首启动要点（与微博脚本同源，每条都踩过）
#
# 1. `ELECTRON_RUN_AS_NODE` 必须清掉，否则 Electron 退化成 Node，调试端口被拒；
# 2. 必须另给 `--user-data-dir`，否则单实例锁让第二个实例直接 quit；
# 3. `DSH_HOME` 必须是真路径，空字符串会退回 `~/.dsh`（主人的真实数据）。
#
# 用法：bash test/gui/run-desktop-import.sh [cdpPort]
set -uo pipefail

WT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ROOT="/c/AI-Workspace/dsh-ai-debate"
PORT="${1:-9510}"

ISO="$ROOT/tmp/desk-import"
OUT="$ISO/run-$PORT"
mkdir -p "$OUT" "$ISO/userdata-$PORT" "$ISO/plugin-store"

unset ELECTRON_RUN_AS_NODE

export DSH_HOME="$ISO"
export DSH_E2E_CDP_PORT="$PORT"
export DSH_E2E_OUT_DIR="$OUT"
export DSH_E2E_INTERCEPT_LOG="$OUT/intercept.json"

# 拦截器：证明这一轮一次都没有出网。
#
# 路径必须是 Windows 的 `file:///C:/...` 形状。第一版直接用 bash 的 `$WT`
# （形如 `/c/AI-Workspace/...`），拼出来是 `file:////c/...`，Node 报
# `ERR_INVALID_FILE_URL_PATH` —— 一个与产品无关、却让整轮验收 6 秒结束的错误。
WIN_WT="$(cygpath -w "$WT" 2>/dev/null | tr '\\' '/')"
export NODE_OPTIONS="--experimental-transform-types --import file:///${WIN_WT}/test/gui/preload-intercept.ts"
rm -f "$DSH_E2E_INTERCEPT_LOG"

# 彻底清空插件 store：这一轮从「一条会话都没有」开始。
rm -f "$ISO/plugin-store/state.json" "$ISO/plugin-store/state.json.tmp"

cleanup() {
  PID=$(netstat -ano 2>/dev/null | grep ":$PORT " | grep LISTENING | awk '{print $5}' | head -1)
  [ -n "${PID:-}" ] && node -e "try{process.kill($PID,'SIGKILL')}catch{}" 2>/dev/null
  [ -n "${MOCK_PID:-}" ] && node -e "try{process.kill($MOCK_PID,'SIGKILL')}catch{}" 2>/dev/null
  [ -n "${DESK_PID:-}" ] && node -e "try{process.kill($DESK_PID,'SIGKILL')}catch{}" 2>/dev/null
}
trap cleanup EXIT

# 假模型：生成候选需要有人答话（真实凭据不该出现在隔离环境）。
node "$ROOT/tmp/llm-mock-028.mjs" > "$OUT/llm-mock.log" 2>&1 &
MOCK_PID=$!

"/c/Users/TYMO001/AppData/Local/Programs/DeepSeek Harness/DeepSeek Harness.exe" \
  --remote-debugging-port="$PORT" \
  --user-data-dir="C:/AI-Workspace/dsh-ai-debate/tmp/desk-import/userdata-$PORT" \
  > "$OUT/desktop.log" 2>&1 &
DESK_PID=$!

for i in $(seq 1 120); do
  sleep 1
  grep -q "DevTools listening" "$OUT/desktop.log" 2>/dev/null && break
done
grep -E "DevTools listening|dsh web:" "$OUT/desktop.log" | head -3

cd "$WT" || exit 1
node --experimental-transform-types test/gui/e2e-manual-import.ts
CODE=$?

echo "exit=$CODE"
exit $CODE
