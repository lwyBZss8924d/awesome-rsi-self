---
type: Concept
title: 原件、提取、编译与执行证据分别记录
description: 保留可追溯转换链，同时区分结构正确与主张受支持。
status: draft
tags:
  - provenance
  - raw
  - extraction
  - compilation
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
      start_line: 59
      end_line: 63
    preparation_key: f93c9c110a4908c5480c307ce0f18eb79a93874be6f0ab2feaa031ccf427d83e
    artifact: paper.llms.txt
  - source_id: arxiv-2605.25480-v2
    version: v2
    prepared_manifest_sha256: 136418bc798d3bb42ef6f4db3e4beb8b9570ef9cb1d7afe522e340afa15bf103
    sha256: 2643b16fde8b04ac1fee5f857911e0ee3089a4af10f0fe8d2507fe8a1cd250c3
    locator:
      start_line: 94
      end_line: 116
    preparation_key: f93c9c110a4908c5480c307ce0f18eb79a93874be6f0ab2feaa031ccf427d83e
    artifact: paper.llms.txt
---

# 原件、提取、编译与执行证据分别记录

## 来源观察

LLM-Wiki 将 source archives 与编译后的页面、链接、索引区分；编译环节分别检查结构与内容。[^arxiv-2605.25480-v2]

## 本地设计假设

RAW 层保存原始 HTML／TeX 包；提取层保存清洗正文、解析限制和原文定位；Wiki 层保存可修订的解释；执行回执记录一次操作及结果。每次转换绑定输入版本、内容摘要与工具版本。摘要相等只证明字节绑定，行号存在只证明定位，均不能替代语义支持或任务验收。

## 验证与限制

引用必须能够回到具体工件；提取 partial 不升级为 full-read。改变输入时产生新派生版本；正文矛盾进入核验队列。此分层是本项目适配，论文没有规定 HTML／TeX 获取契约，也没有证明本地检索提升。

参见 [错误簿](retrieval-error-book.md)。

[^arxiv-2605.25480-v2]: [Retrieval as Reasoning: Self-Evolving Agent-Native Retrieval via LLM-Wiki v2](https://arxiv.org/abs/2605.25480v2), §3.1、§3.3。具体工件摘要与行号见本页 rsi_evidence。
