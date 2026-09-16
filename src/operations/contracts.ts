import { z } from "zod";
import type { Source } from "../contracts.ts";

const identifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/);
export const commandSchema = z.object({
  argv: z.array(z.string().min(1)).min(1),
  timeoutSeconds: z.number().positive().max(1800).default(600),
  maxOutputBytes: z.number().int().positive().max(16 * 1024 * 1024).default(1024 * 1024),
  codexHome: z.string().min(1).optional(),
  env: z.record(z.string(), z.string()).default({}),
  stdinTemplate: z.string().optional(),
}).strict();
export type CommandSpec = z.infer<typeof commandSchema>;
export const dailyConfigSchema = z.object({
  schema_version: z.literal("rsi.daily-config.v1"),
  budgetSeconds: z.number().positive().max(1800).default(1800),
  maxSources: z.number().int().positive().max(20).default(3),
  upstreams: z.array(z.object({
    id: identifier, url: z.string().min(1), ref: z.string().min(1).default("HEAD"),
    paths: z.array(z.string().min(1)).min(1).default(["README.md"]),
  }).strict()).default([]),
  discovery: z.array(z.object({
    id: identifier, format: z.enum(["normalized", "hf_papers"]).default("normalized"),
    resolveVersions: z.boolean().default(true),
    command: commandSchema,
  }).strict()).default([]),
  sourceIds: z.array(z.string()).optional(),
  research: commandSchema.optional(),
  verifier: commandSchema.optional(),
  publication: z.object({
    enabled: z.boolean().default(false), repoSlug: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
    remote: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/).default("origin"),
    base: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/).default("main"),
    branchPrefix: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/).default("rsi-daily"),
    requiredChecks: z.array(z.string().min(1)).min(1).default(["check"]),
    autoMerge: z.boolean().default(true),
  }).strict().optional(),
  projection: z.object({
    target: z.string().min(1), catalogCommand: commandSchema.optional(),
  }).strict().optional(),
}).strict().superRefine((value,ctx)=>{
  for(const key of ["upstreams","discovery"] as const){
    const ids=value[key].map(item=>item.id);
    if(new Set(ids).size!==ids.length)ctx.addIssue({code:"custom",path:[key],message:"duplicate input identifiers"});
  }
});
export type DailyConfig = z.infer<typeof dailyConfigSchema>;
export type DailyConfigInput = z.input<typeof dailyConfigSchema>;

export interface DailyContext {
  root: string;
  runDir: string;
  runId: string;
  signal: AbortSignal;
  deadlineAt: number;
}
export interface DailyHooks {
  fetch(source: Source, context: DailyContext): Promise<unknown>;
  prepare(source: Source, context: DailyContext): Promise<unknown>;
  compile(contribution: unknown, context: DailyContext): Promise<unknown>;
  lint(context: DailyContext): Promise<unknown>;
  build(context: DailyContext): Promise<unknown>;
}
export interface DailyOptions {
  runId?: string;
  resume?: boolean;
  signal?: AbortSignal;
  hooks?: Partial<DailyHooks>;
}
export type StageState = "running" | "passed" | "failed";
export interface PhaseReceipt {
  state: StageState;
  started_at: string;
  completed_at?: string;
  result?: unknown;
  result_sha256?: string;
  error?: string;
}
export interface DailyState {
  schema_version: "rsi.daily-run.v1";
  run_id: string;
  config_sha256: string;
  source_revision: string;
  created_at: string;
  updated_at: string;
  status: "running" | "completed" | "blocked" | "cancelled";
  worktree: string;
  phases: Record<string, PhaseReceipt>;
  selected_sources: string[];
  outcome: {
    source_scan_complete: boolean;
    checks_passed: boolean;
    pr_open: boolean | null;
    merged: boolean | null;
    projection_synced: boolean | null;
    native_scheduled_accepted: false;
  };
  error?: string;
}
export const workerResultSchema = z.object({
  schema_version: z.literal("rsi.worker-result.v1"),
  request_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  outcome: z.enum(["complete", "partial", "failed"]),
  artifacts: z.array(z.object({path: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/)}).strict()).default([]),
  contribution: z.unknown().optional(),
  review: z.object({
    candidate_commit: z.string().regex(/^[a-f0-9]{40}$/),
    candidate_digest: z.string().regex(/^[a-f0-9]{64}$/),
    verdict: z.enum(["accept", "reject", "unverified"]),
    checked_claims: z.number().int().nonnegative(),
    issues: z.array(z.string()),
  }).strict().optional(),
}).strict();
