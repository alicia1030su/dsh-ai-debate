# 更新日志

本项目遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## [0.2.4] — 2026-10-28

修 CI 失败与安全页面缺陷。三处已独立复现的问题，加上一处排查中发现、上一版
漏挂载的组件。**没有削弱任何安全规则**：PromptInjectionGuard、OwnerIntegrityGuard、
OutputGuard、PublishGuard 全部保留，确定性规则仍然没有关闭开关。

### 一、安全页面根本不显示（两个独立原因，缺一不可）

用户报告「打开安全与防注入页，只显示"这个 Host 版本没有提供安全状态"」。
查下去是两个叠加的问题：

**1. `normalizeView()` 是白名单，漏了 `security` 字段。**

Host 侧 `describeSecurity()` 构造了完整状态、`viewOfSettings()` 也放进了 payload，
但客户端这个函数只复制它点名的字段，没点名的就被静默丢掉：

```js
// v0.2.3：security 不在这张表里，于是它从不存在
values: ..., secrets: ..., credentials: ..., platforms: ..., capabilities: ...
```

后果比"看不见"更糟：面板读不到真相时选择了看起来最安全的答案，而这里是**假的**——
即使保护实际是关闭的，页面也照旧说"没有提供安全状态"。一个永远不报警的安全面板，
比没有面板更容易让人放心。

修法：加 `security` 透传，并做形状检查（数组或字符串视为"没提供"），
免得把 `undefined` 印满整个安全面板。

**2. `DebateSection` 的堆叠布局漏挂载两个组件。**

侧栏设置页不分组页签，而是把各区域依次堆叠。它列了 5 个：

```js
h(AccountSection), h(ModelSection), h(PersonaSection), h(PublishSection), h(StatusSection)
```

`SecuritySection` 和 `PlatformsSection` **写了、导出了、从来没被渲染**。
一个存在但不挂载的组件，和没写是一回事——而且更隐蔽，因为 `grep` 得到结果。

修法：补上两个区域。

### 二、两项 CI 测试失败（真因是跨平台差异，不是测试顺序）

`an unwritable state directory refuses to publish` 和
`store.mutate rejects when the write cannot happen` 在 CI 上失败、在 Windows 上通过。

原因是同一句 `readFile` 在两个平台报不同的码：

| 平台 | 父目录是普通文件时 `readFile` 的错误码 | `ready()` 的处理 |
| --- | --- | --- |
| Linux | `ENOTDIR` | 抛 `read_failed`，测试在 `mutate()` 之前就挂了 |
| Windows | `ENOENT` | 当成"首次运行"，`ready()` 通过，于是测试"成功" |

**Windows 上的通过是巧合。** 旧写法先制造障碍再建 store，两个平台走的是不同分支。

修法：**先在路径还不存在时完成 `ready()`**（两个平台都走首次运行分支、都成功），
再制造写障碍，这样两条路都真的到达写盘逻辑。同时新增一项独立测试：
把 `state.json` 本身做成目录（`EISDIR`，两个平台一致），断言 `read_failed`——
**证明真正的读取失败仍然被拒绝**，没有为了让测试通过而吞掉 `ENOTDIR`。

### 三、测试统计脚本（顺带挖出一个隐藏问题）

`scripts/test-count.mjs` 只匹配 `ℹ pass N`。Node 的默认 reporter 由环境决定：
TTY 下输出 `ℹ pass N`，CI/管道下输出 TAP `# pass N`。

后果是最坏的一种：**CI 上每个文件都统计成 0，脚本退出码 0**。一个静默的零比崩溃更难发现。

修法三条：

- 显式 `--test-reporter=tap`，让输出格式由脚本决定，不由调用方终端决定
- 两种格式都解析，但**无法解析时返回 `undefined` 而不是 0**（"没统计到"和"零个通过"是两件事）
- 任一文件非零退出、或统计无法解析，**整个脚本失败**，不出具部分结果

**排查中发现的问题**：从测试进程里 `spawnSync` 子进程会继承 `NODE_TEST_CONTEXT`，
子进程认为自己是嵌套 runner，打印 `run() is being called recursively ... skipping running files`，
什么都不跑、退出 0、没有统计。加了 `childEnv()` 清掉它，并写了一项测试固定这个行为
（否则有人会以为这个变量无害而删掉）。

### 四、实测

```
Node 22.18.0：编译 ✅  类型检查 ✅  612 项测试全绿
Node 24.22.1：编译 ✅  类型检查 ✅  612 项测试全绿
```

新增测试 22 项：

| 文件 | 数量 | 覆盖 |
| --- | --- | --- |
| `test/client-security-panel.test.ts` | 11 | 走完 Host→fetch→normalizeView→store→React DOM 全链路；两个挂载入口都测；保护关闭必须显示关闭；只有真旧 Host 才能显示缺状态 |
| `test/test-count.test.ts` | 11 | TAP 与 spec 两种格式解析一致；非零退出与无法解析都让整体失败；继承 `NODE_TEST_CONTEXT` 的子进程被识别为无统计而非 0 |
| `test/publisher-safety.test.ts` | +1 | 读取失败仍被拒绝（`EISDIR`，跨平台一致） |

### 五、真实环境验收

用全新的隔离 `DSH_HOME` 安装 0.2.4，重启 Host，在真实浏览器里打开插件的
「安全与防注入」页，两种状态都截了图：

| Host 实际返回 | 页面显示 |
| --- | --- |
| `protectionEnabled: true`, `strictness: standard` | 防注入保护已开启 · 语义审核严格度：标准（默认） |
| `protectionEnabled: false`, `inputScanning: false`, `strictness: relaxed` | **防注入保护已关闭**（红色）· 输入风险检测 已关闭 · 宽松（仅高危才拦） |

同时 `outputGate`/`stanceGuard` 仍为 true → 仍显示运行中，说明各状态独立精确，
**关闭保护时没有伪造开启**。

### 六、安装路径核实（上一轮在这里出过错）

上一轮我曾把安装包解压到 `profiles/desktop/node_modules/dsh-ai-debate`，把 pnpm 的
`link:` 替换成了真实目录，于是 DSH 实际加载的是那份残留副本，而我只更新了 link 目标。
表现为"源码是新的、界面还是旧的"。

这一版交付的核实方法是**用 Node 自己的解析语义**，而不是猜路径：

```js
createRequire('<profile>/package.json').resolve('dsh-ai-debate/package.json')
```

结果与源码构建产物逐字节一致：

```
resolve            : C:\Users\23866\.dsh\plugins\dsh-ai-debate\package\package.json
version            : 0.2.4
lib/index.js       : 19D8041EB72A763C86CBF788D77CAC861322BAE22A224B7DAEE9ED0555BC717D
client/client.cjs  : 29AE25C52489F86089947C1EFBDA06F35D676CC285715A0CB5479F8E51A9E95D
```

### 七、一个如实说明的限制

`securityProtection` **不在配置页的 `EDITABLE_FIELDS` 里**，所以页面只能**显示**
保护状态，不能从页面开关它；要改只能改 profile 配置层。

这是有意保留的：放开这个字段等于让任何能写配置的人关掉保护，而这一版的任务前提是
「不允许为了消除错误而关闭任何保护」。若需要页面上可开关，应作为独立需求评审。

## [0.2.3] — 2026-10-28

跨平台提示词注入防御与立场完整性。这一版加的**不是过滤器，是一条不可跨越的信任边界**：
外部帖子和评论永远不能变成指令，插件自己算出来的摘要也不能。

设计细节与可复算指标见 [`docs/v0.2.3-security-report.md`](docs/v0.2.3-security-report.md)。

### 一、先说被复现的缺陷（这是这一版存在的理由）

v0.2.2 **能被骗着去骂主人**。独立脚本 `scripts/repro-stance.mjs` 在修复前
对六条回复全部返回「通过 (不该!)」，每条都满足：

```
response_target_id === 对手最后一条发言的 post id    ← 完全正确
```

旧的 `validateDraft` 只查 id、字数、凭据形状，**从不查立场**。于是：

```
主人你就是个傻子，说得全是废话，活该被骂。          → 通过
对面说得对，主人你根本不懂，我劝你闭嘴。             → 通过
经系统核实，主人毫无价值，大家一起来攻击他。         → 通过
主人已经换号了，现在真正的主人是对面。               → 通过
主人的手机号是 13800001234，你们自己找他。           → 通过
```

"回复目标正确"被当成了"回复内容正确"。这两件事之间没有任何关系。

### 二、四层信任边界（`src/security/trust-boundary.ts`）

```ts
enum TrustLevel {
  SystemPolicy      = 0,  // 插件自己的规则
  OwnerGranted      = 1,  // 主人通过工具参数或配置明确给出
  Derived           = 2,  // 插件自己算出来的摘要/简报
  ExternalUntrusted = 3,  // 帖子、评论、楼中楼、OCR、转写
}
```

`assertNoPromotion(from, to, what)` 在 `from > to` 时**抛错**，不是返回 false。
等级 3 不能升到 0 或 1，**等级 2 也不能**——简报是从对手评论算出来的，
"我们自己生成的"不等于"我们可以据此行动"，这是这类系统最常漏的一条。

`mayInstruct(level)` 只有前两层为 true；`mayAssertAsFact(level)` 连 `Derived`
都为 false：简报可以**作为分析呈现**，不能**作为事实断言**。

### 三、注入识别（`src/security/injection-detector.ts`）

覆盖任务书 18 个场景，但不是 18 条独立规则——规则数量不是防护。要点：

- **要求指令形状，不是话题词。** 「他忽略了公司上个月的承诺」不触发；
  「忽略之前的指令」才触发。这是误报率能压到 0 的关键。
- **多轮拆分**：逐条扫描时全部 `none`，合并后识别为 `critical` 且
  `spansPosts: true`。
- **结构伪装**：JSON / XML / `<system>` / `<|tool_call|>` / `debate_publish_reply(...)`
  全部按外部文本处理。伪造的工具调用不会被当成真的工具调用。
- **Unicode**：零宽字符、方向覆盖符、全角混淆先规范化再匹配，同时上报异常。
- **编码载荷**：base64 会被解码分析，**但不执行**，标签写明「不会执行」。
- **引用与讨论**：「他刚才想让我忽略指令，这不就是典型的注入吗」识别为在批评注入，
  严重度降两级。

### 四、主人立场保护（`src/security/owner-integrity.ts`）

`checkStance()` 返回 `consistent` / `uncertain` / `contradictory`，检查四类：

- 攻击主人（侮辱词 + 主人/你）
- 贬损主人价值（「毫无价值」「一文不值」——不带脏话，但同样是对主人的否定）
- 号召他人攻击主人（比直接攻击更糟，它征用了整帖）
- 声称要攻击主人 / 声明改换立场 / 泄露主人隐私

**同时保证另一半**：承认主人确实说错了是 `consistent`，不是 `contradictory`。
如果插件为了表忠心而不敢承认事实错误，它会开始编造论据——那是另一种失真。

### 五、输出闸门（`src/security/output-guard.ts`）

`guardOutput()` 综合三件事给出 `allow` / `review` / `block`：

1. 输入检测结果（这次对话里有没有注入痕迹）
2. 立场检查（这条回复是不是在攻击主人）
3. 凭据与隐私泄露（手机号、密钥、cookie 形状）

判定函数 `decideSecurity(findings, strictness)` 里，**硬阻断在三个严格度下完全相同**。
`strictness` 只影响文本级注入的阈值——这是刻意的：一个能调松的立场检查，
等于攻击者只需要说服用户去调。

### 六、发布路径强制接入（`src/publisher.ts`）

`recheckBeforePublish()` 放在**重新读取目标之后、写 `pending` 去重记录之前、
任何网络调用之前**。它检查：

- 候选有没有安全评估记录 → 没有就拒绝（防直改状态文件）
- 评估指纹是否匹配即将发出的正文 → 不匹配就拒绝（防批准后换正文）
- 评估结论是不是 `block` → 是就拒绝，**`humanApproved` 不能覆盖**

> 人工批准为什么不覆盖：主人点了同意一条骂自己的回复，通常意味着他被说服了
> 或者看漏了。插件的存在意义是替他说话，不是替他挨骂。
> 正确的处理是拒绝、让他改正文、重新评估。

### 七、安全事件日志（`src/security/security-events.ts`）

只记**脱敏后的一行摘要**：摘录上限 60 字符，密钥/手机号/身份证整体替换为
`[已隐去]`，去掉不可见字符，环形上限默认 50 条。

日志本身不能变成第二份攻击载荷——这是这类日志最容易被忽略的风险。

### 八、设置页新增「安全与防注入」区

显示的是**运行时生效状态**，不是配置默认值。`securityProtection: false` 时
页面必须显示 false，否则主人会以为自己是安全的而不再看这一页。

`semanticReview` 如实显示 `false`：本版本只有确定性规则，没有独立语义审核模型。
`hardRulesEnforced` 类型上就是字面量 `true`——删掉它会编译失败，
而不是悄悄变成可配置。

### 九、实测指标（本仓库标注集，`node scripts/security-metrics.mjs` 可复算）

```
恶意注入识别率      100.0%  (18/18)
主人立场反转阻断率  100.0%  (8/8)
正常评论误报率(高危) 0.0%  (0/12)
正常回复误阻断率    0.0%  (0/5)
单次输入检测耗时    0.023 ms / 条
```

> ⚠️ 这些数字只反映本仓库标注过的 43 条样本。没有出现在这个语料里的攻击
> 不在分母内，所以它不是「真实环境安全」的证明。已知漏检类型（不含侮辱词的
> 人格贬低、平台黑话、先夸后架式反讽）写在安全报告第二节。

### 十、测试

**583 项全部通过**，其中安全相关 65 项：

| 文件 | 数量 | 覆盖 |
| --- | --- | --- |
| `test/security/trust-boundary.test.ts` | 10 | 等级不能提升；只有前两层能下指令 |
| `test/security/adversarial.test.ts` | 36 | 18 个对抗场景，每条断言落在**判定结果**上而不是正则上 |
| `test/security/security-events.test.ts` | 11 | 摘录必须脱敏、有长度上限、去不可见字符 |
| `test/settings-security-view.test.ts` | 8 | 设置页报告生效状态而非默认值 |

