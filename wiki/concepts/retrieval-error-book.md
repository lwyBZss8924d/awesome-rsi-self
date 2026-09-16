---
type: Concept
title: 用错误簿维护可导航知识
description: 对复现的结构和内容错误分别定位、修复、复查并记录适用条件。
status: draft
tags:
  - retrieval
  - error-book
  - maintenance
  - bounded-repair
rsi_local_adoption: proposed
rsi_empirical_gain: not_measured
generated:
  by: codex/gpt-6-astra
  at: 2026-09-16T07:30:18.269807Z
sources:
  - id: arxiv-2605.25480-v2
    resource: https://arxiv.org/abs/2605.25480v2
    title: "Retrieval as Reasoning: Self-Evolving Agent-Native Retrieval via LLM-Wiki"
    version: v2
rsi_contribution: r6-bootstrap-learning-20260916
rsi_evidence:
  - source_id: arxiv-2605.25480-v2
    version: v2
    prepared_manifest_sha256: 136418bc798d3bb42ef6f4db3e4beb8b9570ef9cb1d7afe522e340afa15bf103
    sha256: 2643b16fde8b04ac1fee5f857911e0ee3089a4af10f0fe8d2507fe8a1cd250c3
    locator:
      start_line: 65
      end_line: 116
    preparation_key: f93c9c110a4908c5480c307ce0f18eb79a93874be6f0ab2feaa031ccf427d83e
    artifact: paper.llms.txt
  - source_id: arxiv-2605.25480-v2
    version: v2
    prepared_manifest_sha256: 136418bc798d3bb42ef6f4db3e4beb8b9570ef9cb1d7afe522e340afa15bf103
    sha256: 2643b16fde8b04ac1fee5f857911e0ee3089a4af10f0fe8d2507fe8a1cd250c3
    locator:
      start_line: 120
      end_line: 124
    preparation_key: f93c9c110a4908c5480c307ce0f18eb79a93874be6f0ab2feaa031ccf427d83e
    artifact: paper.llms.txt
  - source_id: arxiv-2605.25480-v2
    version: v2
    prepared_manifest_sha256: 136418bc798d3bb42ef6f4db3e4beb8b9570ef9cb1d7afe522e340afa15bf103
    sha256: 2643b16fde8b04ac1fee5f857911e0ee3089a4af10f0fe8d2507fe8a1cd250c3
    locator:
      start_line: 142
      end_line: 148
    preparation_key: f93c9c110a4908c5480c307ce0f18eb79a93874be6f0ab2feaa031ccf427d83e
    artifact: paper.llms.txt
  - source_id: arxiv-2605.25480-v2
    version: v2
    prepared_manifest_sha256: 136418bc798d3bb42ef6f4db3e4beb8b9570ef9cb1d7afe522e340afa15bf103
    sha256: 2643b16fde8b04ac1fee5f857911e0ee3089a4af10f0fe8d2507fe8a1cd250c3
    locator:
      start_line: 309
      end_line: 311
    preparation_key: f93c9c110a4908c5480c307ce0f18eb79a93874be6f0ab2feaa031ccf427d83e
    artifact: paper.llms.txt
---

# 用错误簿维护可导航知识

## 来源观察

LLM-Wiki 的 Error Book 将编译错误归因后形成约束，再复查关闭；确定性代码修结构，来源核验处理无依据事实与跨页矛盾。它用搜索、读取与链接遍历，并按预算或空结果耐心阈值停止。[^arxiv-2605.25480-v2]

## 本地候选流程

保存失败查询、输入版本、错误位置、来源证据、修复与复查结果；先改最小受影响页面。下一批只取适用的未关闭规则，避免把全部历史错误灌入提示。结构通过与内容确认分开，规则不能自动修改执行权限。

## 验证与限制

回放原失败查询并加入不受影响查询；记录读取次数与成本。论文主要使用 GLM-5.1 和给定 QA 语料，查询预算未逐项统一，初始编译较贵；长期动态语料与本机 Astra 收益仍待验证。

[^arxiv-2605.25480-v2]: [Retrieval as Reasoning: Self-Evolving Agent-Native Retrieval via LLM-Wiki v2](https://arxiv.org/abs/2605.25480v2), §3.2–3.3、§4.1、§4.4、Limitations。具体工件摘要与行号见本页 rsi_evidence。
