---
type: Concept
title: 技能六元组是检查视角
description: 把触发、约束、工具、控制流和结果连起来，避免只优化文本外形。
status: draft
tags:
  - skills
  - contracts
  - lifecycle
rsi_local_adoption: proposed
rsi_empirical_gain: not_measured
generated:
  by: codex/gpt-6-astra
  at: 2026-09-16T07:30:18.269807Z
sources:
  - id: arxiv-2608.29596-v1
    resource: https://arxiv.org/abs/2608.29596v1
    title: "Towards a Systems Foundation for Agentic Skills: Architecture, Lifecycle, and Security"
    version: v1
rsi_contribution: r6-bootstrap-learning-20260916
rsi_evidence:
  - source_id: arxiv-2608.29596-v1
    version: v1
    prepared_manifest_sha256: eebf58c7caea35099a3be91890af6f11bb36d134b5c36bf043cbbf4f2c5d50ab
    sha256: e22346d669a0e1092795eb2c8d6eb0f3fb3563063fa59a276bf9755500a0c771
    locator:
      start_line: 19
      end_line: 43
    preparation_key: 6e6a718e93bd3f812d50ee0217316ad1667f1ceb75b4404acf3699a57d86f635
    artifact: paper.llms.txt
  - source_id: arxiv-2608.29596-v1
    version: v1
    prepared_manifest_sha256: eebf58c7caea35099a3be91890af6f11bb36d134b5c36bf043cbbf4f2c5d50ab
    sha256: e22346d669a0e1092795eb2c8d6eb0f3fb3563063fa59a276bf9755500a0c771
    locator:
      start_line: 1961
      end_line: 1963
    preparation_key: 6e6a718e93bd3f812d50ee0217316ad1667f1ceb75b4404acf3699a57d86f635
    artifact: paper.llms.txt
---

# 技能六元组是检查视角

## 来源观察

Skills Foundation 将技能表达为六元组：激活条件、操作指引、适用约束、工具接口、执行策略、预期状态变化；模块化、按需调用和程序性状态转换是其区分标准。[^arxiv-2608.29596-v1]

## 本地使用方式

检查某个技能能否回答“何时用、输入条件是什么、调用什么、失败如何处理、怎样确认结果”。信息可分布在 SKILL.md、manifest、脚本和测试中；不为凑六个字段复制内容，也不由声明本身授予执行权限。

## 验证与限制

选一个真实任务核对适用条件和后置结果，再比较无技能基线。该文是跨系统综述，侧重软件、网页等场景，不能把综述提出的生命周期当作本机已验证收益或每次工作必经的治理程序。

[^arxiv-2608.29596-v1]: [Towards a Systems Foundation for Agentic Skills: Architecture, Lifecycle, and Security v1](https://arxiv.org/abs/2608.29596v1), §1.2、§8。具体工件摘要与行号见本页 rsi_evidence。