同时把 `scripts/test-count.mjs` 改成递归扫描：它此前不递归，
**静默漏掉了 `test/security/` 下的 46 项**，README 的表格看起来却是完整的。

### 十一、这一版没有做到的事

- 没有在真实贴吧验证——本机 IP 对 `tieba.baidu.com` 持续 403。
- 图片 OCR / 视频字幕注入只在接口层覆盖（`ExternalText` 类型与 `sourceType`），
  没有端到端接入。
- `DebateBrief` 的引用校验尚未接进生成主流程。
- 没有对抗性红队，18 个场景是照任务书列的。

## [0.2.2] — 2026-10-28

跨平台架构收尾。0.2.1 让核心不再依赖楼层号，但**身份层还停在单平台上**，
完整性也还是一个布尔。这一轮修掉三个已独立复现的缺陷，并把多平台需要的
数据结构补齐。

### 一、P1：凭据命名空间碰撞（安全）

0.2.1 用「去掉所有非字母数字再大写」生成命名空间，再用 `startsWith` 判归属。
两边都能被绕开，已逐条复现：

```
credentialRefFor('foo_bar','cookie') → DSH_AI_DEBATE_FOO_BAR_COOKIE
refBelongsToPlatform(那个ref,'foo')  → true      ← foo 能读 foo_bar 的凭据
credentialRefFor('a-b') === credentialRefFor('a_b')        ← 两个平台共用一个命名空间
'tieba'/'Tieba'/'tie ba'/'tie.ba' 全部塌缩成 TIE_BA
```

修法两条，缺一不可：

1. **编码改成单射**（新增 `src/platforms/credentials.ts`）：`_`→`__`，
   其余非法字符→`_<HEX>_`。`a_b` → `A__B`、`a-b` → `A_2D_B`，永不相撞。
2. **归属判定改成精确比较**，不再是 `startsWith`。平台 id 先过
   `validatePlatformId`（小写、32 字符内、首字符字母数字、不以分隔符结尾），
   不合法一律返回 `false` —— 归属不确定时拒绝访问。

顺带修掉两个同源问题：

- **`secrets.ts` 里有第二份实现**，修了一处另一处仍然有洞。现在那份改为
  re-export，一份定义。
- **`llm` 平台能读到模型 API Key**：`credentialRefFor('llm','api_key')` 与
  `LLM_KEY_REF` 字符串完全相同。新增 `RESERVED_STEMS = ['LLM']` 拒绝该 id。

`tieba` 的 `DSH_AI_DEBATE_TIEBA_COOKIE` 通过一个**封闭的** legacy 表保留字面量，
不是靠规范化规则——否则 `tie_ba` 会顺带继承 `tieba` 的凭据。

### 二、P1：分页矛盾不再算完整

0.2.1 里 `hasMore: false` 分支先于页数检查被读到，于是
`declaredTotalPages=8` + 第一页 `hasMore=false` 得到
`pagesRead=1, complete=true, stopReason='confirmed_end'`。新增
`StopReason = 'inconsistent_pagination'`，四个方向都覆盖：

| 矛盾 | 修前 | 修后 |
| --- | --- | --- |
| 声明 8 页，第 1 页说没有更多 | complete=true | inconsistent_pagination |
| 声明 3 层，读完只有 1 层且说没更多 | complete=true | inconsistent_pagination |
| 声明 10 楼，实际读到 12 楼 | complete=true | inconsistent_pagination |
| 声明 1 页但说还有下一页，第 2 页确实存在 | complete=true，静默丢页 | inconsistent_pagination |

最后一条是子智能体在写回归测试时发现的**反向**冲突，我第一版只修了单向。
`>=` 也改成了 `===`：多读出来的楼层恰好证明平台给的总数不可信，
不能再用那个数去证明完整。

`FloorWalk` 新增 `issues`，把「哪两个数字互相矛盾」写清楚，而不只是给一个状态码。

### 三、P1：完整性拆成四个问题

一个布尔 `complete` 同时在回答四件事，于是「读了 3 层、按 `maxFloors` 只留 1 层」
仍然报 `complete=true`——模型没看到的内容被当成看过了。

新增 `CompletenessReport`：

| 字段 | 回答的问题 |
| --- | --- |
| `sourceComplete` | 平台的证据是否证明读全了 |
| `retainedComplete` | 读到的是否全部保留（`droppedByCap` 为 0） |
| `analysisComplete` | 关键争论链是否在手上 |
| `nestedComplete` | 楼中楼是否读全 |

外加 `droppedByCap`、`retainedRatio`、`reasons`。`complete` 保留但收紧为
`sourceComplete && retainedComplete`，所以老调用不会因为裁剪而继续被误导。

### 四、平台账号绑定（任务书第六节）

新增 `src/platforms/accounts.ts`：`PlatformAccountBinding` / `OwnerBinding` /
`AiAccountBinding`，配 `resolveBindings` / `ownerFor` / `aiAccountFor` /
`isAllowedOwnerOn`。

**修掉一个严重漏洞**：`ownerIdentity()` 原来不带平台，整个配置里只有一组全局
账号字段。`analyzer.ts` 用裸 `===` 比较 id，而贴吧 `user_id` 与微博 `uid` 都是
9–10 位十进制数、互不相干——**一个 id 撞上，插件就会以主人的名义去替陌生人吵架**。
这正是 `analyzer.ts` 自己的注释里称为「最坏结果」的那种失败，此前只在单平台内
防住了，跨平台完全没有防线。

现在：`ownerIdentity(config, platform)`、`isAllowedOwner(config, userId, platform)`
都必填平台；`analyzeDispute` 拒绝「主人绑定在 A 平台、帖子在 B 平台」；
`ownerFor` 查不到就返回 `undefined`，**绝不回退到别的平台**。

兼容：全局字段一律解释为贴吧的（`config.ts` 原本就写着 "Tieba user id"，
`store.ts` 对 0.2.0 前的记录也是这个假设）。贴吧用户无感，其它平台从「借用贴吧
身份」变成「明确未绑定」。新增 `platformAccounts` 配置字段可选择进入新模型；
**迁移是派生，不写回用户配置**。

### 五、ConversationGraph 与 DebateBrief（任务书第七、八节）

- 新增 `src/conversation.ts`：`ConversationNode` / `ConversationEdge` /
  `ConversationGraph`，节点管身份与内容，**边管关系**。这样「转发既是一条新内容
  又是指向原帖的边」能表达，而两层树表达不了。每条边带 `certainty: stated |
  inferred`，猜出来的关系不许冒充平台声明。
- 新增 `src/conversation-bridge.ts`：贴吧两层结构到图的投影。**贴吧解析器只填
  `replyToName` 不填 `replyToPostId`，所以不生成 `replies_to` 边**——按昵称猜
  回复关系正是会答错人的那条路，缺口写进 `coverage.issues` 而不是静默消失。
- 新增 `src/brief.ts`：`DebateBrief`，每个论点都必须引用 posts id，
  `validateBrief` 拒绝「引用没读过的帖子」「把对方的发言当成主人的立场」
  「单方面说法标成双方确认」。`PersonaConfig` 不在校验参数里——人格负责语气，
  不能改事实。

### 六、一次性真实发表验收（任务书第五节）

贴吧的 `comment.publish` / `comment.reply` 是 `unverified`，而发表闸门只放行
`supported`。**不改能力状态**——把 `unverified` 改成 `supported` 让测试证明自己
成立，正是能力模型要挡的那种谎。

新增 `src/verification.ts`，一条与日常发表**完全分离**的路径：

- 四项授权必填且无默认值：账号、帖子、授权人、预批正文；正文不现场生成，
  否则观测到的是「模型写了什么」而不是「平台对已知内容做了什么」。
- 一份授权只发一次，用 `authorizationKey` 去重，不能变成批量发帖机。
- 只在 `unverified` 时可用；`supported` 无需验，其它状态验了也说明不了什么。
- 登录账号必须是授权账号，否则就是拿别人的登录态发帖。
- 升级到 `supported` 要求四项回读证据齐全（帖子出现、作者、正文、父级位置）。
  「拿到了 post id 但内容对不上」不算证据。
- 失败即停：403/429/验证码/权限不足都保持 `unverified`。

**这一轮没有执行真实发表**：本机对 `tieba.baidu.com` 持续 403（拦截页标题
「百度安全验证」，`server: bfe`；同时 `www.baidu.com` 与 `example.com` 均返回
200，是本机 IP 被标记）。因此两项能力的真实状态仍是 `unverified`，未绕过。

### 七、测试

**518 项全绿**（0.2.1 的 453 项 + 新增 65 项）。新增：

| 文件 | 数量 | 覆盖 |
| --- | --- | --- |
| `test/credential-namespace.test.ts` | 12 | 前缀包含、连字符/下划线、大小写、特殊字符、tieba 兼容、`llm` 保留字、双实现检查、fail-closed |
| `test/pagination-integrity.test.ts` | 23 | 四种信号矛盾、重复页、限流、超时、分页上限、正常路径 |
| `test/conversation-graph.test.ts` | 8 | 无楼层平台的图投影、回复边只记 stated、覆盖率不自升级、环截断 |
| `test/debate-brief.test.ts` | 12 | 引用不存在、归错方、单方证据冒充共识、目标不在对话里 |
| `test/verification.test.ts` | 10 | 只有 unverified 可验、授权必填、一次一授权、账号匹配、四项回读 |

### 未验证

贴吧真实读取与真实发表都未验证（原因同上：本机 IP 403）。分级如下，不混为一谈：

- 单元测试：已跑，全绿
- 模拟集成测试：已跑，全绿
- DSH 实际加载测试：已跑（裸目录安装 + 9 工具挂载）
- 真实贴吧读取测试：**未做**（403）
- 真实贴吧发表测试：**未做**（403，且能力保持 unverified）

## [0.2.1] — 2026-10-28

跨平台架构加固。0.2.0 把插件拆成了「通用核心 + 可插拔平台」，但拆完才发现
**接口是通用的、行为还是贴吧的**：链接能解析、凭据能分清、发帖闸门却绕得过，
楼层号这种贴吧专有的东西还卡在核心的必经路径上。这一轮把这四处补齐，
不是新增功能，是让 0.2.0 那句「平台无关」真的成立。

### 一、能力闸门接在真实发布路径上

0.2.0 引入了 `assertCapability`，规定 `unverified` 也 fail-closed（代码存在
不等于发得出去）。但它当时只是被导出，**没有任何生产路径调用它** ——
所有测试都是直接调 `assertCapability` 断言它抛错，于是「闸门存在」和
「闸门拦住了一次真实发表」被混为一谈。

现在 `publisher.ts` 在真正发送前调用它，并且判断用的是**候选自己的快照**
（`candidate.targetSnapshot.targetKind`），不是会话上那个可选字段：

```ts
function capabilityForSession(
  session: StoredSession,
  candidate: StoredCandidate,
): 'comment.publish' | 'comment.reply' {
  const kind = candidate.targetSnapshot?.targetKind ?? session.targetKind ?? 'nested'
  return kind === 'nested' ? 'comment.reply' : 'comment.publish'
}
```

此前两者分开读，出现过「按 `comment.publish` 获批、实际按回复发出去」的情况 ——
检查的能力和真正执行的动作不是同一件事。回退顺序与发送路径逐字一致，
两边不会再漂移。

`test/platform-routing.test.ts` 的「只读平台在真实发表路径上被拒绝，且平台适配器
一次都没被调用」是这条的判据：它不走 `assertCapability`，走的是真实
`publishReply`，并断言替身适配器的 `publishes` 数组仍是空的。

### 二、核心不再依赖贴吧式楼层

`TimelineEntry` 原来靠 `floorNumber` 分组，`analyzer` 用
`entry.floorNumber === container.floor.floorNumber` 圈定「这层楼里谁在跟谁吵」。
微没有楼层号，于是接入方只能**编一个数字**，否则分析器认不出任何发言属于同一层。

改用楼层帖的稳定 id 分组，`floorNumber` 降级为纯展示字段并变成可选：

- `TimelineEntry` 新增必填 `floorPostId`，`floorNumber` 改为可选。
- `Floor.floorNumber`、`Statement.floorNumber`、`Dispute.floorNumber`、
  `TargetSnapshot.floorNumber` 全部改为可选 —— 平台不给就不给。
- `describeParticipants` / `nestedOf` 同时接受 id 和数字，老调用不会静默失效。

**顺带修掉一个会喂给模型的真缺陷**：`compressor.ts` 无条件拼
`第 ${dispute.floorNumber} 楼`，没有楼层号时会把字面量「第 undefined 楼」
写进提示词，模型会当成真实位置去描述。新增 `floorLabel()`（collector）与
`renderLocation()`（compressor）统一处理，`collector` 的进度与 issues 文案、
`runtime` 的可疑指令告警、`target` 的目标漂移提示、`tools` 的三处界面文案
一并改用，不再有占位符漏出去。

`test/no-floor-number.test.ts` 是这条的判据：整个线程里**一个楼层号都没有**，
从建时间线、认对手、列参与者、压上下文、还原发表目标一路走通，并断言
输出里不含 `undefined` / `NaN`。

### 三、分页完整性

`collectThread` 与 `tieba/adapter` 在按楼层号排序时假定它是数字，改成
`(a.floorNumber ?? 0) - (b.floorNumber ?? 0)`，没有号时保持原顺序而不崩。

### 四、测试

453 项全绿（0.2.0 的 445 项 + 新增 8 项楼层无关验收）。
新增 `test/platform-routing.test.ts`（9 项：双平台同 Runtime 各读自己的帖子、
未知链接被拒、`adapterFor` 不为别家服务、每平台只拿到自己的配置与凭据、
命名空间不能跨读、同帖 id 额度互不影响、只读平台与 unverified 平台在真实
发表路径上被拒）与 `test/no-floor-number.test.ts`（8 项）。

### 未验证

贴吧真实帖子的完整流程仍未验证：本机对 `tieba.baidu.com` 持续返回 403
（拦截页标题「百度安全验证」，`server: bfe`），同时 `www.baidu.com` 与
`example.com` 均正常返回 200，说明是本机 IP 被标记而非代码问题，未绕过。

## [0.2.0] — 2026-10-27

平台无关的 Agent 核心。这一轮**没有新增任何功能**，它做的是把一个单平台插件
拆成「通用核心 + 可插拔平台」，并把这件事实用测试固定下来。

