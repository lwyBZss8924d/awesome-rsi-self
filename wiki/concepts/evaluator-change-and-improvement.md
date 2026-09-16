---
type: Concept
title: 评分变化与代理改进分别归因
description: 以留出轨迹、裁判独立性和单列评判预算，区分观测分数与可支持的改进范围。
tags:
  - rsi
  - evaluation
  - attribution
status: draft
rsi_local_adoption: proposed
rsi_empirical_gain: not_measured
generated:
  by: codex/gpt-6
  at: 2026-09-16T09:56:34Z
sources:
  - id: arxiv-2607.13104-v1
    resource: https://arxiv.org/abs/2607.13104v1
    title: "Self-Improvements in Modern Agentic Systems: A Survey"
    version: v1
rsi_contribution: r6-evaluator-change-and-improvement-20260916
rsi_evidence:
  - source_id: arxiv-2607.13104-v1
    version: v1
    prepared_manifest_sha256: 3143cea42e1efde4081411e7dd648e46f588981dd58447774f1828812232f9c5
    sha256: 1fdd8022b47f49c121c2525ac805587787a76cf2193a98e3aec715bd14d9aeb7
    locator:
      start_line: 23
      end_line: 31
    preparation_key: c6ccf46cdcb15722c5d0bad41be0ca0a29d070b96b1d4c43d47f43651fff0754
    artifact: sections/009-8-evaluation.llms.txt
  - source_id: arxiv-2607.13104-v1
    version: v1
    prepared_manifest_sha256: 3143cea42e1efde4081411e7dd648e46f588981dd58447774f1828812232f9c5
    sha256: 1fdd8022b47f49c121c2525ac805587787a76cf2193a98e3aec715bd14d9aeb7
    locator:
      start_line: 39
      end_line: 39
    preparation_key: c6ccf46cdcb15722c5d0bad41be0ca0a29d070b96b1d4c43d47f43651fff0754
    artifact: sections/009-8-evaluation.llms.txt
  - source_id: arxiv-2607.13104-v1
    version: v1
    prepared_manifest_sha256: 3143cea42e1efde4081411e7dd648e46f588981dd58447774f1828812232f9c5
    sha256: 1fdd8022b47f49c121c2525ac805587787a76cf2193a98e3aec715bd14d9aeb7
    locator:
      start_line: 43
      end_line: 43
    preparation_key: c6ccf46cdcb15722c5d0bad41be0ca0a29d070b96b1d4c43d47f43651fff0754
    artifact: sections/009-8-evaluation.llms.txt
  - source_id: arxiv-2607.13104-v1
    version: v1
    prepared_manifest_sha256: 3143cea42e1efde4081411e7dd648e46f588981dd58447774f1828812232f9c5
    sha256: c748f8438452767856b1e966035549686551fb64be13b958a50a0fae02af139c
    locator:
      start_line: 59
      end_line: 62
    preparation_key: c6ccf46cdcb15722c5d0bad41be0ca0a29d070b96b1d4c43d47f43651fff0754
    artifact: tex-files/tex/evaluation.tex
---

# 评分变化与代理改进分别归因

[证据分层](evidence-layers.md)已区分结构正确与主张受支持；[程序图候选实验](procedural-graphs-as-local-hypothesis.md)已有独立验证和留出任务。本页补充评价器配置与评判成本的归因问题。

1. 综述 §8.1.1 建议在固定预算下报告完整迭代轨迹、多随机种子的期望表现与方差，并记录起始基线、未参与优化的留出任务表现和已解决任务的回归。因此，最终峰值是应保留的观察，但不能单独支撑能力提升的结论。[^arxiv-2607.13104-v1]

2. §8.1.2 要求披露裁判模型版本、提示、量规和可见环境证据，并将评判预算与代理执行预算分别报告。更多评判资源可能改变评价可靠性；若省略这部分成本，就难以区分代理改进与评价器检查得更充分。[^arxiv-2607.13104-v1]

3. 同一裁判同时驱动更新和报告结果，容易使代理适应裁判偏好。综述建议终评使用不同的裁判配置，例如更强模型或正交量规，并用重复评判的方差、多裁判聚合、可验证子集校准或定向人工复核补充可靠性证据。[^arxiv-2607.13104-v1]

本地解释：RSI 记录可分别保存“本轮得分及评价配置”和“给定预算、留出任务及独立终评下支持的改进范围”。若裁判或评判预算也发生变化，先保留为归因未决；这是据上述建议提出的记录方式，尚未实测。

这些段落提供评价方法建议，并不证明更换裁判即可消除偏差，也不提供本项目的提升证据。本次核读限于评价章节及所需 TeX 上下文；两种格式中的所引裁判段落文字相符，不代表整篇跨格式等价、全文阅读或独立实证复现。

[^arxiv-2607.13104-v1]: [Self-Improvements in Modern Agentic Systems: A Survey v1](https://arxiv.org/abs/2607.13104v1)，§8.1.1（S8.SS1.SSS1；section-9 第23–31行），§8.1.2 的 Specify the judge and the judging budget（S8.SS1.SSS2.Px1；第39行）及 Prevent over-optimization to the judge and report reliability signals（S8.SS1.SSS2.Px2；第43行）；对应 TeX 为 tex/evaluation.tex 第59–62行，所属标签 sec:Judge_based_measurement。
