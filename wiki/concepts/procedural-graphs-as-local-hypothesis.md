---
type: Concept
title: 程序图的演化先作为可检验假设
description: 从冻结运行版本、拒绝记忆和独立验证学习，而不把论文曲线当成本地收益。
status: draft
tags:
  - procedural-graphs
  - evaluation
  - rejection-memory
  - design-hypothesis
rsi_local_adoption: proposed
rsi_empirical_gain: not_measured
generated:
  by: codex/gpt-6-astra
  at: 2026-09-16T07:30:18.269807Z
sources:
  - id: arxiv-2609.09153-v1
    resource: https://arxiv.org/abs/2609.09153v1
    title: "Procedural Graphs: Self-Evolving Execution Structures for LLM Agents"
    version: v1
rsi_contribution: r6-bootstrap-learning-20260916
rsi_evidence:
  - source_id: arxiv-2609.09153-v1
    version: v1
    prepared_manifest_sha256: 13fe2a7b66ada2a7c5b8932626778848160b1e54dc6c14b00c2cdcbad39f4fce
    sha256: d0c6b644c84fcc68f94cd4a37d7c4e89252c25afe04e30dd636be6cc1e598818
    locator:
      start_line: 40
      end_line: 106
    preparation_key: 4083147a677649ba45902c11b3d1121341a56a0d4b441c59864455c55e2d9c6a
    artifact: paper.llms.txt
  - source_id: arxiv-2609.09153-v1
    version: v1
    prepared_manifest_sha256: 13fe2a7b66ada2a7c5b8932626778848160b1e54dc6c14b00c2cdcbad39f4fce
    sha256: d0c6b644c84fcc68f94cd4a37d7c4e89252c25afe04e30dd636be6cc1e598818
    locator:
      start_line: 120
      end_line: 126
    preparation_key: 4083147a677649ba45902c11b3d1121341a56a0d4b441c59864455c55e2d9c6a
    artifact: paper.llms.txt
  - source_id: arxiv-2609.09153-v1
    version: v1
    prepared_manifest_sha256: 13fe2a7b66ada2a7c5b8932626778848160b1e54dc6c14b00c2cdcbad39f4fce
    sha256: d0c6b644c84fcc68f94cd4a37d7c4e89252c25afe04e30dd636be6cc1e598818
    locator:
      start_line: 528
      end_line: 536
    preparation_key: 4083147a677649ba45902c11b3d1121341a56a0d4b441c59864455c55e2d9c6a
    artifact: paper.llms.txt
  - source_id: arxiv-2609.09153-v1
    version: v1
    prepared_manifest_sha256: 13fe2a7b66ada2a7c5b8932626778848160b1e54dc6c14b00c2cdcbad39f4fce
    sha256: d0c6b644c84fcc68f94cd4a37d7c4e89252c25afe04e30dd636be6cc1e598818
    locator:
      start_line: 853
      end_line: 863
    preparation_key: 4083147a677649ba45902c11b3d1121341a56a0d4b441c59864455c55e2d9c6a
    artifact: paper.llms.txt
  - source_id: arxiv-2609.09153-v1
    version: v1
    prepared_manifest_sha256: 13fe2a7b66ada2a7c5b8932626778848160b1e54dc6c14b00c2cdcbad39f4fce
    sha256: d0c6b644c84fcc68f94cd4a37d7c4e89252c25afe04e30dd636be6cc1e598818
    locator:
      start_line: 1698
      end_line: 1708
    preparation_key: 4083147a677649ba45902c11b3d1121341a56a0d4b441c59864455c55e2d9c6a
    artifact: paper.llms.txt
  - source_id: arxiv-2609.09153-v1
    version: v1
    prepared_manifest_sha256: 13fe2a7b66ada2a7c5b8932626778848160b1e54dc6c14b00c2cdcbad39f4fce
    sha256: d0c6b644c84fcc68f94cd4a37d7c4e89252c25afe04e30dd636be6cc1e598818
    locator:
      start_line: 1728
      end_line: 1732
    preparation_key: 4083147a677649ba45902c11b3d1121341a56a0d4b441c59864455c55e2d9c6a
    artifact: paper.llms.txt
---

# 程序图的演化先作为可检验假设

## 来源观察

Procedural Graphs 将在线固定的图与离线演化分开；边包含条件、指引和陷阱。候选通过结构检查与独立验证后才保留，拒绝记录供下一轮使用。其 20-episode 演化接受决策是搜索轨迹，作者明确不把每次接受当显著性检验。[^arxiv-2609.09153-v1]

## 本地候选实验

仅对重复、可复现的失败提小幅图变更；固定运行版本，保留原图与失败证据。候选与基线使用同一任务分布，并留出未参与改图的验收任务。采用与否由本机结果决定。

## 限制

论文未测试 Astra；较少 solver steps 或工具调用不必然减少 token。其通用结构检查也未独立验证节点属于工具目录。本地需要按实际接口核对可执行性，不能仅凭 DAG 合法或验证分数持平宣布能力提升。

[^arxiv-2609.09153-v1]: [Procedural Graphs: Self-Evolving Execution Structures for LLM Agents v1](https://arxiv.org/abs/2609.09153v1), §3、§4、§5.4、附录 B.6、E.1、E.4.1。具体工件摘要与行号见本页 rsi_evidence。
