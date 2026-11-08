#!/usr/bin/env bash
# 真 DSH Desktop 上的**网络边界**验收（v0.2.36 §4）。
#
# ## 这一轮要证明什么，以及为什么 v0.2.35 没有证明
#
# v0.2.35 用 `NODE_OPTIONS --import preload-intercept.ts` 去拦宿主 fetch。那条路在
# Electron 下**根本没执行**：主进程会丢掉 NODE_OPTIONS。于是报告里「拦截日志文件
# 不存在」被记成一条 skipped，而「零联网」这句话没有任何观测支撑 —— 空日志与
# 没装观测器在证据上是同一件事。
#
# 这一版换成**进程外代理观测 + 插件内出网守卫**两层：
#
#   1. 本地代理（OBS_PORT）：Electron 用 `--proxy-server` 指向它，Node 侧用
#      `NODE_USE_ENV_PROXY` + `HTTP(S)_PROXY` 指向它；每条连接都落 observer.json。
#   2. 插件内 `EgressGuard`：模型 fetch、贴吧 HTTP、微博 CLI 启动三个出口都过它，
#      判定写进 `plugin-store/egress.jsonl`。
#
# 两层必须**同时干净**才算通过；任何一层缺失或自检失败，本轮判失败。
#
# ## 自检必须能抓到东西
#
# 代理起来后自己 CONNECT 一个保留域；记录里没有它 → `observerBroken=true` → 失败。
# 插件侧的守卫则由设置页的「自检出网守卫」按钮触发一次必然被拒的请求。
#
# ## 用法
#
#     bash test/gui/run-desktop-offline.sh [cdpPort]
set -uo pipefail

WT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ROOT="/c/AI-Workspace/dsh-ai-debate"
PORT="${1:-9610}"
OBS_PORT=$((PORT + 20))
ISO="$ROOT/tmp/desk-offline"
OUT="$ISO/run-$PORT"
PROFILE="$ISO/profiles/desktop"
mkdir -p "$OUT" "$ISO/userdata-$PORT" "$ISO/plugin-store"

unset ELECTRON_RUN_AS_NODE
export DSH_HOME="$ISO"
export DSH_E2E_CDP_PORT="$PORT"
export DSH_E2E_OUT_DIR="$OUT"
# GUI 脚本据此决定要不要做「界面上的出网自检」那一段。
export DSH_E2E_EGRESS_MODE="${DSH_E2E_EGRESS_MODE:-offline}"
# 观测器报告路径：GUI 脚本把它当作「这一轮的联网证据」，替代 v0.2.35 的拦截日志。
export DSH_E2E_OBSERVER_REPORT="C:/AI-Workspace/dsh-ai-debate/tmp/desk-offline/run-$PORT/observer.json"

# ---- 0. 隔离 profile（第一次运行时搭好，之后复用） --------------------------
if [ ! -f "$PROFILE/package.json" ]; then
  mkdir -p "$PROFILE"
  cp "$ROOT/tmp/desk-import/profiles/desktop/package.json" "$PROFILE/package.json"
  cp "$ROOT/tmp/desk-import/profiles/desktop/cordis.patch.yml" "$PROFILE/cordis.patch.yml"
  node "$WT/scripts/prepare-desktop-profile.mjs" \
    "$PROFILE" \
    "C:/AI-Workspace/dsh-ai-debate/tmp/desk-offline/plugin-store" \
    "${DSH_E2E_EGRESS_MODE:-offline}"
  ( cd "$PROFILE" && node "/c/Users/TYMO001/AppData/Local/Programs/DeepSeek Harness/resources/runtime/primary-runtime/dependencies/pnpm/bin/pnpm.cjs" install > "$OUT/profile-install.log" 2>&1 )
fi

# 每轮都校验一次配置：跨环境的 storeDir 串台过一次（v0.2.36），
# 那次三条红没有一条是产品问题。
node "$WT/scripts/prepare-desktop-profile.mjs" \
  "$PROFILE" \
  "C:/AI-Workspace/dsh-ai-debate/tmp/desk-offline/plugin-store" \
  "${DSH_E2E_EGRESS_MODE:-offline}" || exit 2