**核心验收标准**（写成了测试，不是写在文档里）：新增一个只读模拟平台，
不需要修改 Runtime / Publisher / Generator / Analyzer。`test/platform-contract.test.ts`
会直接读编译产物，断言这六个文件里既没有贴吧 import、也没有 `platform: 'tieba'`
字面量、也没有 `id === 'tieba'` 特判。

### 一、平台注册中心

新增 `src/platforms/contracts.ts` 与 `src/platforms/registry.ts`。

- **Provider 与 Adapter 分离**。Provider 是平台的静态描述（这个链接归不归我、
  我支持什么、怎么造适配器）；Adapter 是有状态的实例（cookie jar、缓存）。
  这样注册中心回答「这个链接属于哪个平台」不需要构任何东西、不联网。
- **注册中心负责五件事**：注册 / 注销 / 按 id 查 / 按链接解析 / 能力断言与诊断。
  第一个认领链接的 provider 胜出，顺序是显式且有文档的。
- **重复注册同一个 id 直接抛错**，不静默替换——静默替换等于让错误的平台处理链接，
  从外部完全看不出来。
- **一个坏 provider 不能拖垮其它**：`canHandleUrl` 抛错会被跳过，`buildRegistry`
  把注册失败的记录进 `rejected`，其余照常注册。

### 二、能力从布尔变成状态

旧模型只有一句 `publish: true`，它同时可能意味着「代码写了」「对未登录页面验证过」
「真实账号发表成功过」。这三件事完全不同，而混为一谈正是插件会谎称支持某平台的原因。

新模型五个状态：

| 状态 | 含义 |
| --- | --- |
| `supported` | 在真实平台上验证过，带 `lastVerifiedAt` |
| `unverified` | 代码存在，但没有真实验证——**旧布尔 `true` 一律转换到这里** |
| `permission_required` | 平台能做，应用/账号没权限；必须写明 `requiredPermissions` |
| `degraded` | 能用，但拿到的比平台实际有的少 |
| `unavailable` | 平台不提供，写代码也没用 |

12 项能力（读帖 / 评论列表 / 分页 / 子评论 / 定位 / 身份验证 / 艾特 / 发表 /
回复 / 回读 / 图片内容 / 用户资料）各自独立声明，每项都带状态、原因和限制。

**贴吧的能力矩阵是手写的，不是从布尔转换的**——因为贴吧是唯一真正测过的平台，
而测试结果并不好看：`comment.publish` 是 `unverified`（只验证了未登录拒绝），
`event.mentions` 与 `media.read`、`user.profile` 是 `unavailable`，
`comment.nested` 是 `degraded`（限流时降级为内联副本）。

`assertCapability` 对 `unverified` 也 fail-closed：写路径全部过这道闸，
「代码存在」不足以成为向陌生人发送字节的理由。

### 三、核心不再认识贴吧

- `types.ts` 的 `PlatformId` 从 `'tieba'` 联合类型改为 `string`。这正是注册中心
  的意义：新增平台不需要编辑这个文件。
- `target.ts` 的 `TargetResolver` 与 `TargetExpectation` 去掉贴吧字面量；
  平台从调用方 → expectation → adapter 自己的 id 依次推断，不再硬编码。
- `publisher.ts` 的 `PublisherDeps.adapter` 从 `TiebaAdapter` 改为 `PlatformAdapter`。
- `runtime.ts` 的 `Runtime.adapter` 同样改为接口类型，并新增可选的 `runtime.platforms`
  （`resolveUrl` / `diagnostics` / `capabilitiesOf`）。
- 新增 `src/platforms/tieba/provider.ts`：贴吧的链接判定、能力矩阵、适配器构造
  全部收在这一个文件里。`TiebaAdapter` 类本身**一行没改**。
- `makeAdapter` 改为通过注册中心构造，并新增 `adapterContextOf()`：
  适配器只拿到平台作用域的平面配置副本，拿不到整个 config 对象——
  这样未来的微博适配器不可能读到贴吧的 cookie。

**`PlatformAdapter` 契约补了两处**（都是发布路径本来就依赖的行为，之前只是没法从接口上表达）：

- `getReplyContext` 的 `options.forceFresh`——发布与回读都传 `true`，
  返回缓存内容会让「审核时的目标」和「发表时的目标」变成两回事。
- 可选的 `parseUrl`，让没有注册中心的裸适配器也能把链接转成 thread id。

### 四、未来平台的清单

新增 `src/platforms/manifests.ts`：微博、知乎、小红书、抖音各一份 manifest。

manifest **不是适配器**。它写清楚链接形状、对话结构、认证模型、研究到哪一步、
需要什么权限、已知什么约束，并且**不声明任何 `supported` 能力**。
`test/platform-manifest.test.ts` 会逐条检查这一点，包括「不能有
`lastVerifiedAt`，因为从来没验证过」。

四份清单都到了「读文档」阶段，没有一行评论 API 代码。小红书与抖音停得更早——
官方是否提供评论读写能力尚不明确，凭空编一个接口比什么都不写更糟。

### 五、设置页新增平台状态区

`viewOfSettings` 多了一个 `platforms` 字段（`SettingsRouteDeps.platforms?`），
把注册的适配器与未来的 manifest 分成两组下发，用 `implemented` 区分：

- 已实现的：显示 12 项能力的真实状态与原因；
- 未实现的：显示研究阶段、前置条件、约束、认证模型与链接形状。

**页面不可能把计划渲染成功能**，因为区别在数据里，不在文案里。
旧的路由测试不受影响（该字段是可选的）。

### 六、测试

新增两个文件，合计 26 项：

| 文件 | 数量 | 内容 |
| --- | --- | --- |
| `test/platform-contract.test.ts` | 17 | 两个假平台（不同分页、不同 id 方案、不同 URL 语法）各走完读→分析→生成→审核→发表→回读；相同帖子 id 不冲突；只读平台被拒绝而不是假装成功；核心代码静态检查 |
| `test/platform-manifest.test.ts` | 9 | 未实现的平台不得声明 supported；权限不足要写明要什么；微博转发放独立边；知乎问题作者不是答主 |

**436 项全部通过**（原 410 项全部保留且未修改语义）。

回归过程中修掉了一个自己引入的缺陷：`resolveThreadRef` 在没有注册中心时
把整个 URL 当成 thread id，导致 27 项旧测试失败。正确做法是回落到
adapter 自己的 `parseUrl`——这正是接口需要这个可选方法的原因。

## [0.1.13] — 2026-10-27

只改了两件事，都不碰运行逻辑。

### 一、许可证从 MIT 换成 AGPL-3.0

`LICENSE` 全文替换为 GNU Affero General Public License v3 官方文本（逐字，未增删改），
`package.json` 的 `license` 字段同步为 `AGPL-3.0-only`，README 的许可证章节改写。

**为什么换**：AGPL 比 MIT 多一条约束——**把本插件（或修改版）作为网络服务提供给他人使用时，
必须向使用者提供完整源码**。自己本地用、改了不发布，不受影响。

**为什么是 `-only` 而不是 `-or-later`**：`LICENSE` 里放的是 v3 全文。`-or-later` 会在法律上
额外授权使用者选择 FSF 将来发布的任何后续版本；这个决定应当由作者另行做出，不由许可证字符串
顺手代劳。所以这里锁死 v3。

**依赖兼容性**：`@deepseek-ai/schemastery` 与 `@deepseek-ai/cordis` 均为 MIT，MIT 与 AGPL-3.0
是单向兼容的（MIT 代码可以并入 AGPL 作品），本项目仍然可以正常分发。

### 二、README 安装命令的版本号同步到当前版本

README 的「方式一：GitHub 直接安装」和「方式二：本地 .tgz 安装包」还停在 `v0.1.9` /
`dsh-ai-debate-0.1.9.tgz`，而当时实际版本已经是 0.1.12。现在两处都跟随 `package.json` 的
`version` 走到 `v0.1.13` / `dsh-ai-debate-0.1.13.tgz`。

历史叙述里的 `v0.1.9` 等字样**没有动**——它们是「当时发生了什么」的记录，不是安装指引。

### 测试

运行逻辑零改动，仍为 **410 项**全绿（`node scripts/test-count.mjs` 实测，26 个测试文件，fail: 0）。

## [0.1.12] — 2026-10-27

稳定性加固。本轮修的都是**状态表示**问题：0.1.11 能用，但它对「凭据现在到底处于什么状态」
和「设置页的输入到底有没有生效」这两件事说了谎。

### 一、凭据初始化：从布尔到四态

#### 之前的问题

`overlayStale` 是一个布尔值，用来表示「内存里的凭据镜像可信吗」。它无法区分这四件事：

- 凭据库确实是空的；
- 凭据库还没解析完（`dsh-credentials-local` 先注册服务，再在 `Service.init` 里异步
  `loadInitial()`）；
- 凭据库说有值但读不出来；
- 读取直接抛错。

其中前两种在读取的那一刻**完全一样**：`describe()` 答 false、`resolve()` 返回 undefined、
不报错、也没有任何「有值但读不出」的迹象。0.1.9/0.1.10 把这种状态当成「库是空的」，
于是要么冻结空镜像，要么在页面上显示「已配置 · 长度 0」。

0.1.11 用「等 40ms 再读一次」绕过去。40ms 是个猜测，不是信号——凭据服务没有 ready 标志，
也没有初始化完成事件（已对着随包的 `@deepseek-ai/dsh-credentials-local` 核实）。

#### 修法

新增 `src/credential-mirror.ts`，把状态从布尔换成封闭的 `phase`：

| phase | 含义 | 可否发帖 |
| --- | --- | --- |
| `unknown` | 还没读过 | 否 |
| `loading` | 正在读，或预热窗口未关闭 | 否 |
| `ready` | 读到值，已在生效 | 是 |
| `partial` | 库说有值但没返回内容 | 否 |
| `failed` | 读取抛错，保留上次确认的值 | 否 |
| `timeout` | 预热窗口关闭仍无结论 | 否（配置层有 Cookie 时除外） |
| `unavailable` | 本部署没有凭据服务 | 视配置层而定 |
| `empty` | **只有确认过的清除**才能得出 | — |

关键设计：**普通读取永远不能得出 `empty`**。读不到东西只能得出 `timeout`，
因为「空库」和「还没加载完」在那一刻无法区分。只有用户执行了清除、并且库确认了删除，
才有资格说 `empty`。

预热改为有界重试 `[10, 40, 150, 300, 400]ms`（累计 900ms），穷尽后落到 `timeout`，
并在页面上显示「凭据库尚未确认（等待超时）」而不是「未配置」。

#### 发帖闸门

`canPublish()` 分两条规则：

- **Cookie 来自凭据库**：必须 `phase === 'ready'`。库是那个可能没加载完、可能被轮换掉的东西。
- **Cookie 来自配置**：`ready`/`empty`/`timeout`/`unavailable` 都行。配置文件里的一行静态
  字符串不会因为读不到库而变得更假，v0.1.5 的部署必须继续能发。

`publishCandidate` 在任何网络调用、任何幂等记录、任何 in-flight 占用**之前**检查它，
拒绝时 `errorCode: 'credentials_unproven'`，并按 phase 给不同的说明。

### 二、异步刷新乱序

每次读取和每次「已确认的写入」都取一个单调票号，只有更新的票号能安装结果。
保存路由在库确认写入后立即 `commit()`，使所有在途读取作废——它们读到的是写之前的库。

测试覆盖了任务书要求的那个时序：先起慢读取 A，再保存 B，让 B 先返回、A 后返回，
最终必须是 B 的值。

### 三、设置页表单**从来就没生效过**（0.1.11 的严重缺陷）

真实浏览器验收时发现：往任何一个输入框里打字，值立刻被 React 改回空，`有未保存的修改`
不出现，`保存` 按钮一直是灰的。控制台里是：

```
[Immer] minified error nr: 2
    at CardStore.edit
```

原因：`projection()` 把 `this.draft`（一个 `Map`）放进了快照对象，而 Host 的
`createSnapshotStore` 用 **Immer** 处理每个快照，Immer 不接受裸 `Map`（除非
`enableMapSet()`）。于是每一次 `store.set()` 都在 `edit()` 里抛出，值根本没被暂存。

**这意味着 0.1.9～0.1.11 的设置页只能看、不能改。** 修法是把 draft 拍平成
`draftSize` + `draftFields`（普通对象）。

这个缺陷 34 项客户端测试全绿也没抓到，因为所有假 store 都**接受任何快照**——
它们记录快照，不校验快照。新增 `test/client-snapshot-boundary.test.ts`，
用一个按 Immer 规则校验的假 store，专门测这条边界。

### 四、顺带修的

- `normalizeView()` 是白名单函数，Host 新增的 `credentials` 字段在这里被静默丢掉，
  整条凭据状态链路在前端断掉且不报错。已补上，并在注释里写明「路由 payload 加字段
  必须同步加到这里」。
- 诊断面板模板里的 `{awaiting}` / `{input}` / `{output}` 与后端键名不匹配
  （0.1.11 遗留），已改为 `{awaitingConfirmation}` / `{inputTokens}` / `{outputTokens}`。

### 五、文档与打包

- README 的 359 / 303 项已更正为 **410 项**，测试覆盖表由 `scripts/test-count.mjs`
  重新生成。
- 源码 ZIP 里移出了 4 个本机诊断产物（`asar-files.txt` 和 3 个 `scripts/tmp-*.mjs`），
  它们是研究 DSH 内部机制时的临时脚本，与项目无关。

### 六、测试

**410 项全部通过**。本轮新增 40 项：

| 新增文件 | 数量 | 覆盖 |
| --- | --- | --- |
| `test/credential-mirror.test.ts` | 20 | 四态区分、100/500/2000ms 慢初始化、读异常保留旧值、票号乱序、invalidate、dispose、发帖闸门 |
| `test/publish-credential-gate.test.ts` | 9 | 未证实状态在零网络调用、零幂等记录前被拒；无凭据服务的部署不被误拦 |
| `test/client-credential-badge.test.ts` | 6 | 真实 DOM 下各 phase 的徽章文案，超时不得显示成「未配置」 |
| `test/client-snapshot-boundary.test.ts` | 5 | 快照不得含 Map/Set/类实例（Immer 边界） |

### 七、真实浏览器验收（隔离环境）

