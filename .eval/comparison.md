# 版本对比

基线模型：scripted-corpus-reply（脚本模型）
新版本模型：scripted-corpus-reply（脚本模型）

| 维度 | 类型 | 基线 | 新版本 | 变化 |
| --- | --- | --- | --- | --- |
| argument_recognition | 确定性 | 0.95 | 0.95 | 无变化 |
| context_use | 代理 | 0.15 | 0.15 | 无变化 |
| factual_credibility | 确定性 | 0.99 | 0.99 | 无变化 |
| naturalness | 代理 | 0.97 | 0.97 | 无变化 |
| non_repetition | 确定性 | 1.00 | 1.00 | 无变化 |
| persona_style | 代理 | 0.43 | 0.43 | 无变化 |
| stance_consistency | 确定性 | 1.00 | 1.00 | 无变化 |
| substantive_rebuttal | 代理 | 0.12 | 0.12 | 无变化 |
| target_accuracy | 确定性 | 0.97 | 0.97 | 无变化 |
| uncertainty_handling | 确定性 | 1.00 | 1.00 | 无变化 |

## 硬性失败（5）
- baseline/03 / argument_recognition：论证结构里一条都没找到（对方论据/未答问题/矛盾）
- context/01 / argument_recognition：论证结构里一条都没找到（对方论据/未答问题/矛盾）
- refusal/04 / argument_recognition：论证结构里一条都没找到（对方论据/未答问题/矛盾）
- weibo/06 / factual_credibility：回复里出现了上下文没有的数字：44%
- quality/long-01 / argument_recognition：论证结构里一条都没找到（对方论据/未答问题/矛盾）

逐条对比：没有任何一条案例的评分发生变化。

Token：0 输入 / 0 输出 → 0 输入 / 0 输出
耗时：20 ms → 18 ms