# v0.2.0 验收存证

本目录是 v0.2.0 在**真实 DSH 桌面端**上的实际加载与界面验收记录。
所有图片与文本都从运行中的页面抓取，不是手绘或推测。

## 环境

| 项目 | 值 |
| --- | --- |
| DSH 桌面版 | 0.2.1-rc.2 |
| Node | 24.21.0 |
| 浏览器 | Edge 156.0.4314.42（CDP 驱动） |
| 安装方式 | `dsh plugin --profile web add ./dsh-ai-debate-0.2.0.tgz` |
| 插件版本 | 0.2.0 |
| 安装位置 | `.dsh-iso-home/profiles/web/node_modules/dsh-ai-debate` |
| Host | `dsh web --port 0`，隔离 home |

## 验收项

### 1. 插件在设置界面里真实加载

`01-plugins.png` —— 「已安装插件」区域里出现 `dsh-ai-debate`，开关为开启状态，
副标题由插件的包描述渲染。

`02-config.png` —— 点开行详情后，「配置 dsh-ai-debate」按钮存在，点击进入配置页。

### 2. 配置页六个区域全部渲染

`10-account.png`、`11-platforms.png`、`14-status-refreshed.png`

（原计划还有一张 `12-status.png`，实际截图时被 `14-status-refreshed.png` 取代，
文件名不同是因为刷新后重新截了一次；两者内容相同，保留了后一张。）

标签页顺序：贴吧账号 / AI 模型 / 人格 / 发表与安全 / **平台** / 诊断与状态。
第六个「平台」是 v0.2.0 新增。

### 3. 平台区：已接入 vs 计划中

`03-platforms.png`（平台区的完整视图，含滚动到底部的清单；
原始的分页滚动截图 `04-scroll-00..03.png` 未随文档保存）

- 百度贴吧：`已接入` + `当前使用`，12 项能力各有状态与原因。
- 微博 / 知乎 / 小红书 / 抖音：`计划中` + `研究阶段`，能力行全部是
  `需授权` 或 `不可用`，**没有任何一项显示为「已验证可用」**。

贴吧的 12 项能力实测渲染结果（与 `src/platforms/tieba/provider.ts` 一致）：

| 能力 | 界面状态 |
| --- | --- |
| 读取帖子 / 评论列表 / 评论分页 / 定位评论 / 身份验证 / 发表后核验 | ✅ 已验证可用 |
| 子评论 | ⚠️ 降级可用（限流时用内联副本） |
| 发表评论 / 回复评论 | ❓ 未验证（只验证过未登录拒绝） |
| 艾特通知 / 图片内容 / 用户资料 | ❌ 不可用 |

### 4. 诊断区读取真实数据

`14-status-refreshed.png` —— 插件版本 `0.2.0`、状态文件路径、会话 5 条、
发表台账 3 条、模型用量 9 次调用，全部来自 `/api/dsh-ai-debate/status`。

## 验收中发现并修掉的界面缺陷

1. **清单文字里的 `**` 原样渲染** —— manifest 是带 `**强调**` 的散文，
   页面把它当纯文本画了出来。修法：客户端加 `plainText()`，去掉 `**`/`__` 标记再渲染。
   （修复前后的对比截图 `40-scroll-01.png` / `04-scroll-01.png` 未随文档保存；
   回归由 `test/settings-page.test.ts` 覆盖。）
2. **前置条件和约束被画成红色错误** —— 复用了 `.dsd-errors`（错误列表样式），
   于是一份中性的「实现前需要」清单看起来像故障。修法：新增 `.dsd-notes` 中性样式。

两个缺陷都是**在真实界面上看到**才发现的：单元测试无法发现「红色的清单不好读」。

## 如何复现

```bash
# 1. 打包
node scripts/pack.mjs

# 2. 装进隔离 profile
set DSH_HOME=<repo>/.dsh-iso-home
dsh plugin --profile web add ./dsh-ai-debate-0.2.0.tgz

# 3. 起 host
dsh web --port 0 --no-open

# 4. 带 CDP 起浏览器，然后驱动
node scripts/cdp-acceptance.mjs 9455 <outDir> "<url>/?token=<token>" \
  "click:插件" "wait:2500" "shot:01-plugins"
```

驱动脚本全部在 `scripts/cdp-*.mjs`，只依赖 Node 内建模块。