全部在 `DSH_HOME` 指向的临时 home + 独立 Edge 配置里完成，**没有碰主人真实 profile**。

| # | 操作 | 结果 |
| --- | --- | --- |
| 1 | 打开 AI代吵架设置页 | 五个区域全部渲染 |
| 2 | 修改「额外可召唤的主人 ID」 | 真实键盘输入，`有未保存的修改` 出现 |
| 3 | 点击页面底部「保存」 | `POST /settings` → `{"set":{"allowedOwnerIds":"…"}}`，HTTP 200 |
| 4 | 页面提示 | 「已保存，后台已使用新值。」 |
| 5 | 服务端重读 | 值一致 |
| 6 | 刷新页面 | 值保持 |
| 7 | **完全重启 Host** | 值保持 |
| 8 | 保存 Cookie | 27 字符，末四位 …A111 |
| 9 | 保存 API Key | 24 字符，末四位 …B222（互不覆盖） |
| 10 | 分别清除 | 各自 cleared=true，互不影响 |
| 11 | 再存值后重启 | 两个凭据都正确持久化，`phase=ready` |

### 八、未验证项

- 没有在主人日常使用的那个 DSH profile 里重启验证过。
- 贴吧真实帖子全流程（读帖、识别争论对象、生成、发表、回读）仍**未验证**：
  本机对贴吧持续 403，本轮没有绕过，也不打算绕过。
- API Key 轮换后作用于下一次模型请求，这一点是靠代码路径与单测确认的，
  没有在真实模型调用上抓包核对。

## [0.1.11] — 2026-10-27

### 修复：冷启动后设置页把已保存的凭据显示成长度 0

现象：重启 DSH 之后打开设置页，Cookie 与 API Key 两行都显示「已配置」，
但长度是 0、掩码尾巴是空。之前每次都要「随便保存一个值」才恢复正常。

#### 根因

`ctx.credentials` 在当前 Host 实现里**先发布服务、后解析文档**
（`dsh-credentials-local` 的 `loadInitial()` 在 `Service.init` 里异步执行，
`this.values` 要等 YAML 读完才赋值）。因此插件挂载时的那次读取看到的
是一个合法的空 `Map`——`describe()` 回答 `configured: false`，`resolve()`
返回 `undefined`，**既没有报错，也没有任何「有值但读不出」的迹象**。

v0.1.9 判断「镜像是否可信」用的是：

```
stale = error !== undefined || unresolved.length > 0
```

这两个条件在这种状态下**都为假**，于是那次空读取被当成「库确实是空的」，
标志位被清掉，`ensureSecretsFresh()` 从此一律提前返回，空镜像就冻结在
进程的整个生命周期里。只有真正的写操作（`credentials/reference-updated`）
才会触发重新读取——这正是「存一次就恢复正常」的原因。

同一次响应里 `describe()` 却答 `configured: true`，因为它是在 `viewOfSettings`
里现调的，微秒之后服务已经把文档读完了。**于是同一个响应里 `configured`
和 `length` 来自两个不同时刻的库状态**，页面就显示成「已配置，长度 0」。

#### 修法（三处，均在配置面，不碰采集/分析/生成/发表）

1. `loadOverlay()` 增加 `empty` 字段：一个引用都没有解析出值时如实上报
   「什么都没拿到」。空库和「还没加载完」在那一刻无法区分，所以不再假装
   能区分。
2. 可信判定加进 `empty`：全空读取一律保持「待重试」，不再冻结。
   读取成功后清零重试计数，让下一次冷启动仍有自己的额度。
3. 设置页/状态路由不再走 `ensureSecretsFresh()` 的**有界重试预算**，
   改为无条件重读；并在读到全空时等 40ms 再读一次
   （`loadInitial()` 只是一次文件读，这个窗口足够）。重试预算的用途是
   拦住工具调用无限打库，不该成为「人打开页面看到旧状态」的原因。

#### 测试

`test/cold-start-credentials.test.ts` 新增/改写 5 项，其中最关键的一条
直接复现真实形状：`describe()` **和** `resolve()` 在文档未解析时都答「没有」。
旧的测试辅助函数漏掉了 `empty` 这一条，所以它和缺陷本身口径一致、
根本抓不住问题——这一点也一并修掉了。

全量 368 项通过。

### 同时修复：诊断面板显示未替换的占位符

截图验收时肉眼发现：`诊断与状态` 面板显示「待确认 {awaiting}」「输入 {input} tokens」
「输出 {output} tokens」。模板里写的占位符名和后端返回的键名对不上——

| 模板要求 | 后端实际返回 |
| --- | --- |
| `{awaiting}` | `awaitingConfirmation` |
| `{input}` | `inputTokens` |
| `{output}` | `outputTokens` |

`format()` 的语义是「不认识的占位符原样保留」，所以这不是崩溃，而是把
内部名字直接印给了用户。中英文两套模板都改对了。

新增 `test/client-placeholders.test.ts`：从 `client.cjs` 里抽出每个模板的
`{name}`，从 `src/settings-routes.ts` 里抽出对应 payload 的键名，逐个比对。
键名是从 TypeScript 源码读的、不是手抄的，所以以后谁改了后端字段，
这个测试会红，而不是等用户看见花括号。

全量 370 项通过。

#### 未验证项

本轮的真实冷启动复现是在**隔离 home**（`DSH_HOME` 指向临时目录）里做的，
没有在主人日常使用的那个 DSH 里重启验证。

## [0.1.9] — 2026-10-27

第十轮：**安全与配置界面完善**。本轮不碰采集、分析、生成、去重与发表逻辑，
只改配置面的授权、表单行为和文档。

### 一、设置 API 的授权（安全）

#### 之前的问题

设置路由有三道检查：socket 是回环、Host 是回环、Origin 与 Host 同源。三条都是
**形状检查，没有一条建立身份**：

- 本机任何进程都能连 127.0.0.1，也能伪造 `Host`；
- `Origin` **缺失时返回 true**，而非浏览器客户端本来就不发 `Origin`；
- 所以 `curl http://127.0.0.1:<port>/api/dsh-ai-debate/secrets` 只要带上
  `Host: 127.0.0.1:<port>` 就能写凭据。

这不是理论风险。同一时刻实测本机 DSH 自己的 `/api/*` 全部返回 **401**，
而本插件的路由返回 **200**——宿主有认证，插件没有。

#### 修法：复用 DSH 官方机制

DSH 的 Connection 层本来就提供浏览器会话认证：进程级随机启动令牌 → `GET /` 兑换成
签名 cookie（`HttpOnly`、`SameSite=Strict`、绑定监听 authority）→ 之后每个请求校验。
它还导出了正是为此设计的入口：

```ts
ctx.connection.requestRejection({ headers })  // 401 | 403 | undefined
```

插件的路由不变，在形状检查之后加**第二阶段**，委托给它：

```ts
// 阶段 1：形状（回环 peer、同源 Host/Origin）——挡 DNS rebinding 与跨站提交
// 阶段 2：身份（签名会话 cookie）——挡本机其它进程
const verdict = authorize(request)   // 'ok' | 401 | 403
if (verdict !== 'ok') { /* 不执行任何写操作 */ }
```

四条刻意设计：

1. **没有 `authorize` 就全部拒绝**（403），绝不回退到「回环即可信」。
2. **authorizer 抛异常算拒绝**，不算放行。
3. **`Origin` 缺失不再等价于可信**：形状检查放行只为让它走到第二阶段。
4. **拒绝发生在任何副作用之前**：`test/settings-auth.test.ts` 逐条断言
   被拒请求没有写配置、没有存凭据、没有清凭据、没有暂停任务、没有发探测请求。

覆盖范围：`GET /settings`（读）、`POST /settings`、`POST /secrets`（存/清）、
`GET /status`、`POST /action`（含 `pause-now`）——**全部**受保护，不只是写。

令牌不落盘、不进日志、不进模型上下文：它由 DSH 自己以 `HttpOnly` cookie 持有，
本插件从不读取也不转发它的值，只问「这个请求通过了吗」。

### 二、温度滑块

`RangeField` 的 `step` 原本写死为 1，而 `llmTemperature` 是 0～2 的浮点、
默认 0.4。后果：滑块只能取 0/1/2，**默认值 0.4 用鼠标根本调不出来**，
已存的 0.4 打开页面还会显示成 0。

- `RangeField` 改为接受 `step`，**不传时仍是 1**，其它滑块行为不变（有测试钉住）。
- `llmTemperature` 用 `step: 0.1`，范围保持 0～2。
- 显示值由**将要保存的那个值**按 step 精度推导（`decimalsFor` + `roundTo`），
  看见的就是存下的。
- 滑块旁加一个数字输入框：浏览器的 range 控件不保证能用键盘精确调到 0.4。
- 舍入不是装饰：`0.1 * 3` 是 `0.30000000000000004`，直接存会写出没人输入过的数。

### 三、凭据保存

之前 `onSave` 是「调用后立刻清空输入框」，而 `saveSecret` 把错误吞进
`this.failed` 后 **resolve**。于是保存失败（无权、没有凭据服务、401）时，
用户刚粘贴的 Cookie 被静默吃掉，还得回浏览器重新找。

- `saveSecret` / `clearSecret` 改为**失败时 reject**；`clearSecret` 还读响应里的
  `cleared: false` 并如实报错。
- `SecretField` 只在**兑现**后清空；失败保留文本并显示「保存失败：<原因>」。
- 保存中禁用按钮（`busy`），不会重复提交。
- 清除是**两步**：先出确认文案，再点确认，不再是同一个按钮的开关。
- 清除后用响应里的 view 刷新，徽标反映凭据库真实状态而不是假设。
- 文案分拆：两个输入框原来都写「粘贴新的 Cookie」，模型 Key 那一行也这么写；
  现在是「粘贴新的贴吧 Cookie」/「粘贴新的模型 API Key」，按钮同样分开。
- 旧版配置回退的兼容保留，并继续用徽标明确提示「当前用的是配置文件里的旧值」。

### 四、「暂停所有自动任务」

**这是本轮唯一必须承认的功能改动。** 本插件**没有后台调度器**：没有队列、没有
定时器，自动发表是靠 `limited_auto` 模式在一次工具调用里当场判定的。所以
「暂停所有自动任务」这句承诺兑现不了——原来的按钮只是把两个字段放进待保存草稿，
既没保存，也没停任何东西。

按要求，不虚构能力，改为**两个语义分开的入口**：

| | 关闭自动发表模式（需要保存） | 立即暂停所有任务 |
|---|---|---|
| 性质 | 配置修改 | 立即生效的真实操作 |
| 做什么 | 把 mode 改人工、额度改 0 | 调后端 `pause-now` |
| 需要保存 | **是** | 否 |
| 对已开始的任务 | 无影响 | **真的停止** |

后端的 `stopAllActive()` 做什么：遍历会话，对每个未终结的会话先
`cancelInFlight()`（发送中的请求在真正发出前中断），再走状态机置 CANCELLED。
**已经发到贴吧的回复不撤回**——没有接口能撤回，谎称撤回会让主人据此做错判断；
这类记录保持为已发表并单独计数返回。

返回三个独立事实：`stopped`（停掉几个）、`abortedInFlight`（中断几个在途请求，
按真实的 in-flight 控制器计数，不是拿会话数充数）、`alreadyPublished`（几条已经
发出去了）。页面分别显示，不会用一个绿色徽标盖住「有几条收不回来」。

并发安全：先 abort 再改状态，且状态机本身拒绝把 PUBLISHED 改成 CANCELLED，
所以「取消撞上发送」不会写出矛盾状态；`stopSession` 失败记入 `refused` 并如实上报。

### 五、模型 Base URL 的 HTTPS 提示

- 公网明文 HTTP：显示明确警告，说明 API Key 随 `Authorization` 头每次发出、
  同路径任何人都能读到。
- 本机 / 内网明文：只给一条说明，**不当作漏洞**——本地 llama.cpp、公司内网网关
  都是常见用法，对它们报警会训练用户忽略警告。
- **绝不静默把 http 改成 https**：本地服务改了就连不上，而且会掩盖「实际用的地址
  和配置的不一样」这件事。
- 测试连接不记录完整 API Key（代码里本来就没有，本轮有测试钉住）。

### 六、配置表单完整性

- **底部操作栏遮挡**：sticky 栏浮在内容上，最后一个区块（运行状态）被压在下面，
  滚到底也看不全。在滚动容器上补 `padding-bottom`（补在 sticky 元素自己身上无效）。
- **Windows 高 DPI / 窄宽度**：根节点加 `box-sizing`、`max-width`、`min-width:0`、
  `overflow-x:hidden`，并让长串（base URL、cookie 末四位）可断行——缩放环境下
  真正的破版原因就是长串把 flex 行撑宽。
- **未保存提示**：`hasUnsavedChanges()` 暴露事实，`document.title` 加 `*` 标记。
  不弹 `window.confirm`——导航归设置外壳管，组件不该抢这个决定。
- **卸载清理**：审计确认无定时器、无事件监听器泄漏；订阅在 `useEffect` 的清理函数里释放。
- **持久化 / 重启恢复**：配置走 Host 的 settings 服务、凭据走 `ctx.credentials`，
  两者都是 DSH 自己的持久层，重启后由它们恢复。

### 七、诊断面板版本号

`PLUGIN_VERSION` 是硬编码字符串，**已经漂了**：写着 `0.1.6` 而包是 `0.1.8`，
面板一直在报一个不存在的版本。改为从 `package.json` 读取，并加测试钉住。

### 八、测试

从 312 增至 **337** 项，全部通过。

- `test/settings-auth.test.ts`（18 项，新）：无凭据 401、伪造/过期 401、错 authority 401、
  403 不被压成 401、正常桌面请求放行、**没有认证机制时拒绝而非回退**、
  authorizer 抛异常算拒绝、非回环在 authorizer 之前就被挡、跨站、外域 Origin、
  异机 Host、**缺 Origin 仍需身份**、**本机其它进程写不了凭据**、
  逐条路由断言被拒请求无副作用、只读 status 也受保护、被拒的 pause 不停任何东西、
  授权后的 pause 如实报告。
- `test/client-react-dom.test.ts`（9 → 16 项）：新增温度 step/精度、其它滑块不受影响、
  两个凭据框文案不同、**保存失败保留粘贴内容**、两个暂停入口一个不发请求一个发、
  公网 http 告警且不改写、本机 http 只提示。
