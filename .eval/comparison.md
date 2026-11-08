# 版本对比

基线模型：scripted-corpus-reply（脚本模型）
新版本模型：scripted-corpus-reply（脚本模型）

| 维度 | 类型 | 基线 | 新版本 | 变化 |
| --- | --- | --- | --- | --- |
| argument_recognition | 确定性 | 0.41 | 0.42 | +1.7% |
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

## 逐条变化
- baseline/01：改善：argument_recognition
- baseline/02：改善：argument_recognition
- identity/04：改善：argument_recognition
- quality/shift-01：改善：argument_recognition

Token：0 输入 / 0 输出 → 0 输入 / 0 输出
耗时：7 ms → 6 ms