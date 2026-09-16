---
type: Concept
title: 先比较单代理基线，再选择有界编排
description: 把任务可分解性、协调开销和模型外推风险作为选型输入。
status: draft
tags:
  - mas
  - baseline
  - cost
  - external-validity
rsi_local_adoption: proposed
rsi_empirical_gain: not_measured
generated:
  by: codex/gpt-6-astra
  at: 2026-09-16T07:30:18.269807Z
sources:
  - id: arxiv-2512.08296-v3
    resource: https://arxiv.org/abs/2512.08296v3
    title: Towards a Science of Scaling Agent Systems
    version: v3
rsi_contribution: r6-bootstrap-learning-20260916
rsi_evidence:
  - source_id: arxiv-2512.08296-v3
    version: v3
    prepared_manifest_sha256: 8bfe470bb396448d584cf56130c1a0d4af224ce0d14f39c73213f8bf226fb1cf
    sha256: e36272cb28817cc8b6f93edddbab3d5b101925400d0dcf0b3a50334a289f9c65
    locator:
      start_line: 179
      end_line: 197
    preparation_key: 8f01beaed5f9e68ed0cd7a17b8710af7e1f386f1ee432be00d7701e3ce663c94
    artifact: paper.llms.txt
  - source_id: arxiv-2512.08296-v3
    version: v3
    prepared_manifest_sha256: 8bfe470bb396448d584cf56130c1a0d4af224ce0d14f39c73213f8bf226fb1cf
    sha256: e36272cb28817cc8b6f93edddbab3d5b101925400d0dcf0b3a50334a289f9c65
    locator:
      start_line: 244
      end_line: 254
    preparation_key: 8f01beaed5f9e68ed0cd7a17b8710af7e1f386f1ee432be00d7701e3ce663c94
    artifact: paper.llms.txt
  - source_id: arxiv-2512.08296-v3
    version: v3
    prepared_manifest_sha256: 8bfe470bb396448d584cf56130c1a0d4af224ce0d14f39c73213f8bf226fb1cf
    sha256: e36272cb28817cc8b6f93edddbab3d5b101925400d0dcf0b3a50334a289f9c65
    locator:
      start_line: 574
      end_line: 584
    preparation_key: 8f01beaed5f9e68ed0cd7a17b8710af7e1f386f1ee432be00d7701e3ce663c94
    artifact: paper.llms.txt
  - source_id: arxiv-2512.08296-v3
    version: v3
    prepared_manifest_sha256: 8bfe470bb396448d584cf56130c1a0d4af224ce0d14f39c73213f8bf226fb1cf
    sha256: e36272cb28817cc8b6f93edddbab3d5b101925400d0dcf0b3a50334a289f9c65
    locator:
      start_line: 824
      end_line: 836
    preparation_key: 8f01beaed5f9e68ed0cd7a17b8710af7e1f386f1ee432be00d7701e3ce663c94
    artifact: paper.llms.txt
---

# 先比较单代理基线，再选择有界编排

## 来源观察

Scaling v3 比较六个基准、五种拓扑，结果依任务结构而变。其附录 B 中，公式给三个未见模型都选 Hybrid，实测最优却为 Centralized 或 Decentralized；软件与终端实验仅用每配置 20 个实例。[^arxiv-2512.08296-v3]

## 本地候选准则

保留单代理基线；只有独立子任务、并行读取或必要复核能抵偿交接成本时才拆分。需要 MAS 时采用 native-first 是当前执行偏好，并非本文证明的 Astra 最优策略。固定任务、模型、effort 与验收，比较成功率、总耗时、总 token 和返工。

## 限制

本研究未测试本机 Codex 原生编排；不把其阈值或留出选择率硬编码成本地规则。工具繁多、顺序依赖强时，先检查状态传递与协调成本。

[^arxiv-2512.08296-v3]: [Towards a Science of Scaling Agent Systems v3](https://arxiv.org/abs/2512.08296v3), §4.1、§4.2、§5、附录 B。具体工件摘要与行号见本页 rsi_evidence。