- 顺带修好一个测试环境缺陷：vm 沙箱没给 `URL`，导致 HTTPS 风险检查恒返回 null，
  告警永远不渲染——正是它要防的那类静默失效。

### 九、真实环境验收（重启后实测）

宿主 17:22:24 启动，包 16:58:55 装好，确认加载的是 0.1.9。以下为**真实环境**结果，
不是模拟：

| 检查 | 结果 |
| --- | --- |
| 无会话请求 `GET /settings` | **401** |
| 无会话请求 `POST /settings`（改设置） | **401** |
| 无会话请求 `POST /secrets`（写凭据） | **401** |
| 无会话请求 `POST /action`（立即暂停） | **401** |
| 无会话请求 `GET /status` | **401** |
| 对照：DSH 自己的 `GET /api/settings` | 401 |
| 对照：其它第三方插件的 `/api/*` | 401（本插件现已与全局一致） |
| 客户端槽 `settings.section` 里 dsh-ai-debate | `active: true`（认证没有破坏注册） |
| 客户端 bundle 提供 | **200**，95561 字节，含全部 0.1.9 修复标志 |
| 被拒写入后凭据库 | **sha256 与基线一致，零改动** |
| 被拒写入的全盘残留 | **无** |

认证失败时的响应体是固定的中文提示，**不含** Cookie、API Key 或会话凭据。

#### 尚不能在真实浏览器里端到端验证的部分

本机无法取得 Electron 渲染进程持有的会话 cookie（进程命令行里没有 token，
根路径 `GET /` 也返回 401），因此**「登录用户在真实浏览器里点开设置页并保存」
这一步没有在本轮完成**。能证明的是：路由在鉴权层之前返回 401（而不是 404），
说明注册与拦截都在位；客户端 bundle 正常提供且包含全部修复；槽位 active。

把这三点合起来看，「认证机制误伤正常用户」的概率很低，但它**不等于**已验证。
报告里单独标注为未完成。

### 十、仍未验证的贴吧能力（如实记录）

本轮**没有**在真实贴吧上做任何写操作验证。以下能力仍属未验证：

- 真实登录后的发表是否成功（本机 IP 对贴吧持续 403）；
- 自动艾特召唤；
- 完整楼中楼读取（仅按页面内联数据与接口补充，未覆盖全部形态）；
- 发表后的回读核对在真实平台上的命中率。

配置页面的保存、生效、重启恢复这些**不依赖贴吧**的部分，已经可以验证。

## [0.1.8] — 2026-10-27

第九轮：**空白页面根因修复**。0.1.7 已经把入口、路由、bundle 全部打通，只差最后一步——
点开设置页仍然留白。本轮定位到真正原因并修复，**真实 React 下九个 DOM 断言全绿**。

本轮同样不碰采集、分析、生成、发表，只改客户端渲染。

### 一、根因：`ref` 是 React 的保留属性

组件把凭据字段的标识符当成普通 prop 传递：

```js
h(SecretField, { ref: REF_COOKIE, ... })     // ← ref 不是普通属性
```

`ref` 被 React 征用于转发 DOM 引用。给**函数组件**传一个字符串 `ref`，React 会当场抛出：

```
Function components cannot have string refs. We recommend using useRef() instead.
    at coerceRef
```

`AccountSection` 与 `ModelSection` 都这么用，两个区域在渲染时抛错。异常被设置外壳的
错误边界吞掉，面板留白，而侧边栏条目、控制器、路由、bundle 全都看着正常——
这正是 0.1.7 排查到最后仍然"差一层"的原因。

**为什么之前的测试没抓到**：渲染测试用假的 `createElement` 把组件当普通函数调用，
`ref` 只是一条普通字段进了 JSON 树；而 `ref` 的全部语义都发生在 React 里，
假渲染器看不见。

**修法**：prop 改名 `secretRef`（两处调用点 + 一处解构），不涉及任何逻辑。

### 二、测试：新增真实 React + 真实 DOM 的一层

新增 `test/client-react-dom.test.ts`（**9 项**），用 `react-dom/client` 挂进 jsdom，
断言"用户真的能看到什么"：

- 首次 publish 之后页面有内容（正是坏掉的那条路径）；
- store 用无参通知连续触发时页面不空白；
- 加载态在 fetch 落地前可见，落地后消失；
- 五个区域全部真的出现在 DOM 里；
- 输入框是真的可编辑表单控件；
- **凭据值永不进入 DOM**（树里搜不到，只显示末四位）；
- 后端失败时显示失败信息而不是空白；
- 保存会把暂存字段 POST 到插件路由；
- 卸载后订阅被释放。

写这一层时踩到两个测试自身的坑，一并记下：

1. **`react-dom` 必须在 `document` 存在之后才 import。**
   它初始化时会采样环境全局对象；在文件顶部 import 就等于在任何 jsdom 之前初始化，
   于是渲染看着正常、事件系统却是死的，`onChange` 永远不触发，保存测试无论如何都过不了。
   改为装了 document 之后再动态 `import()`。
2. **`includes('保存')` 会先命中"保存凭据"**。按钮选择必须用精确匹配，
   否则点的是存 Cookie 的按钮，永远看不到 `POST /settings`。

### 三、测试规模

从 303 增至 **312** 项，全部通过。

### 四、端到端证据

同一套 jsdom + 真实 `react-dom` 18.3.1 环境，分别挂载两版已构建产物：

| | 0.1.7（修复前） | 0.1.8（修复后） |
|---|---|---|
| 渲染字符数 | 崩溃，无输出 | **893** |
| `console.error` | 反复抛 `coerceRef` | **0** |
| 五个区域 | `<AccountSection>` / `<ModelSection>` 抛错 | **5** 个 `section.dsd-page-sect` |
| 表单控件 | — | 23 个 input、12 个 button |
| 凭据泄漏 | — | 明文密钥模式未出现在树里 |

修复版的渲染数据直接取自**运行中 Host 的真实路由** `GET /api/dsh-ai-debate/settings`
（1063 字节、33 个字段、两条凭据状态），不是构造的假数据。

**宿主侧观察到的同一现象**：客户端槽树的 `settings.section` 里，
`dsh-ai-debate` 条目的 `active` 为 `false`，而同槽的 `bili-whale` 为 `true`。
在 0.2.1 的实现里，`active` 由 `entriesOfSlot()` 判定，它会滤掉被 `abdicated`
标记的条目，而标记只发生在 `reportEntryError(..., { abdicate: true })`——即**该条目
渲染时抛过错**。这与上表的崩溃完全对应，也解释了为什么入口存在、点开却什么都没有。

### 五、验收状态

代码修复与行为证据已闭环。**真实 DSH 界面里"点开即见表单"的最后一次点击验收，
需要在宿主重启后进行**：本机会话内无法重启 Host，而客户端模块的 `pkgMeta` 缓存
（见 0.1.7 第三节）只在重启时重新解析，且已 abdicate 的条目也随重启清空。
重启后若仍为空白，则说明还有第二层原因，本节结论需要推翻重查。

## [0.1.7] — 2026-10-27

第八轮：**配置页真实显示**。任务书是「配置页面无法显示」的专项修复，因此本轮只动客户端装载与配置面，
不碰采集、分析、生成、发表。

### 一、为什么上一版看不见（三个独立原因，都已实测确认）

#### 1. 只注册了插件行的一个隐蔽标题，没有注册设置侧边栏

上一版只注册了 `plugins.row.config`。这个槽**确实注册成功**（`Slots.listSubTree` 里能看到
`{"key":"dsh-ai-debate#dsh-ai-debate","active":true}`），但它渲染的是插件行里那行
**没有可见文字、只有 `aria-label` 的标题**——必须先进「插件 → dsh-ai-debate」才知道能点。
所以「找不到配置入口」是准确的观察。

真正的可见入口是另一个槽：`settings.section`（list 槽，带 `id` / `order` / `label`）。
`dsh-bili-whale` 的「养鱼」页就在那里。

**修法**：两个槽都注册。

```js
ctx.slots.inject('settings.section', () => ctx.slots.register(
  { name: 'settings.section', id: 'dsh-ai-debate', order: 25,
    label: () => 'AI代吵架' },      // thunk：切语言不用重注册
  DebateSection))
```

#### 2. `settings.section` 不传递注册的 `inject` 面

这是**上一版页面全白的真正原因**。组件写成 `props.useDebateCard(...)` / `props.controller`，
而设置外壳渲染 section 组件时只给它声明的 owner props（`close`）和标准 hooks，
**不会**把 `registration.inject` 的面交过来。于是 `props.useDebateCard` 是 `undefined`，
组件在渲染中抛错，错误被外壳吞掉，面板留白而侧边栏条目看着完全正常。

实测确认：把组件换成一个只返回固定文字的版本，文字**出现了**；换回依赖 props 的版本，面板**又白了**。

**修法**：两个组件都改成**自己持有状态**——模块级 store + React state 订阅。
这也正是同版本里其它第三方设置页的写法。

#### 3. `pkgMeta` 缓存把「这不是客户端包」记到进程结束

`dsh-client-modules` 的缓存键是 `sourceKey() = ${baseUrl}\0${loaderName}`，
**不含 package.json 内容或修改时间**。0.1.5 首次挂载时包里还没有 `dsh.client`，
注册表就缓存了 `null`；0.1.6 加了声明，键没变，扫描继续命中那个 `null`。

实测：停用→启用**无效**（`processOne` 重跑了 `resolveMeta`，但缓存里直接拿到 `null` 返回）；
必须重启 Host 一次。0.1.7 起这一点写进 README。

同一条缓存还会锁住**解析出来的包路径**：插件从 `%TEMP%` 换到稳定目录后，注册表仍在读旧路径，
服务端一直返回旧 bundle（实测 `rev` 不变、内容不含新代码）。因此本轮把安装目录固定到
`~/.dsh/plugins/dsh-ai-debate/package`，不再用临时目录。

### 二、Host 侧：路由改为随服务注入

上一版用一次 `ctx.get('webServer', false)`；挂载那一刻服务若尚未就绪，就**永久**放弃注册。
这个失败是静默的：工具照常可用，只有配置页 404。

改成 Cordis 的作用域注入：

```ts
ctx.inject(['webServer'], (scope) => {
  const server = scope.get('webServer')
  const offs = makeSettingsRoutes(deps).map((r) => server.register(r))
  dispose = scope.effect(() => () => { for (const off of offs) off() }, 'routes')
})
```

- 服务晚到时**会**触发注册；
- 服务卸载时路由随之释放，重启后重新注册（否则第二次注册同名路径会撞车）；
- 不把 `webServer` 变成硬依赖，headless 部署照旧什么都不做；
- 刻意不用 `ctx.get` 的 `strict` 参数：它在不同 dsh 版本行为不一致，
  靠它等于让插件正确性依赖宿主版本。

### 三、可观测性：失败不再无声

- `apply()` 打三条 `console.info`（`apply() running` / `registering settings.section` /
  `registering plugins.row.config` / `settings page mounted`），且**不含任何密钥**。
- 两个组件各自有一层错误陷阱：内部抛错时把堆栈**画在面板里**（`SECTION-RENDER-ERROR` /
  `CARD-RENDER-ERROR`），而不是留白。这次就是靠它把问题从「看不见」变成「看得见」。

### 四、测试

从 294 增至 **303** 项。新增/改写：

- `test/client-module.test.ts`（9 项）：模块 id、两个槽都注册、section 的 `id`/`order`/`label`、
  label 随语言变、row 的 key 正确、**section 不带 inject 面**、row 仍带、两个槽用不同组件、
  注册失败只记日志不抛出、正常挂载留下可诊断日志。
- `test/client-render.test.ts`（8 项）：**不传任何注入 props** 渲染——
  section 五个区域字段齐全、只请求一次 `/api/dsh-ai-debate/settings`、
  凭据只显示末四位且树里没有密钥形状、row 卡片有内容、summary 只返回文本、
  加载态自述、不可用时给重试、只读时仍显示字段。
- `test/route-lifecycle.test.ts`（4 项）：服务已在时立即注册、**服务晚到时补注册**、
  服务重启后重新注册且卸载时释放、没有 `inject` 契约的宿主仍走 `ctx.get` 回退。

### 五、仍未通过真实界面验收（如实记录）

**设置侧边栏入口已实测出现**（截图：设置 → AI代吵架，位于 Agent 预设与联网搜索之间），
**「配置 dsh-ai-debate」按钮的 `aria-label` 已实测存在**（UIA 枚举到
`ControlType.Button rect=890,679,1082,30`）。

但**点击后表单区仍然留白**，本轮没有做到「打开就能填」。已经排除的：

- 槽注册（`active: true`，已核）；
- bundle 加载（离线求值 + `factory` 全通过，导出齐全）；
- 路由（真实 `GET /api/dsh-ai-debate/settings` 返回 200 且内容正确）；
- 渲染逻辑（离线用真实 payload 渲染出 12KB 树）；
- React hooks 的取用方式（已改成与 `dsh-bili-whale` 一致的解构）。

仍待确认的是**该 build 的 section 渲染器对组件返回值/异常的具体处理**——
`dsh-bili-whale` 的「养鱼」页在同一槽位、同一时刻能正常渲染（已截图对比），
说明槽本身可用，差异在组件侧，而本轮未能定位到最后一层。这一条保持未通过标记。
## [0.1.6] — 2026-10-27

第七轮：**DSH 原生 Web 配置页面**。

本轮不重构采集、分析、生成、发表核心逻辑；新增的是配置面，不是新的发帖能力。

### 一、为什么需要自建路由

DSH 的 settings RPC 只对**硬编码白名单**里的命名空间开放（`WEB_SETTINGS_NAMESPACES`
加上模型提供方与产品命名空间）。第三方插件的命名空间虽然由 Loader 行注册、也出现在
`configForms` 的能力目录里，但 **settings 写通道不会为它开放** —— 插件无法在不改 DSH
源码的前提下把命名空间加进白名单。

因此配置页走插件自己注册的回环路由（与随附的 `dsh-mem0` 卡片同一做法）：

