#!/usr/bin/env bash
# 真 DSH Desktop 上的微博全链路验收（v0.2.33 §四）。
#
# ## 这个脚本与 `run-desktop-full.sh` 的区别
#
# 那个跑的是**离线手动导入**（贴吧语料）。这个跑的是**微博**：平台页 → 工作台
# → 输入微博链接 → 读取讨论 → 选目标 → 生成 → 编辑 → 复制 → 刷新恢复。
#
# 两者共用同一个隔离宿主与同一套 CDP 手法，差别只在被测路径与假 CLI 的场景文件。
#
# ## 为什么微博读取必须用假 CLI
#
# 隔离环境里没有、也不该有真实的 OAuth 令牌。真实 API 调用属于「主人自己的账号」，
# 不能为了跑测试而消耗额度，更不该把令牌复制进测试环境。
#
# 所以读取走 `test/fixtures/fake-weibo-pkg` 里那个**按 npm 包布局摆放的假 CLI**：
# `cli.ts` 在 Windows 上通过 `node_modules/@weibo-ai/weibo-cli/dist/index.js` 解析入口，
# 把那个目录放进 PATH 就能被真实解析逻辑找到。产品代码零改动，也不知道自己在被测试。
#
# **这份证据证明的是「桌面链路通」，不是「微博 API 今天这样返回」。**
#
# ## 三首启动要点（每条都踩过）
#
# 1. `ELECTRON_RUN_AS_NODE` 必须清掉，否则 Electron 退化成 Node，调试端口被拒；
# 2. 必须另给 `--user-data-dir`，否则单实例锁让第二个实例直接 quit；
# 3. `DSH_HOME` 必须是真路径，空字符串会退回 `~/.dsh`（主人的真实数据）。
#
# 用法：bash test/gui/run-desktop-weibo.sh [cdpPort]
set -uo pipefail

WT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ROOT="/c/AI-Workspace/dsh-ai-debate"
PORT="${1:-9400}"
APP_MARKER=""

ISO="$ROOT/tmp/desk-weibo"
OUT="$ISO/run-$PORT"
mkdir -p "$OUT" "$ISO/userdata-$PORT" "$ISO/profile/node_modules"

unset ELECTRON_RUN_AS_NODE
unset NODE_OPTIONS

export DSH_HOME="$ISO"
export PATH="$WT/test/fixtures/fake-weibo-pkg:$PATH"
export FAKE_WEIBO_HOME="$ISO/weibo-home.json"
export FAKE_WEIBO_LOG="$OUT/weibo-calls.log"
export DSH_E2E_CDP_PORT="$PORT"
export DSH_E2E_OUT_DIR="$OUT"
export DSH_E2E_WORKTREE="$WT"

# 起始场景：健康账号。负向阶段会在运行中改写这个文件。
echo '{"doctor":"ok","cursor":"zero"}' > "$FAKE_WEIBO_HOME"
: > "$FAKE_WEIBO_LOG"

# 彻底清空插件 store：这一轮要从「一条会话都没有」开始。
rm -f "$ISO/plugin-store/state.json" "$ISO/plugin-store/state.json.tmp"

cleanup() {
  for p in "$PORT"; do
    PID=$(netstat -ano 2>/dev/null | grep ":$p " | grep LISTENING | awk '{print $5}' | head -1)
    [ -n "${PID:-}" ] && node -e "try{process.kill($PID,'SIGKILL')}catch{}" 2>/dev/null
  done
  [ -n "${MOCK_PID:-}" ] && node -e "try{process.kill($MOCK_PID,'SIGKILL')}catch{}" 2>/dev/null
  [ -n "${DESK_PID:-}" ] && node -e "try{process.kill($DESK_PID,'SIGKILL')}catch{}" 2>/dev/null
}
trap cleanup EXIT

# 假模型：生成候选需要一个会答话的 OpenAI 兼容服务。
node "$ROOT/tmp/llm-mock-028.mjs" > "$OUT/llm-mock.log" 2>&1 &
MOCK_PID=$!

"/c/Users/TYMO001/AppData/Local/Programs/DeepSeek Harness/DeepSeek Harness.exe" \
  --remote-debugging-port="$PORT" \
  --user-data-dir="C:/AI-Workspace/dsh-ai-debate/tmp/desk-weibo/userdata-$PORT" \
  > "$OUT/desktop.log" 2>&1 &
DESK_PID=$!

for i in $(seq 1 120); do
  sleep 1
  grep -q "DevTools listening" "$OUT/desktop.log" 2>/dev/null && break
done
grep -E "DevTools listening|dsh web:" "$OUT/desktop.log" | head -3

cd "$WT" || exit 1
node --experimental-transform-types test/gui/desktop-weibo.ts
CODE=$?

echo "exit=$CODE"
exit $CODE
