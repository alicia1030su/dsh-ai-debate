#!/usr/bin/env bash
# 真 DSH Desktop 上的**真实模型**验收（v0.2.36 §3.3）。
#
# ## 用哪个模型
#
# 用**宿主自己已经配好的**模型（DSH 的 `llm` 服务：真机探测到
# `deepseek-account/deepseek-flash` 与 `deepseek-account/deepseek-v4-pro`）。
# 插件不读、不存、不转发任何密钥 —— 请求由宿主发出，插件只拿回文本与 token 数。
# 这是 §3.1 明确允许的复用方式，也是本机唯一合法的真实模型来源。
#
# ## 为什么复用「离线导入」这道门
#
# 它是唯一一条**完全不碰平台**的路径，所以这一轮里唯一的变量就是「模型是真的」。
# 另起一个只有模型配置的入口会让「进门」「模型」「生成」三件事混在一份报告里，
# 而 v0.2.36 已经因为入口写法漂移红过两次（都不是产品问题）。
#
# ## 这一轮证明什么
#
# 真实模型能：按 JSON 契约输出 → 被解析成候选 → 通过安全评估 → 可被编辑 →
# 可被人工确认 → 可复制。也就是**整条链路在真实模型下成立**。
#
# 用法：bash test/gui/run-desktop-real-model.sh [cdpPort]
set -uo pipefail

WT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ROOT="/c/AI-Workspace/dsh-ai-debate"
PORT="${1:-9810}"
ISO="$ROOT/tmp/desk-real-model"
OUT="$ISO/run-$PORT"
PROFILE="$ISO/profiles/desktop"
mkdir -p "$OUT" "$ISO/userdata-$PORT" "$ISO/plugin-store"

unset ELECTRON_RUN_AS_NODE
export DSH_HOME="$ISO"
export DSH_E2E_CDP_PORT="$PORT"
export DSH_E2E_OUT_DIR="$OUT"
# 这一轮**没有**假模型：GUI 脚本据此把「候选正文」的判据从「等于固定回复」
# 改成「满足契约且非空」。
export DSH_E2E_REAL_MODEL=1
# 这一轮额外跑「四种人格比较」：四次真实模型调用，是 v0.2.37 的核心验收。
export DSH_E2E_COMPARE="${DSH_E2E_COMPARE:-1}"

# ---- 隔离 profile（从已验证的离线环境复制，只改模型来源） ------------------
if [ ! -f "$PROFILE/package.json" ]; then
  mkdir -p "$PROFILE"
  cp "$ROOT/tmp/desk-offline/profiles/desktop/package.json" "$PROFILE/package.json"
  cp "$ROOT/tmp/desk-offline/profiles/desktop/cordis.patch.yml" "$PROFILE/cordis.patch.yml"
  ( cd "$PROFILE" && node "/c/Users/TYMO001/AppData/Local/Programs/DeepSeek Harness/resources/runtime/primary-runtime/dependencies/pnpm/bin/pnpm.cjs" install > "$OUT/profile-install.log" 2>&1 )
fi

# 模型来源交给宿主，并清空插件自己的接口；出网放开（宿主模型要能出去）。
node "$WT/scripts/prepare-desktop-profile.mjs" \
  "$PROFILE" \
  "C:/AI-Workspace/dsh-ai-debate/tmp/desk-real-model/plugin-store" \
  open || exit 2
node "$WT/scripts/set-profile-keys.mjs" "$PROFILE" \
  'llmSource=host' 'llmBaseUrl=' 'llmModel=' 'llmMaxOutputTokens=600' || exit 2
# 模型页签与工作台都在「插件分区」里，而那条门在本轮用的是离线导入（入口已验证）。
grep -c 'llmSource: host' "$PROFILE/cordis.patch.yml" | grep -q 1 || exit 2
grep -E "llmSource|llmBaseUrl|llmModel|egressMode|storeDir" "$PROFILE/cordis.patch.yml" | head -6

cleanup() {
  PID=$(netstat -ano 2>/dev/null | grep ":$PORT " | grep LISTENING | awk '{print $5}' | head -1)
  [ -n "${PID:-}" ] && node -e "try{process.kill($PID,'SIGKILL')}catch{}" 2>/dev/null
  [ -n "${DESK_PID:-}" ] && node -e "try{process.kill($DESK_PID,'SIGKILL')}catch{}" 2>/dev/null
}
trap cleanup EXIT

rm -f "$ISO/plugin-store/state.json" "$ISO/plugin-store/state.json.tmp" "$ISO/plugin-store/egress.jsonl"

"/c/Users/TYMO001/AppData/Local/Programs/DeepSeek Harness/DeepSeek Harness.exe" \
  --remote-debugging-port="$PORT" \
  --user-data-dir="C:/AI-Workspace/dsh-ai-debate/tmp/desk-real-model/userdata-$PORT" \
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

# ## 把候选快照落到本轮目录（v0.2.37）
#
# store 是**共享的**：下一次运行会清空 state.json，于是「上一轮四个人的真实输出」
# 就没了 —— 而那是要写进质量报告的证据。每轮结束时把候选抄一份到 run 目录，
# 证据才跟运行绑定，而不是跟「最后一次跑」绑定。
node -e "
const fs = require('node:fs');
const path = 'C:/AI-Workspace/dsh-ai-debate/tmp/desk-real-model/plugin-store/state.json';
const out = process.env.DSH_E2E_OUT_DIR;
if (!fs.existsSync(path)) { console.log('没有 state.json，跳过候选快照'); process.exit(0) }
const j = JSON.parse(fs.readFileSync(path, 'utf8'));
const rows = (j.sessions || []).flatMap((s) => (s.candidates || []).map((c) => ({
  persona: c.persona ?? null,
  targetPostId: c.targetPostId,
  text: c.text,
  elapsedMs: c.elapsedMs ?? null,
  inputTokens: c.inputTokens ?? null,
  outputTokens: c.outputTokens ?? null,
  security: c.security ? { decision: c.security.decision, reasons: c.security.reasons } : null,
  approved: c.approved,
})));
fs.writeFileSync(out + '/candidates.json', JSON.stringify({ sessionId: j.sessions?.[0]?.id ?? null, rows }, null, 2) + '\n');
console.log('候选快照：' + rows.length + ' 条 -> ' + out + '/candidates.json');
"

CODE=$GUI_CODE
echo "exit=$CODE"
exit $CODE