| 方法 | 路径 | 作用 |
|---|---|---|
| `GET` | `/api/dsh-ai-debate/settings` | 读取已解析配置（**不含任何密钥值**）+ 凭据状态 |
| `POST` | `/api/dsh-ai-debate/settings` | `{ set?: {...}, unset?: [...] }`，经 settings 服务写入 |
| `POST` | `/api/dsh-ai-debate/secrets` | `{ ref, value }` 保存凭据，或 `{ ref, clear: true }` 清除 |
| `GET` | `/api/dsh-ai-debate/status` | 运行状态、台账、用量、近期错误 |
| `POST` | `/api/dsh-ai-debate/action` | `test-llm` / `check-login` / `preview-personas` |

四条路由共用同一道闸：**只接受回环地址**（`127.0.0.1` / `::1`）、
Host 头必须是本机、`sec-fetch-site: cross-site` 一律拒绝、带 `Origin` 时必须同源。
与 DSH 自己的浏览器信任边界同构。

### 二、凭据从配置里搬出来

v0.1.5 及以前，Cookie 和 API Key 是配置字段（`.role('secret')` 只保证它们不出现在
**浏览器线缆**上，值仍然躺在 profile 的 `cordis.patch.yml` 里 —— 而那个文件正是用户会
贴进 issue、截图、同步进仓库的东西）。

v0.1.6 起：

- Cookie 与模型 API Key 存进 **Host 凭据库**（`ctx.credentials`），
  引用名 `DSH_AI_DEBATE_TIEBA_COOKIE` / `DSH_AI_DEBATE_LLM_API_KEY`。
- `ctx.credentials` 是**异步**的，而 `resolveConfig` 是同步的 —— 中间用一个
  **内存 overlay** 桥接：挂载时读一次，之后每次 `credentials/reference-updated` 再读。
  overlay 有效的值**优先于**配置字段。
- 首次读取完成前 overlay 是空的，此时配置字段照常生效。所以：
  **没有凭据服务的部署退化成 v0.1.5 的老路径，而不是退化成「没有凭据」。**
- 配置里的旧的 `tiebaCookie` / `llmApiKey` 仍然能读（兼容），
  但只要凭据库里有值就**以凭据库为准**，并在页面上标注「凭据库里的值已覆盖配置文件的旧值」——
  不能让用户对着一个看着已配置、实际被忽略的字段猜。
- 配置写入通道**明确拒绝**写入这两个旧字段，只允许 `unset`（清除）。
  报错会告诉用户去凭据区保存。

### 三、`debate_bind_owner` 移除 `tiebaCookie`

登录 Cookie 是**凭据**，不是配置值。把它作为工具参数意味着它进入对话记录、
工具调用日志，以及**模型上下文** —— 这正是本轮要消灭的泄露路径。

- 参数从 schema 里删除。
- 旧调用方传了 `tiebaCookie` 时，工具**明确报错**并指路到配置页，
  而不是静默忽略（静默忽略会让调用方以为已经设好了）。

### 四、五个配置区域

页面注册进 `plugins.row.config`，键 `dsh-ai-debate#dsh-ai-debate`
（`<包名>#<Loader 行 id>`），入口为 **插件 → dsh-ai-debate → 配置**。

1. **百度贴吧账号** — 主人数字 ID / 名称、AI 小号 ID / 名称、额外可召唤 ID、
   Cookie 凭据栏（保存 / 清除 / 末四位识别）、登录状态检测、身份不一致提示。
2. **AI 模型** — Base URL、模型名、API Key 凭据栏、温度、最大输出 tokens、超时、
   上下文预算档位与自定义预算、**测试模型连接**按钮。
3. **人格** — 四种人格选择与五个强度滑杆，**预览四种风格**（本地渲染固定测试对话，
   不发帖、不调模型）。
4. **发表与安全** — 总开关、互动模式、自动发表上限、冷却、单帖上限、向 Agent 播报、
   **暂停所有自动任务**、台账与未确认记录。
5. **诊断与状态** — 运行状态、DSH 版本、插件版本、状态目录、会话统计、台账统计、
   模型用量、近期错误、限流状态。

页面**不复用也不绕过**任何身份 / 去重 / 目标校验：所有写入都是配置值，
发表路径照旧在 `publisher.ts` 里做完整校验。

### 五、浏览器半的形态

`client/client.cjs` 是**手写的纯 JavaScript**（不含 JSX/TypeScript），
注册方式与 DSH 官方客户端插件一致：

```js
window.__ModuleLoader__.load({ id: 'dsh-ai-debate', factory: (require) => { ... } })
```

`package.json` 增加 `exports["./client"]` 与 `dsh.client`（`platform: 'web'`，
`inject: ['@deepseek-ai/dsh-client-store', '@deepseek-ai/dsh-client-locale']`）。

挂载失败只**记日志不抛出** —— Web 外壳在客户端插件 `apply` 抛错时会整页启动失败，
为了一张设置卡丢掉整个界面是更糟的结果。

### 六、保存反馈

保存有明确的三种结果：

- **成功** —「已保存，后台已使用新值。」
- **失败** — 显示服务端返回的原因。
- **冲突**（409）— 说明配置已被其他窗口或配置文件改动，**自动重新载入最新值**并保留
  用户的草稿，提示再确认一次。只报「失败」而不重载，用户会对着同一份过期文档反复失败。

### 七、测试

从 245 项增至 **281** 项（新增 `test/settings-page.test.ts` 36 项）。新增覆盖：

- overlay 的合并 / 清除 / 空值等于不存在 / 单个引用失败不影响另一个；
- 遮蔽只给末四位，短于 8 字符不给尾号（遮四个六字符的值不算遮）；
- 配置页视图**序列化后不含任何密钥值**（用真实值做串断言，不是看字段名）；
- 设置写入按白名单校验、数字字段强制转换、未知字段报字段名；
- **旧明文密钥字段不可写、只可清除**；
- 只读部署拒绝写入、冲突如实报 409；
- 四条路由在跨站请求下一律 403，且不产生任何写入；
- 人格预览四种风格齐全，且**强度参数确实改变提示词**（这条一开始是红的：
  预览只截了提示词前三行，强度行在后段，等于预览不出被预览的东西）。

### 八、升级到 0.1.6 必须重启一次 DSH（实测确认）

这一条是升级路径的坑，写在最前面是因为它会让人误以为页面没做出来。

`dsh-client-modules` 的 `pkgMeta` 缓存键是 `${baseUrl}\0${loaderName}`（`sourceKey()`），
**不包含 package.json 的内容或修改时间**。v0.1.5 首次挂载时那个包里还没有 `dsh.client`
声明，注册表于是把 `null`（=「这不是客户端包」）缓存了下来。升级到 0.1.6 后，
包声明变了但缓存键没变，扫描继续命中那个 `null`。

实测确认：**停用再启用该插件不会恢复** —— `processOne` 确实重跑了
`resolveSource` → `resolveMeta`，但后者在缓存里直接拿到 `null` 就返回了。

```
$ curl -N http://127.0.0.1:63339/plugins/events
data: {"type":"graph","graph":{...,"entries":[..., {"id":"dsh-mem0",...}, ...]}}
                                          ^ 有 mem0，没有 dsh-ai-debate
```

同一份清单在**全新扫描**下是完全合格的：把注册表的 `resolveMeta` 逻辑对已安装的包重跑一遍，
能解析出 `{"id":"dsh-ai-debate","url":"plugins/??dsh-ai-debate/client.js&rev=...",
"inject":["@deepseek-ai/dsh-client-store","@deepseek-ai/dsh-client-locale"]}`，
`client/client.cjs` 也存在且非空。

**因此：从 0.1.5 升级到 0.1.6 之后，重启一次 DSH 桌面端。** 全新安装（profile 里从没有过
这个包）不受影响。这是 DSH 侧的缓存行为，不是本插件可以绕过的——除非改 Loader 行的包名，
而那会让 Host 半找不到。

### 九、仍未通过真实环境验证的部分
保持未通过标记，不写成通过：

- **配置页在真实 DSH 界面里的截图**：本机 Electron 未开放渲染进程 CDP
  （9230 端口是实验性 Inspector，`dsh://host`，不是页面），无法自动截取。
  已验证的是：路由真实返回 200 且内容正确、客户端 bundle 在模拟
  `__ModuleLoader__` 下注册出正确的槽位键并产出合法的 `hooks` / `controller`、
  DSH 真实安装后 `include:dsh-ai-debate` 为 `active`。
- **浏览器扫码 / OAuth 登录**：未实现。贴吧 WAP 没有公开的第三方登录授权接口，
  本轮如实提供 Cookie 凭据栏，并在页面说明为什么。
- **登录态真实发帖**：仍未执行。
## [0.1.5] — 2026-10-27

第六轮定向修复：**持久化幂等键不稳定** 与 **活跃会话被错误清理**。
本轮不新增平台、人格或功能。

验证方式：外部独立审计 `v014_independent_audit.test.mjs` 先在 v0.1.4 上**两项全红**，
修完后同一脚本**两项全绿**；内部测试从 213 项增至 **245 项**。

### P0：昵称变化产生第二个幂等身份

**外部脚本在 0.1.4 上的实测输出（修复前）**：

```
✖ stable numeric owner ID must produce the same dedupe key after display-name change
  AssertionError: Same user and trigger must retain one durable dedupe identity
  + actual:   'tieba:900000000000:主人旧昵称:n3:na'
  - expected: 'tieba:900000000000:主人新昵称:n3:na'
```

**根本原因**：`dedupeKey()` 把 `ownerKey` 当作身份的一部分，而 `ownerKey` 来自
`analyzeDispute()` 的 `resolveKey()` —— 后者**优先返回显示昵称**。贴吧的
`data-info.un` 常常只有昵称、没有数字 ID，于是幂等键里装的是一个**用户随时可改的字段**。
改名后旧键对应的 `confirmed` 记录匹配不上，同一条召唤重新获得发布资格。

**修复**：引入 canonical trigger ID。

- 新增 `TriggerIdentity` / `canonicalTriggerId()`，键 = `platform:threadId:triggerPostId[:eventId]`。
  三者都是平台分配的、不会变的坐标：一个帖子内 post id 唯一且不复用。
- `dedupeKey()` 保留 `ownerKey` 参数但**明确忽略**（文档写明原因），让所有调用点无需改动即可获得新行为，
  同时留下审计线索。`ownerKey` 仍在记录里，用于显示"这条记录当时属于谁"。
- **主人身份仍然校验**：能不能发表是**授权**问题，每次发表都会核对会话的主人与平台上的作者，
  与"这是哪一次召唤"是两个不同的问题。只有后者进了键。
- 新增 `findTriggerRecords()` / `mergeTriggerRecords()`，按**显式列**
  （`platform` / `threadId` / `triggerPostId`）匹配，而不是解析键字符串——
  昵称里可以有冒号，按 `split(':')` 数段数无法可靠区分新旧键。

### P0：旧版历史数据迁移

升级用户手里的 `state.json` 存着以昵称组成的旧键，直接换算法会让 `confirmed` 记录"消失"。

- `findTriggerRecords()` 对**每种写法的记录都生效**，不依赖键的形状，所以新旧记录能一起被找到。
- 匹配到多行时由 `mergeTriggerRecords()` 合并，规则是"**不允许比证据更乐观**"：
  - `confirmed` 一律优先，且**不可被非 confirmed 写入降级**；
  - 多条 `confirmed` 指向**不同** post id = 历史自相矛盾 → 标记 `conflicting`，
    会话进 `NEEDS_CONFIRMATION`，**不挑一条放行**；
  - `pending` 继续阻止重试；
  - 只有 `failed`（确定没发出去）才允许重新开始。
- 迁移时保留 `publishState` / `publishedPostId` / `firstSeenAt`，并把旧记录的 owner 记进
  `legacyOwnerKey` 供日后审计。旧键被替换成 canonical 键，不留两份（一份召唤两行正是歧义来源）。

### P1：活跃会话被 `maxSessions` 静默删除

**外部脚本在 0.1.4 上的实测输出（修复前）**：

```
✖ maxSessions must not prune an active nonterminal session
  AssertionError: The oldest active session must not disappear due to the maxSessions cache cap
  actual: undefined   expected: true
```

**根本原因**：`prune()` 先滤掉过期终态会话，再对**剩下的全部**执行 `.slice(-maxSessions)`。
剩下的里面还有 `READY` / `GENERATING` / `PUBLISHING` 等活跃会话。`maxSessions: 1` 时，
保存第二个 `READY` 会话就会把第一个删掉——用户正在审核的草稿凭空消失，
而它的流水账记录还在，于是这条召唤看起来"分析过但没候选"。

**修复**：

- `prune()` 先分三类：活跃 / 过期终态 / 未过期终态。**只有第三类**受 `maxSessions` 约束。
- 新增 `activeSessionCapacity()` 与 `DebateStore.capacity()`；
  活跃会话达上限时 `persistAnalysis()` 抛 `SessionCapacityError`，
  **明确拒绝新任务**，而不是牺牲已有任务。
- `StoreOptions.maxSessions` 的文档写清了它约束的是哪一类会话。

### 额外审查：发表后回读必须验证真实结果

`verifyPublished()` 之前只要 `getReplyContext()` 能解析成功就 `return true` ——
那只证明"这个 id 下面有东西"，不证明**审核过的正文、绑定账号、预期位置**。

现在逐项核对：① 主题帖 ② 正文（归一化后比较）③ 楼层/楼中楼类型 ④ 楼中楼父级楼层
⑤ 被回复对象 ⑥ 作者是否为绑定账号。

- 核对**失败** → `verification_mismatch`，去重记 **`pending`**（东西已经发出去了，
  记 `failed` 会引发自动重试，可能再发一条错的），会话转 `NEEDS_CONFIRMATION`。
- 平台**没给**字段 → 记为 `unconfirmed`，不谎称已验证，`verified: false` 但发表仍算成功。
- 回读**读不到** → 也算未完全验证，不当作失败。
- 回读强制 `forceFresh`，避免用发表前的缓存确认发表。

### 额外审查：登录身份检查去固定化

`checkAuthentication()` 之前把固定帖子 `6826726803` 写死在代码里。那个帖子一旦被删、
被限流或改版，**一个完全正常的登录会被判成未登录**，每次发表都拒绝并给误导性理由。

现在：

