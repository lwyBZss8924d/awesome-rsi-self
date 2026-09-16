---
type: Concept
title: 任务状态与知识状态分别拥有写入权
description: 以任务结果和来源知识的不同生命周期避免完成状态互相冒充。
status: draft
tags:
  - pm
  - knowledge
  - ownership
  - design-hypothesis
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
      start_line: 30
      end_line: 43
    preparation_key: 6e6a718e93bd3f812d50ee0217316ad1667f1ceb75b4404acf3699a57d86f635
    artifact: paper.llms.txt
  - source_id: arxiv-2608.29596-v1
    version: v1
    prepared_manifest_sha256: eebf58c7caea35099a3be91890af6f11bb36d134b5c36bf043cbbf4f2c5d50ab
    sha256: e22346d669a0e1092795eb2c8d6eb0f3fb3563063fa59a276bf9755500a0c771
    locator:
      start_line: 1161
      end_line: 1164
    preparation_key: 6e6a718e93bd3f812d50ee0217316ad1667f1ceb75b4404acf3699a57d86f635
    artifact: paper.llms.txt
---

# 任务状态与知识状态分别拥有写入权

## 来源观察

Skills Foundation 区分一次性计划、历史轨迹与跨任务复用的程序性技能；其内存架构还区分当前执行状态与长期存储。这支持按记录用途划分生命周期，未规定本项目的 owner 实现。[^arxiv-2608.29596-v1]

## 本地设计假设

PM owner 维护当前目标、依赖、尝试与完成证据；KB owner 维护来源版本、解释、反例和复查状态。两边只引用稳定 ID：论文已导入不代表任务完成，任务完成也不使某条经验自动成立。一次执行的状态变更通过 PM 接口；可复用知识通过带来源的草稿导入。

## 验证与限制

用“文献已编译但验收失败”和“任务成功但概念仍待核验”两种场景检查状态独立性。上述隔离是本地架构推断，尚未测量恢复成本或准确率。

参见 [证据分层](evidence-layers.md)。

[^arxiv-2608.29596-v1]: [Towards a Systems Foundation for Agentic Skills: Architecture, Lifecycle, and Security v1](https://arxiv.org/abs/2608.29596v1), §1.2、§3.3.1。具体工件摘要与行号见本页 rsi_evidence。
