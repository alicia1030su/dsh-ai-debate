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
# ## 复用同一套隔离 DSH_HOME（可用 `DSH_E2E_HOME` 覆盖）
#
# 宿主模型目录要求**这台隔离实例已登录**。凭据落在 `DSH_HOME/.credentials.yaml`，
# 不在 userdata 里 —— 全新 DSH_HOME 的 `listModels` 返回空，插件如实报
# 「宿主有提供方，但没有可用模型」，那一轮什么都验不出来。
#
# 这里默认复用**本自动化自己**在真实模型那一轮建出来的隔离 home
# （`tmp/desk-real-model`），并套一个独立的 profile 与 store。这不是从生产环境或
# 别人的 profile 取凭据：它是同一个测试夹具的第二次使用，里面没有 API Key。
ISO="${DSH_E2E_HOME:-$ROOT/tmp/desk-real-model}"
OUT="$ROOT/tmp/desk-cloud/run-$PORT"
# **必须是 $ISO 下的 profile**：DSH 只从 `$DSH_HOME/profiles/<name>` 加载，
# 指到别处时它仍然读旧的那一份 —— v0.2.37 又一次栽在这：判据读的是云目录，
# 而实际跑的是 real-model 目录（egressMode=open），两份记录还都「看起来正常」。
PROFILE="$ISO/profiles/desktop"
STORE="$ROOT/tmp/desk-cloud/plugin-store"
mkdir -p "$OUT" "$ROOT/tmp/desk-cloud/userdata-$PORT" "$ROOT/tmp/desk-cloud/plugin-store"

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
#
# ## 为什么允许复用某个既有的 userdata
#
# 宿主模型目录要求**已登录**。全新的 userdata 里没有会话，`listModels` 返回空，
# 插件如实报「宿主有提供方，但没有可用模型」—— 那一轮什么也验不出来。
#
# `DSH_E2E_USERDATA` 让调用方指向**本自动化自己**在早前轮次建出来的隔离 userdata
# （与生产 DSH 的 userData 无关）。这是复用同一套测试夹具，不是从别处取凭据：
# 里面没有任何 API Key，只有这台机器上那次测试会话。
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

rm -f "$OUT/observer.json" "$STORE/state.json" "$STORE/state.json.tmp" "$STORE/egress.jsonl"
# 记录本轮开始时刻：判定脚本据此拒绝**上一轮遗留**的审计。
date -u +%Y-%m-%dT%H:%M:%S.000Z > "$OUT/started-at.txt"

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

# ## 宿主进程的 Node 侧**不**走代理（实测结论，不是偷懒）
#
# 打开 `NODE_USE_ENV_PROXY` 后，宿主自己的模型目录查询会失败，插件拿到的
# `listModels` 是空列表 —— 报错是「宿主有提供方，但没有可用模型」。
# 也就是说：把宿主的 Node 出网塞进一个只做观测的代理，会**改变宿主的行为**，
# 而那一轮的失败看起来像「宿主没登录」。
#
# 所以这一轮的观测范围如实收窄，并由判定脚本在报告里写清：
#
#   - Chromium（Renderer）出网：经代理，逐条记录（强证据）
#   - 宿主进程 Node 出网：**未观测**（这一条必须写在报告里，不能算成「已覆盖」）
#   - 插件自己的四条出口：由插件审计 egress.jsonl 覆盖（模型/贴吧/CLI/授权探针）
#
# §6.2 明确要求：覆盖不到的部分不得声称「全进程零出网」。这里就是这么做的。

"/c/Users/TYMO001/AppData/Local/Programs/DeepSeek Harness/DeepSeek Harness.exe" \
  --remote-debugging-port="$PORT" \
  --proxy-server="http://127.0.0.1:$OBS_PORT" \
  --user-data-dir="${DSH_E2E_USERDATA:-C:/AI-Workspace/dsh-ai-debate/tmp/desk-cloud/userdata-$PORT}" \
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

DSH_E2E_STORE_DIR="C:/AI-Workspace/dsh-ai-debate/tmp/desk-cloud/plugin-store" \
DSH_E2E_RUN_STARTED_AT="$(cat "$OUT/started-at.txt")" \
  node --experimental-transform-types test/gui/verify-cloud-boundary.ts
NET_CODE=$?

kill -TERM "$OBS_PID" 2>/dev/null
sleep 1
kill -KILL "$OBS_PID" 2>/dev/null

CODE=$GUI_CODE
[ "$NET_CODE" -ne 0 ] && CODE=$NET_CODE
echo "exit=$CODE (gui=$GUI_CODE net=$NET_CODE)"
exit $CODE
