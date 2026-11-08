#!/usr/bin/env bash
# 真 DSH Desktop 上的**手动导入 + 真实宿主云模型**网络边界验收（v0.2.37 §6）。
#
# ## 与 v0.2.36「完全离线」那一轮的区别
#
# v0.2.36 验的是另一个安全目标：模型是本机假服务、egress 模式 offline、除回环外全拒。
# 这一轮验的是**手动导入 + 云端真实模型**：egress 模式 manual，允许模型流量，
# 禁止一切平台流量。两条是不同的问题，报告必须分开写：
#
#   - 离线模式：证明「一个字节都没出去」
#   - 手动模式：证明「出去的只有模型」，平台读写都是 0
#
# ## 四类流量分开记
#
# 1. 插件允许的模型流量（宿主发起的云端模型请求）
# 2. 插件禁止的平台流量（weibo / baidu / tieba）—— 必须为 0
# 3. 宿主自身流量（更新检查、Chromium 组件下载）
# 4. 无法归因的流量 —— 必须为 0
#
# 前两类由插件审计（egress.jsonl）判定，后两类由进程外代理（observer.json）判定。
#
# 用法：bash test/gui/run-desktop-cloud-model.sh [cdpPort]
set -uo pipefail

WT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ROOT="/c/AI-Workspace/dsh-ai-debate"
PORT="${1:-9890}"
OBS_PORT=$((PORT + 20))
ISO="$ROOT/tmp/desk-cloud"
OUT="$ISO/run-$PORT"
PROFILE="$ISO/profiles/desktop"
mkdir -p "$OUT" "$ISO/userdata-$PORT" "$ISO/plugin-store"

unset ELECTRON_RUN_AS_NODE
export DSH_HOME="$ISO"
export DSH_E2E_CDP_PORT="$PORT"
export DSH_E2E_OUT_DIR="$OUT"
export DSH_E2E_REAL_MODEL=1
export DSH_E2E_CLOUD_MODEL=1
export DSH_E2E_EGRESS_MODE=manual
export DSH_E2E_OBSERVER_REPORT="C:/AI-Workspace/dsh-ai-debate/tmp/desk-cloud/run-$PORT/observer.json"

if [ ! -f "$PROFILE/package.json" ]; then
  mkdir -p "$PROFILE"
  cp "$ROOT/tmp/desk-offline/profiles/desktop/package.json" "$PROFILE/package.json"
  cp "$ROOT/tmp/desk-offline/profiles/desktop/cordis.patch.yml" "$PROFILE/cordis.patch.yml"
  ( cd "$PROFILE" && node "/c/Users/TYMO001/AppData/Local/Programs/DeepSeek Harness/resources/runtime/primary-runtime/dependencies/pnpm/bin/pnpm.cjs" install > "$OUT/profile-install.log" 2>&1 )
fi

# 模型来源交给宿主；egress 用 manual（允许模型主机 + 回环，禁平台）。
node "$WT/scripts/prepare-desktop-profile.mjs" \
  "$PROFILE" \
  "C:/AI-Workspace/dsh-ai-debate/tmp/desk-cloud/plugin-store" \
  manual || exit 2
node "$WT/scripts/set-profile-keys.mjs" "$PROFILE" \
  'llmSource=host' 'llmBaseUrl=' 'llmModel=' 'llmMaxOutputTokens=600' || exit 2
grep -E "llmSource|egressMode|storeDir" "$PROFILE/cordis.patch.yml" | head -4

cleanup() {
  for P in "$PORT" "$OBS_PORT"; do
    PID=$(netstat -ano 2>/dev/null | grep ":$P " | grep LISTENING | awk '{print $5}' | head -1)
    [ -n "${PID:-}" ] && node -e "try{process.kill($PID,'SIGKILL')}catch{}" 2>/dev/null
  done
  [ -n "${DESK_PID:-}" ] && node -e "try{process.kill($DESK_PID,'SIGKILL')}catch{}" 2>/dev/null
}
trap cleanup EXIT

rm -f "$OUT/observer.json" "$ISO/plugin-store/state.json" "$ISO/plugin-store/state.json.tmp" "$ISO/plugin-store/egress.jsonl"

# 观测器：允许宿主模型域名与宿主基础设施，其余一律拒绝并记录。
node --experimental-transform-types "$WT/scripts/net-observer.mjs" \
  --port "$OBS_PORT" \
  --out "C:/AI-Workspace/dsh-ai-debate/tmp/desk-cloud/run-$PORT/observer.json" \
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
grep -E "OBSERVER-PORT|OBSERVER-SELFCHECK" "$OUT/observer.log" | head -2
if grep -q "OBSERVER-SELFCHECK=broken" "$OUT/observer.log" 2>/dev/null; then
  echo "FATAL：观测器自检失败，本轮任何边界结论都不成立"
  exit 2
fi

export NODE_USE_ENV_PROXY=1
export HTTP_PROXY="http://127.0.0.1:$OBS_PORT"
export HTTPS_PROXY="http://127.0.0.1:$OBS_PORT"
export ALL_PROXY="http://127.0.0.1:$OBS_PORT"
export NO_PROXY="127.0.0.1,localhost"

"/c/Users/TYMO001/AppData/Local/Programs/DeepSeek Harness/DeepSeek Harness.exe" \
  --remote-debugging-port="$PORT" \
  --proxy-server="http://127.0.0.1:$OBS_PORT" \
  --user-data-dir="C:/AI-Workspace/dsh-ai-debate/tmp/desk-cloud/userdata-$PORT" \
  > "$OUT/desktop.log" 2>&1 &
DESK_PID=$!

for i in $(seq 1 120); do
  sleep 1
  grep -q "DevTools listening" "$OUT/desktop.log" 2>/dev/null && break
done
grep -E "DevTools listening" "$OUT/desktop.log" | head -2

cd "$WT" || exit 1
node --experimental-transform-types test/gui/e2e-manual-import.ts
GUI_CODE=$?

node --experimental-transform-types test/gui/verify-cloud-boundary.ts
NET_CODE=$?

kill -TERM "$OBS_PID" 2>/dev/null
sleep 1
kill -KILL "$OBS_PID" 2>/dev/null

CODE=$GUI_CODE
[ "$NET_CODE" -ne 0 ] && CODE=$NET_CODE
echo "exit=$CODE (gui=$GUI_CODE net=$NET_CODE)"
exit $CODE