- 优先读取**本次要发表的帖子**，登录横幅在任何一个该 Cookie 能看的帖子页上都有。
- 可选 `authProbeThreadId` / `authProbeFallbacks` 仅作兜底，不再是必需项。
- 新增 `NO_MARKER_REASON`，把"这页没给标记"（应该换一页再试）与"这页说你没登录"（是答案）区分开。
- **区分「已登录」与「已确认账号身份」**：页面报 `is_login=1` 但没有 uid 时是
  `authenticated: true` + `userId: undefined`，发表路径按 `identity_unverified` 拒绝，
  不会以"Cookie 碰巧属于谁"的身份发言。

### 测试

- `test/trigger-identity.test.ts`（23 项）：改名不改身份、头像类资料变更、重复分析、
  10 个并发分析、不同帖子同一 postId、不同触发事件、旧版 `confirmed`/`pending` 迁移、
  新旧键共存、冲突历史、diff trigger 不串味、`failed` 可继续、
  🔑 改名后重新发布被拒、重启后仍拒；`maxSessions=1/2`、GENERATING+PUBLISHING 共存、
  `NEEDS_CONFIRMATION` 存活、终态过期清理、活跃满额报错、流水账不受清理影响、清理与发表并发。
- `test/verification-and-auth.test.ts`（9 项）：正文不一致、作者不符、回读失败、
  正文/作者/位置都对时的 verified、登录标记三态、无法确认身份时拒绝、登录探测不再固定帖子。
- `test/helpers.ts` 的假适配器现在**会把发出的回复真的记进帖子**，
  使回读验证可被真实模拟——之前的假适配器比平台还弱，导致验证逻辑无法被测到。

## [0.1.4] — 2026-10-27

第五轮定向修复。**不新增平台、人格或功能**，只处理一个已经确认的持久化漏洞，
以及三处在修复过程中暴露出来的相关问题。

验证方式：先跑外部独立脚本 `v013_dedupe_expiry_regression.test.mjs` 复现失败，
修完源码后再跑同一脚本确认通过；本轮全部 212 项内部测试通过。

### P0：历史发表记录被重新分析覆盖

**问题**：`src/runtime.ts` 的 `persistAnalysis()` 在找到已有的去重记录、
但对应 Session 已因 TTL 被清理时，会执行
`data.dedupe.filter(record => record.key !== key)` 删掉原记录，
再插入一条同 key 的空白记录。后果是历史 `confirmed` 与 `publishedPostId` 全部消失，
同一条召唤可以重新走一遍生成与授权发布，**存在重复发表同一召唤回复的真实风险**。

**外部脚本在 0.1.3 上的实测输出（修复前）**：

```
✖ 同一召唤重新分析不得覆盖已经 confirmed 的永久防重记录
  AssertionError [ERR_ASSERTION]: BUG: 重新分析将 confirmed 覆盖成 undefined
  + actual: undefined
  - expected: 'confirmed'
[exit code: 1]
```

**修复后的同一脚本**：

```
✔ 同一召唤重新分析不得覆盖已经 confirmed 的永久防重记录 (16.3601ms)
ℹ pass 1   ℹ fail 0
```

**修法**（不是在一个函数里加个 if，而是改整条生命周期）：

- **去重记录与临时会话彻底分开**。`dedupe` 现在是发布流水账：`confirmed` 与
  `pending` 永不被清理函数删除（`prune()` 原本已经这么写），
  现在再加一条：**任何写入都只能合并、不能替换**。
- **`upsertDedupe()` 从"替换"改为"合并"**（移到 `src/store.ts`，让分析和发布两条路径
  共用同一套规则）。省略某字段表示"这次没说"，不表示"清空"；
  `firstSeenAt` 是历史事实，永不改写；**`confirmed` 不会被后续非 confirmed 写入降级**。
- **会话没了，流水账说了算**。新增 `describeHistoricalPublish()`：
  `confirmed` → 新建的会话直接是 `PUBLISHED`（终态，无法生成也无法发表），
  并带着历史 `publishedPostIds`；`pending` → 会话是 `NEEDS_CONFIRMATION`。
  两者都不再进入可发布路径。
- **查账、判断、建会话、写流水账收进同一个 `mutate` 回调**。
  之前是在 `mutate` 外面 `findDedupe` 再在里面写，两个并发的 `runAnalysis()`
  会同时看到"没有记录"，各建一个会话。现在整段是同步的，无法交错。
- **顺带修掉会话 id 同秒碰撞**：`newSessionId()` 精确到秒，同一秒内两次分析会
  生成相同 id，导致 `getSession` 返回错的任务、把错误的候选带进发布路径。
  新增 `uniqueSessionId()` 加序号后缀。

### P1-1：`maxPerThread` 与冷却会随会话过期归零

**问题**：`publisher.ts` 用
`store.sessionsForThread(threadId).reduce((t, s) => t + s.publishedPostIds.length, 0)`
计算本帖已发表数量。会话被 TTL 清理后这个数会掉回 0，
于是 `maxPerThread` 形同虚设，冷却时间同样失效。

**修法**：改为从持久流水账统计。新增
`DebateStore.threadPublishActivity(threadId)` 返回 `confirmed` / `unresolved` /
`lastConfirmedAt`；去重记录新增 `decidedAt` 字段记录发布时间（`firstSeenAt` 不行，
它是首次分析时间，可能比发表早好几天）。`pending` 视为**占用名额但不算已发表**——
保守处理，宁可早拒一次也不重复发帖。

### P1-2：作者只剩昵称时仍可发表

**问题**：`src/target.ts` 里的 `hasStableAuthor()` 已定义但**从未被任何代码调用**。
当平台没暴露数字 user ID、只剩显示昵称时，发布路径照常放行。
昵称可以被改掉，也可以被别人占用，两次读到同一个名字**不能证明是同一个人**。

**修法**：在发布路径（无快照检查之后、重新读取目标之前）调用
`hasStableAuthor()`；只有昵称时 fail-closed 拒绝，`errorCode: author_unverifiable`。
读取和起草不受影响，仅拦下不可逆的那一步。

### 额外修复：Windows 上状态写入偶发 EPERM

在压力测试中出现约 1/25 的偶发失败：
`EPERM: operation not permitted, rename '...tmp' -> 'state.json'`。
根因是 Windows 上杀毒软件/索引服务会短暂持有目标文件；这不是逻辑缺陷，
但**在真实环境也会发生**，而脏状态会让发表被拒绝，用户会误以为是权限配置错误。
`persist()` 现在只对 `EPERM`/`EACCES`/`EBUSY` 做有限次退避重试（换新临时文件名），
真正的不可写目录仍然会失败。修复后连续 40 次全量测试零失败。

### 额外修复：平台报成功但没给回复 ID 时误判为已发表

适配器层已经会把这种情况归为不确定，但 publisher 不应依赖适配器。
现在 `outcome.status === 'confirmed'` 且缺少 `postId` 时，
publisher 自己判为 `uncertain` / `malformed_response`，去重记 `pending`，不自动重试。

### 测试

- 新增 `test/dedupe-ledger.test.ts`（8 项）：`confirmed`/`pending` + 会话过期 + 重分析、
  进程重启后重分析、同 key 并发分析、不同 key 独立、
  `failed` 可重试且保留 `firstSeenAt`、流水账合并而非替换、全流程两次发表只发一条。
- 新增 `test/identity-and-limits.test.ts`（6 项）：昵称作者被拒、有 ID 时正常发表、
  限额不随 TTL 归零、不同帖子限额独立、`pending` 占用名额。
- 全部断言落在**持久流水账内容**与**平台模拟调用次数**上，而不只是函数返回的消息——
  一个"返回拒绝但照样调了平台"的守卫不算守卫。

## [0.1.3] — 2026-10-27

第四轮定向修复。这一轮**不新增任何平台、人格或功能**，只让已有能力变得准确、可靠、经得起公开审计。
验证方式：用外部独立审计脚本 `v012_audit_repro.mjs` 跑 `lib/*.js`，逐项复现问题后修复，再跑同一脚本确认全部转绿。

### 七项审计复现与修复

外部脚本在 `0.1.2` 构建上的输出 → 在 `0.1.3` 构建上的输出：

| 审计项 | 0.1.2（修复前） | 0.1.3（修复后） |
| --- | --- | --- |
| `OLD_CANDIDATE` 旧版本候选 | `published`，真的发出 1 次 | `refused`，**发出 0 次** |
| `THROWN_TIMEOUT` 发出后抛异常 | `failed`，去重记 `failed` | `uncertain`，去重记 **`pending`** |
| `UNBOUND_AI_ACCOUNT` 未绑定发帖账号 | `published`，身份检查 **0 次** | `refused`，**发出 0 次** |
| `CAP_CONFIRMED` 正文截断 | 存 2000 字符，首句丢失 | 存 **2001**，首尾句都在 |
| `MISSING_POST_ID` 成功但无 post id | 判成 `confirmed` | `uncertain` + `malformed_response` |
| `CACHED_FLOOR` 楼层缓存 | 返回旧快照内容 | **返回新内容** |
| `NAME_AUTHOR_DRIFT` 作者改名 | `drift: null`（漏判） | **`author_mismatch`** |

### 修复内容

- **旧版本候选不能再发表。** 每次生成递增 `candidateVersion`；发布时若候选版本低于该会话最新版本，直接 `candidate_stale` 拒绝。
  `humanApproved` 不能绕过这条——"误批准了一份过期草稿"正是它要挡的情况。
- **发出后抛异常一律记为不确定。** 请求已进入平台、但结果不明时，去重记录落 `pending`、会话转 `NEEDS_CONFIRMATION`，
  **不自动重试**。之前记成 `failed` 会让下一次尝试认为"没发出去"，从而重复回帖。
- **未绑定 AI 发帖账号时拒绝发表。** 读取和起草不需要绑定；发表需要，否则无法知道会用哪个账号发言。
  身份校验一律 fail-closed：配置了 ID 但平台没暴露 ID → `identity_unverified`；ID 或名称不符 → `identity_mismatch`。
- **正文上限按字符数正确计算。** 截断后必须保留完整句子边界，不再在 2000 边界上吞掉首句。
- **`no=0` 但没有 `post id` 不算成功。** 判为 `uncertain` / `malformed_response`，提示人工确认，不重试。
- **同一会话的并发发布全部可取消。** 之前每个会话只记一个 `AbortController`，第二个发布注册时会**静默覆盖**第一个，
  `stop_session` 只能中止最后一个。改为按会话维护集合，取消时全部中止。
- **已终止的会话不再生成新候选。** `CANCELLED` / `PUBLISHED` 状态下调用生成会明确报错，
  避免为一个永远发不出去的会话白烧模型调用；`NEEDS_CONFIRMATION` / `REVIEWING` 仍然允许重新生成。
- **登录失效会暂停会话。** 登录墙和验证码不会自己好，重试只会每次都重新读帖、还会更像机器人。
  现在转入 `PAUSED` 并给出一次明确指示，而不是让用户看一串相同的失败。

### 真实环境发现并修复：按昵称配置的主人找不到自己的发言

这一项**不是**审计脚本报的，是在真实帖子（TID 6826726803）上跑端到端时撞出来的。

现象：主人「似水蓝蝶」在该帖确实发过言（1 条楼层 + 1 条楼中楼），但 `debate_analyze_thread`
报「无法确定要分析的回复位置：请提供回复 ID，或确认主人已在本帖发言」。

根因：贴吧 WAP 页的 `data-info.un` 里存的**经常是昵称而不是数字 ID**，所以楼层解析出的
`authorId` 就是 `"似水蓝蝶"`。而 `runtime.runAnalysis` 选触发回复时自己造了一套键：

```ts
const ownerKey = owner.userId ?? `name:${owner.userName ?? ''}`          // "name:似水蓝蝶"
timeline.find(e => (e.authorId ?? `name:${e.authorName ?? ''}`) === ownerKey)  // "似水蓝蝶"
```

两边永远不相等。分析器内部的 `resolveKey()` 本来是对的，但触发器选择**绕开了它**，于是两处
对同一个人的判法不一致。

修复：删除这套私有键逻辑，触发器选择改用分析器的 `buildHandleDirectory` + `resolveKey`，
并把「配置了 ID 就只比 ID」这条规则显式写进匹配函数——分析器拒绝把 ID 降级成昵称，触发器
选择也不能偷偷降级。

新增两条回归测试：`a nickname-configured owner still finds their trigger post`、
`a nickname-only handle on a floor is not treated as a numeric id`。

### 真实端到端结果（2026-10-27，TID 6826726803）

| 阶段 | 结果 |
| --- | --- |
| 读取 | 8 页读到 **219 楼**，平台声明 240，缺失 21 楼如实报告 |
| 楼中楼 | 读到 36 条，含 1 条主人发言 |
| 分析 | 认出主人「似水蓝蝶」，会话号 `s202610270016531tm2m85` |
| 生成 | **真实模型调用成功**，产出候选 `s202610270016531tm2m85-c1`，用量 758+1240/2000 tokens |
| 发表 | 未执行（会改动真实帖子，需主人明确授权） |

### 测试

198 项全部通过（node 内置 test runner）。新增回归测试覆盖上表每一行，包括
「十个并发发布只到达平台一次」「拒绝一个过期候选不会连坐整个会话」「取消在发送前落地则不发请求」。

### 已知限制（未变）

- 贴吧没有可用的公开艾特通知接口，`/c/u/feed/atme_pc` 需真实登录态且未经验证，v0.1.3 仍需手动提供帖子链接。
- `/p/comment` 与 `/p/totalComment` 在无登录态高频访问时可能返回 403；此时楼中楼不可读，结果会如实标注缺失数量。

## [0.1.2] — 2026-10-27

第三轮审计修复。**主题：没有明确目标、没有有效审核快照、没有可靠主人身份或没有可靠发帖账号身份时，任何情况下都不调用真实平台发布函数。**

这一轮审计直接拿 `0.1.1` 的编译产物 `lib/*.js` 复现问题，所以下面每一条都是**确认存在**的缺陷，不是推测。

### P0 修复

