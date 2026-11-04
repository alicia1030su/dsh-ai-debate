# GUI 端到端验收

真实浏览器里跑完整工作台流程。**不是** jsdom，**不是**直接调后端函数。

## 结构

| 文件 | 作用 |
|---|---|
| `preload-intercept.ts` | 通过 `NODE_OPTIONS=--import` 注入宿主进程，替换 `globalThis.fetch`，在**网络边界**模拟贴吧（读 + 发表 + 回读）。产品代码零改动，发行包里没有它。 |
| `fixture-bundle.ts` | 把 `test/support/fixture-discussion.ts` 渲染成一份 JSON 数据包。 |
| `e2e-workbench.ts` | 用 CDP 驱动真实 Edge：点击、输入、等待、截图、断言。 |

## 前置

1. 一个隔离的 `DSH_HOME`，装好候选 TGZ。
2. `cordis.patch.yml` 里设置 `storeDir`、`ownerHandle`、`aiAccountUserId`、`llmBaseUrl`、`llmModel`、`authProbeThreadId`。
   **不要用命令行 `--patch`**：那会把整份配置标记为「被覆盖」，设置页写入一律 409。
3. 本地模拟模型（OpenAI 兼容）监听 `llmBaseUrl`。
4. Edge 以 `--remote-debugging-port` 启动并打开带令牌的页面 URL。

## 运行

```bash
DSH_E2E_CDP_PORT=9222 \
DSH_E2E_APP_PORT=58000 \
DSH_E2E_OUT_DIR=tmp/gui \
DSH_E2E_INTERCEPT_LOG=tmp/intercept.json \
DSH_E2E_PUBLISH_LOG=tmp/publish.json \
node --experimental-transform-types test/gui/e2e-workbench.ts
```

退出码非零即失败；`result.json` 里逐阶段记录 `passed` / `failed` / `skipped`，
`skipped` 也算失败——「没跑到」不能算「通过了」。

## 三个踩过的坑，别再踩

1. **React 输入必须逐字符发键盘事件**。`Input.insertText` 只改 DOM 不改组件状态，按钮仍禁用，点击静默无效。
2. **主人要用登录名绑定**。纯数字 ID 会被拒绝：`user_id` 和 `tieba_uid` 是两套无关命名空间。
3. **登录探测需要一个可读的帖子**。`authProbeThreadId` 就是给它用的；留空时适配器没有页面可读，登录态永远「未知」。