cleanup() {
  for P in "$PORT" "$OBS_PORT"; do
    PID=$(netstat -ano 2>/dev/null | grep ":$P " | grep LISTENING | awk '{print $5}' | head -1)
    [ -n "${PID:-}" ] && node -e "try{process.kill($PID,'SIGKILL')}catch{}" 2>/dev/null
  done
  [ -n "${MOCK_PID:-}" ] && node -e "try{process.kill($MOCK_PID,'SIGKILL')}catch{}" 2>/dev/null
  [ -n "${DESK_PID:-}" ] && node -e "try{process.kill($DESK_PID,'SIGKILL')}catch{}" 2>/dev/null
}
trap cleanup EXIT

rm -f "$OUT/observer.json" "$ISO/plugin-store/state.json" "$ISO/plugin-store/state.json.tmp" "$ISO/plugin-store/egress.jsonl"

# ---- 1. 假模型（回环，属于明确允许的那一类） --------------------------------
node "$ROOT/tmp/llm-mock-028.mjs" > "$OUT/llm-mock.log" 2>&1 &
MOCK_PID=$!

# ---- 2. 观测器 ---------------------------------------------------------------
node --experimental-transform-types "$WT/scripts/net-observer.mjs" \
  --port "$OBS_PORT" \
  --out "C:/AI-Workspace/dsh-ai-debate/tmp/desk-offline/run-$PORT/observer.json" \
  --allow 127.0.0.1 \
  --allow .deepseek.com \
  --allow .gvt1.com \
  --allow .googleapis.com \
  --allow .gstatic.com \
  > "$OUT/observer.log" 2>&1 &
OBS_PID=$!

for i in $(seq 1 40); do
  sleep 0.5
  grep -q "OBSERVER-SELFCHECK" "$OUT/observer.log" 2>/dev/null && break
done
grep -E "OBSERVER-PORT|OBSERVER-SELFCHECK" "$OUT/observer.log" | head -3
if grep -q "OBSERVER-SELFCHECK=broken" "$OUT/observer.log" 2>/dev/null; then
  echo "FATAL：观测器自检失败，本轮任何「零出网」结论都不成立"
  exit 2
fi

# ---- 3. Electron：代理指向观测器 --------------------------------------------
export NODE_USE_ENV_PROXY=1
export HTTP_PROXY="http://127.0.0.1:$OBS_PORT"
export HTTPS_PROXY="http://127.0.0.1:$OBS_PORT"
export ALL_PROXY="http://127.0.0.1:$OBS_PORT"
export NO_PROXY="127.0.0.1,localhost"

"/c/Users/TYMO001/AppData/Local/Programs/DeepSeek Harness/DeepSeek Harness.exe" \
  --remote-debugging-port="$PORT" \
  --proxy-server="http://127.0.0.1:$OBS_PORT" \
  --user-data-dir="C:/AI-Workspace/dsh-ai-debate/tmp/desk-offline/userdata-$PORT" \
  > "$OUT/desktop.log" 2>&1 &
DESK_PID=$!

for i in $(seq 1 120); do
  sleep 1
  grep -q "DevTools listening" "$OUT/desktop.log" 2>/dev/null && break
done
grep -E "DevTools listening" "$OUT/desktop.log" | head -2

# ---- 4. GUI 全链路（与离线导入同一套脚本，环境不同） ------------------------
cd "$WT" || exit 1
node --experimental-transform-types test/gui/e2e-manual-import.ts
GUI_CODE=$?

# ---- 5. 边界断言：读两层的记录 ----------------------------------------------
node --experimental-transform-types test/gui/verify-network-boundary.ts
NET_CODE=$?

kill -TERM "$OBS_PID" 2>/dev/null
sleep 1
kill -KILL "$OBS_PID" 2>/dev/null

CODE=$GUI_CODE
[ "$NET_CODE" -ne 0 ] && CODE=$NET_CODE
echo "exit=$CODE (gui=$GUI_CODE net=$NET_CODE)"
exit $CODE