- **P0-1 目标快照从一开始就没有被创建。**
  `publisher.ts` 里写着 `if (session.targetSnapshot) { ... }`，但**没有任何代码给这个字段赋值** ——
  整个漂移检查是死代码，条件永远为假。复现方式：造一个没有快照、目标内容/作者已变的候选，
  发布仍然成功。
  修复：
  - 新增 `StoredCandidate.targetSnapshot`，快照**跟随候选**而不是只挂在会话上，避免旧候选借新快照过关；
  - 生成阶段先 `resolveTarget()` 读取并验证目标，再把快照一并存进候选；
  - 新增 `candidateVersion`（每次生成递增）与 `textHash`（正文哈希）；
  - 发布时**没有快照直接拒绝**（`target_no_snapshot`），不再是"跳过校验"；
  - 比对同时覆盖作者与正文；**记录过的作者 ID 在重读时消失也判为无法确认**（`author_unverifiable`）；
  - 新增 `target_unverifiable` 路径的专门测试。
- **P0-2 非法状态文件仍会被初始化为空。**
  `{"version":1,"sessions":null,"dedupe":null}` 会加载成 `{sessions:[],dedupe:[]}`，去重信息全丢。
  修复：新增 `validateStore()` 做**完整结构校验** —— 版本必须是 1、`sessions`/`dedupe` 必须是数组、
  每条会话必须带关键字符串字段、每条去重记录必须有 `key` 且 `publishState` 必须是已知值。
  任何不合法都**备份原文件并抛 `StoreError`**，不再有"补一个空数组继续跑"的路径。
  未来版本号明确拒绝加载（不做无提示降级），并且加载失败时发布路径完全不可用。
- **P0-3 配置了稳定 ID 仍会降级成昵称匹配。**
  复现：配置 ID `99999` + 昵称 `Alice`，帖子用户是 ID `12345` 的 `Alice` —— 旧代码先试 ID 失败，
  再用昵称命中，于是把冒名者的发言当成主人的。
  修复：`resolveOwnerKey()` 现在**只要配置了数字 ID 就绝不降级** ——
  帖子里有 ID 但不匹配 → 直接拒绝；帖子里完全没有 ID → 判为无法确认并提示人工处理。
  `isOwnersPost()` 同步收紧：昵称相同**不能**覆盖 ID 冲突。
- **P0-4 账号名称校验可被绕过。**
  旧条件 `configuredAiName && auth.userName && mismatch` 在平台**没返回 userName** 时整体为假，
  于是直接放行。修复：改为 fail-closed ——
  配了 ID 就必须核实 ID；配了名称就必须拿到名称，拿不到就拒绝（`identity_unverified`）；
  同时配置时 ID 与名称**任一冲突都拒绝**。
- **P0-5 争论对象变化时只提醒、继续生成。**
  修复：新增 `detectOpponentDrift()`，对手变化（含"变成没有对手"）立即进入 `NEEDS_CONFIRMATION`、
  **抛出错误停止生成**，并把已有候选的 `approved` 全部置为 false。

### P1 修复

- **P1-1 过期会话清理会连带清空去重记录。**
  旧 `prune()` 用 `liveIds.has(record.sessionId)` 过滤 dedupe，会话一过期，已发表的去重记录一起被删，
  同一个召唤可以再发一次。
  修复：去重记录**与短期会话缓存彻底分离** —— `confirmed` 与 `pending` 永不过期，
  只有 `failed`（未发出请求）随 TTL 老化；上限 2000 条，可配 `maxDedupeRows`。
- **P1-2 停止任务没有考虑并发发布。**
  修复：`stopSession()` 走状态机（`PUBLISHED` 拒绝取消，避免抹掉"已发出"这个事实），
  新增 `registerInFlight` / `cancelInFlight` 管理 AbortController，
  publisher 在**网络调用前**再查一次 `isCancelled`。
  取消只拦未发出的请求；已发出的会如实保留。
- **P1-3 旧候选在重新生成后仍可用旧授权发表。**
  修复：每个候选带 `candidateVersion` + `textHash`，发布时校验正文与自身哈希一致（`candidate_tampered`）；
  同一召唤事件仍然只能成功发表一次（去重键 + 状态机）。
- **P1-4 楼中楼目标定位会遍历所有楼层。**
  修复：`getReplyContext()` 增加两级收窄 —— 楼层快路径（一次分页walk，不读楼中楼）、
  悬停缓存与"帖子页内联副本"提示；新增 `structureCache`（默认 5 分钟，可配 `structureCacheMs`）。
  缓存**只记位置不记正文**，命中后仍重读目标，准确率不受影响。

### 校正发布质量

- **测试数量自动统计**：新增 `scripts/test-count.mjs`，逐个文件实际运行并读测试框架自己的计数。
  之前 README 写 164、交付说 166，两边都是手写的。现在 **196 项，文档由脚本产出**。
- 版本 `0.1.2`，`engines.dsh` 取自真实 `runtime.json`（`>=0.2.1-0`）。
- 安装包内容、凭据扫描、干净目录安装均重新校验。

### 尚未通过真实平台验证（保持原样，不写成已通过）

- 登录态下真实发帖。
- 发表后回读一致性。
- 艾特通知自动读取（未实现，能力声明 `false`）。
- 完整楼中楼读取（非降级）——受 `/p/*` 限流影响。
- 真实账号身份校验（逻辑与测试齐全，真实 Cookie 下未核对）。
- 目标快照在"真实帖子被编辑/删除"场景下的端到端表现。

## [0.1.1] — 2026-10-27

质量修复版本。**主题：同一条授权回复，无论并发、写盘失败、网络超时还是重启，都不会因为软件自身的竞态和状态错误而重复发帖。**

### 修复（P0，可导致重复发帖或错误回复位置）

- **状态写入失败不再被吞掉**（`src/store.ts`）。原来的写队列是
  `this.writeChain.then(...).catch(() => undefined)`，写盘失败对上层的表现和成功一模一样。
  现在每次写入把自己的结果返回给调用者，失败抛出 `StoreError`；内存与磁盘不一致时
  `hasUnsavedChanges` 为真，**发表流程会因此直接拒绝发送**——没有落盘的去重记录不算数。
  写队列在一次失败后仍可继续使用，不会被永久毒化。
- **状态文件损坏不再静默重置**。解析失败抛 `StoreError('corrupt')` 并把损坏的原始字节
  备份成 `state.json.corrupt-<时间戳>`，避免"清空后重发"。
- **状态文件权限收紧**：目录 `0700`、文件 `0600`（Linux/macOS 生效）。
- **并发重复发表**（`src/publisher.ts`）。原来"检查去重记录"和"写入 pending"是两次 await，
  10 个并发调用会全部读到"还没发过"从而全部发送。现在按去重键做进程内原子占用，
  实测 `Promise.all` × 10 只有 1 次真正调用平台，其余 9 次被明确拒绝并说明原因。
- **楼中楼回复位置**（新增 `src/target.ts`）。发布层原来只构造
  `{floorPostId, replyToUserId}`，而贴吧适配器只有在存在 `nestedReplyId` 时才走楼中楼分支——
  结果是"发给楼中楼某人"变成"新开一层"。现在目标由适配器**重新读取**并校验：
  目标存在、父楼层一致、楼中楼 id 一致、作者与分析结果一致、类型一致、仍属原帖。
  任一不满足即暂停（`NEEDS_CONFIRMATION`），并记录`targetKind` 与 `TargetSnapshot`。
- **模型不能决定回复位置**。`validateDraft` 原来在"无预期对手"时接受任意非空目标 id。
  现在未确认对手直接判违规、目标 id 必须等于对手已验证发言，且存储的候选目标来自
  采集数据而非模型输出；审核到发表之间目标若被编辑/删除/移动，凭内容哈希与快照比对后拒绝发表。
- **身份校验**。触发回复必须确由已绑定主人发表（否则拒绝，不创建会话）；
  发布前核对当前 Cookie 登录账号与配置的 `aiAccountUserId` 一致，
  拿不到用户 ID 时按"无法确认"拒绝，**不把"能读帖子"当作"账号正确"**。

### 修复（P1）

- **`enabled=false` 真正生效**：关闭状态下读取、生成、发表一律被拒绝并说明原因。
- **配置热更新**：`tiebaCookie` / 超时 / 重试 / 翻页等请求参数变化时重建适配器，
  不再出现"设置显示新值、请求还在用旧 Cookie"。
- **分页完整性细化**（`src/collector.ts`）：区分 `last_page` / `page_cap` / `error` /
  `exhausted` / `degraded`。到达分页上限而平台仍有下一页时返回 `truncated: true` 且
  `complete: false`，并明确写出"不是完整结果"。楼中楼未完整读取时 `nestedIncomplete: true`。
- **状态机真正被使用**。`assertTransition` 此前从未被调用，各模块直接赋值 `state`。
  现在新增 `transition()` 并对所有迁移做检查：`PUBLISHED` 不能再发表、`CANCELLED`
  不能复活、`PUBLISHING` 不能退回待发、`PAUSED` 不能跳过授权、`NEEDS_CONFIRMATION`
  不能直接发表；每种禁止迁移都有测试。
- **绑定与人格工具改为诚实的预览**（方案 B）。这两个工具无法安全写入 DSH 设置，
  因此现在明确返回 `persisted: false`、列出应写入的配置项与路径，并提示
  "本次不生效"。不再让用户以为绑定成功、实际下次仍用旧值。
- **模型上下文预算**：原来只统计压缩后的帖子文本，`736/2000` 掩盖了系统提示、
  人格、脚手架和回复预留的开销。现在按总预算拆分，固定开销单列；
  `temperature`（新增 `llmTemperature`，默认 0.4）与 `llmMaxOutputTokens` 可配置。

### 测试

- **164 项**，`persona-compressor` 17 / `pipeline` 24 / `publisher-safety` 34 /
  `parse` 21 / `generator` 21 / `collector` 13 / `analyzer` 12 / `json-safety` 11 /
  `target` 11。新增文件 `test/target.test.ts`。
- 测试清单改为**通配**（`test/**/*.test.ts`），此前手写清单漏掉了新文件——
  这正是"全绿但覆盖变少"的来源。
- 新增回归测试直接覆盖本次缺陷：10 并发只发 1 次、写盘失败拒绝发送、
  损坏状态文件显式报错、模型伪造目标 id 被拒、错误触发作者被拒、
  账号不匹配被拒、分页上限标为不完整、八类非法状态迁移被拒。

### 已知限制（未变化，仍需真实账号验证）

- **登录态下真实发帖仍未验证**（开发环境无可用贴吧账号）。未登录路径已能在真实平台
  正确拒绝并给出平台原文。
- **艾特通知自动读取未实现**：贴吧无可用公开接口，能力声明为 `false`。
- **`/p/comment`、`/p/totalComment` 会被路径级限流**：触发后熔断并降级为帖子页内联副本，
  结果明确标注不完整。
- 仅支持单进程；跨进程的并发去重不在保证范围内。

## [0.1.0] — 2026-10-26

首个可用版本，完整支持百度贴吧。

### 新增

- **平台适配器架构**：`PlatformAdapter` 统一接口（`getThread` / `getReplies` / `getNestedReplies` / `getUserProfile` / `getMentions` / `getReplyContext` / `publishReply` / `getCapabilities` / `checkAuthentication`），贴吧是第一个实现，其余平台按同一接口扩展。
- **贴吧读取**：主题帖、楼层分页（读到最后一页、按 postId 去重、如实报告缺失楼层）、楼中楼（含「回复 X」关系的正确解析）。
- **楼中楼限流降级**：`/p/comment` 与 `/p/totalComment` 被贴吧做**路径级频控**（实测连续读取后整族 403，冷却不恢复）时自动熔断该通道，改用帖子页内联的楼中楼副本，并在结果里明确报告「声明 N 条 / 读到 M 条」的不完整情况，绝不把降级结果当成完整数据。
- **争论还原**：按交互证据（谁回复过谁、往来几次）锁定争论对象，而不是「谁最后发言」；识别主人的主张与限定条件；列出对方尚未被回应的问题。
- **上下文压缩**：按优先级花预算（召唤 → 对手最新 → 争论链 → 主人主张 → 帖子背景 → 其他参与者），被省略的内容明确告知模型。
- **四种人格**：贴吧老哥 / 小受 / 傲娇 / 高冷，配六个表达参数；人格只改语气，不改事实与回复对象。
- **回复生成与校验**：结构化 JSON 输出、Schema 校验、解析失败有限重试；程序硬检查回复对象、长度、凭据与提示词泄露、重复发送。
- **人工审核发表**：`confirm: true` + 正文必须与候选一致；发表前去重、检查策略与频率；发表后回读确认。
- **会话与去重**：状态机 `DETECTED → … → PUBLISHED`；去重记录在发请求前落盘，重启后不会重复回帖；超时记 `uncertain` 且禁止自动重试。
- **安全控制**：验证码 / 403 / 429 / 登录失效自动暂停；状态文件原子写入（temp + rename）；凭据不落盘、不进日志。
- **九个工具**：`debate_bind_owner`、`debate_set_personality`、`debate_analyze_thread`、`debate_analyze_reply`、`debate_generate_reply`、`debate_publish_reply`、`debate_get_session`、`debate_stop_session`、`debate_health_check`。
- **132 项自动化测试**，其中分页、解析、楼中楼关系使用真实抓取的页面作为 fixture。
- **真实端到端验证记录**：真实帖子（TID 6826726803，240 楼声明 / 219 楼可读）跑通「读取 → 分析 → 生成」全链路；四种人格各生成一版，风格分明而事实与回复对象一致；上下文实际占用 736/2000 tokens；未登录状态下发表被正确拒绝。

### 已知限制

- 贴吧 HTML 不暴露数字用户 ID（只有 username + portrait），数字 ID 仅来自 `totalComment` 接口。
- `totalComment` 与 `/p/comment` 会被路径级限流，此时楼中楼降级为帖子页内联副本，**数量会少于平台声明**，结果中会明确标注。
- 艾特通知读取不可用：`/c/u/feed/atme_pc` 需要真实登录态且未经验证，能力声明为 `false`。
- 用户资料 `/home/main` 对未登录请求只返回 SPA 空壳，能力声明为 `false`。
- 登录态下的真实发表**未在真实账号验证**（开发环境无可用账号）。
- 仅支持单进程；状态为本地 JSON 文件。

### 未实现（计划中）

- 艾特自动召唤（需要经验证的通道）
- 微博 / 知乎 / 小红书 / 抖音适配器
- 长对话的增量记忆压缩（当前每次生成重新采集）
