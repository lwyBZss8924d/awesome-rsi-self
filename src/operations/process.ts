import { spawn, spawnSync } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { writeJson, sha256 } from "../io.ts";
import { commandSchema, type CommandSpec } from "./contracts.ts";

export const PARENT_IDENTITIES = ["CODEX_THREAD_ID", "CODEX_SESSION_ID", "CODEX_TURN_ID", "CODEX_PARENT_THREAD_ID"];
export interface ProcessResult {
  schema_version: "rsi.process.v1";
  argv: string[];
  started_at: string;
  finished_at: string;
  pid: number | null;
  exit_code: number | null;
  signal: string | null;
  status: "exited" | "failed" | "timeout" | "cancelled" | "output_limit";
  stdout: string;
  stderr: string;
  output_complete: boolean;
  stdout_sha256: string;
  stderr_sha256: string;
  native_session_ids: string[];
  cleared_parent_identity_fields: string[];
  quiescent: boolean;
  launch_error?: string;
  termination_errors?: string[];
}

function groupAlive(pid: number) {
  try { process.kill(-pid, 0); } catch (e: any) {if(e.code === "ESRCH")return false;}
  // macOS can return EPERM while a reaped process is briefly listed as a zombie.
  // Observe only IDs/status. Unknown observation remains live, never a successful zero.
  const result=spawnSync("ps",["-axo","pid=,pgid=,stat="],{encoding:"utf8",maxBuffer:1024*1024,timeout:2000});
  if(result.status!==0)return true;
  return result.stdout.split("\n").some(line=>{const row=line.trim().split(/\s+/);return Number(row[1])===pid && !row[2]?.includes("Z");});
}
function signalGroup(pid: number, signal: NodeJS.Signals) {
  try { process.kill(-pid, signal); } catch (e: any) { if (e.code !== "ESRCH" && groupAlive(pid)) throw e; }
}
export function renderArgv(spec: CommandSpec, variables: Record<string, string>): string[] {
  return spec.argv.map(arg => arg.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (token, name) => {
    if (!(name in variables)) throw new Error(`unknown_command_placeholder:${name}`);
    return variables[name]!;
  }));
}
export async function boundedProcess(
  input: zInput, options: {cwd: string; evidenceDir: string; variables?: Record<string,string>; signal?: AbortSignal; deadlineAt?: number; stdin?: string},
): Promise<ProcessResult> {
  const spec = commandSchema.parse(input), argv = renderArgv(spec, options.variables ?? {});
  if (options.signal?.aborted) throw new Error("run_cancelled");
  const remaining = Math.min(spec.timeoutSeconds * 1000, (options.deadlineAt ?? Infinity) - Date.now());
  if (remaining <= 0) throw new Error("run_budget_exhausted");
  for (const key of PARENT_IDENTITIES) if (key in spec.env) throw new Error(`parent_identity_override:${key}`);
  if ("CODEX_HOME" in spec.env) throw new Error("use_codexHome_field");
  await mkdir(options.evidenceDir, {recursive:true});
  const env: Record<string,string|undefined> = {...process.env, ...spec.env};
  const cleared = PARENT_IDENTITIES.filter(key => key in env);
  for (const key of PARENT_IDENTITIES) delete env[key];
  if (spec.codexHome) env.CODEX_HOME = resolve(spec.codexHome);
  const startedAt = new Date().toISOString();
  let child;
  try {child=spawn(argv[0]!, argv.slice(1), {cwd:options.cwd, env, detached:true, stdio:["pipe","pipe","pipe"]});}
  catch(error) {
    const result:ProcessResult={schema_version:"rsi.process.v1",argv,started_at:startedAt,finished_at:new Date().toISOString(),pid:null,exit_code:null,signal:null,status:"failed",stdout:"",stderr:"",output_complete:true,stdout_sha256:sha256(""),stderr_sha256:sha256(""),native_session_ids:[],cleared_parent_identity_fields:cleared,quiescent:true,launch_error:String(error)};
    await writeJson(resolve(options.evidenceDir,"started.json"),{schema_version:"rsi.process-started.v1",argv,pid:null,started_at:startedAt});
    await writeJson(resolve(options.evidenceDir,"process.json"),result);return result;
  }
  const pid = child.pid ?? null;
  let resultStatus: ProcessResult["status"] = "exited", complete = true, bytes = 0;
  const chunks: {stdout:Buffer[];stderr:Buffer[]} = {stdout:[],stderr:[]};
  let stopped = false;
  const terminationErrors:string[]=[];
  const terminate=(signal:NodeJS.Signals)=>{if(pid)try{signalGroup(pid,signal);}catch(error){terminationErrors.push(String(error));}};
  const stop = (reason: ProcessResult["status"]) => {
    if (stopped) return;
    stopped = true; resultStatus = reason;
    terminate("SIGTERM");
  };
  const capture = (which: "stdout"|"stderr", chunk:Buffer) => {
    const allowed = Math.max(0,spec.maxOutputBytes-bytes);
    if (allowed) chunks[which].push(chunk.subarray(0,allowed));
    bytes += chunk.length;
    if (bytes > spec.maxOutputBytes) {complete=false;stop("output_limit");}
  };
  child.stdout.on("data",chunk=>capture("stdout",Buffer.from(chunk)));
  child.stderr.on("data",chunk=>capture("stderr",Buffer.from(chunk)));
  const terminal = new Promise<{code:number|null;signal:string|null}>((resolveTerminal,reject)=>{
    child.on("error",reject);
    child.on("exit",(code,signal)=>resolveTerminal({code,signal}));
  });
  // Attach immediately: launch errors can arrive while the durable started receipt writes.
  void terminal.catch(()=>{});
  const streamsClosed = new Promise<void>(resolveClosed=>child.on("close",()=>resolveClosed()));
  child.stdin.on("error",()=>{}); // A worker may terminate before consuming the prompt.
  const timer = setTimeout(()=>stop("timeout"), remaining);
  const abort = ()=>stop("cancelled");
  options.signal?.addEventListener("abort",abort,{once:true});
  const killTimer = setInterval(()=> { if(stopped && pid && groupAlive(pid)) terminate("SIGKILL"); },1500);
  let exit: {code:number|null;signal:string|null}={code:null,signal:null}, launchError:string|undefined;
  try {
    await writeJson(resolve(options.evidenceDir,"started.json"),{
      schema_version:"rsi.process-started.v1",nonce:randomUUID(),argv,cwd:options.cwd,pid,pgid:pid,
      started_at:startedAt,cleared_parent_identity_fields:cleared,codex_home:spec.codexHome ?? null,
    });
    if (options.stdin !== undefined) child.stdin.end(options.stdin); else child.stdin.end();
    exit = await terminal;
    if (!stopped && exit.code !== 0) resultStatus = "failed";
    if (pid && groupAlive(pid)) {terminate("SIGTERM");await new Promise(r=>setTimeout(r,100)); if(groupAlive(pid))terminate("SIGKILL");}
    await streamsClosed;
  } catch(error) {
    if(pid && groupAlive(pid))terminate("SIGKILL");
    await terminal.catch(()=>{});
    resultStatus="failed";launchError=String(error);
  } finally {clearTimeout(timer);clearInterval(killTimer);options.signal?.removeEventListener("abort",abort);}
  const stdout = Buffer.concat(chunks.stdout).toString("utf8"), stderr = Buffer.concat(chunks.stderr).toString("utf8");
  const nativeIds = new Set<string>();
  for (const line of stdout.split("\n")) {
    try { const event = JSON.parse(line); if(event.type === "thread.started" && /^[0-9a-f-]{36}$/.test(event.thread_id))nativeIds.add(event.thread_id); } catch {}
  }
  const result: ProcessResult = {
    schema_version:"rsi.process.v1",argv,started_at:startedAt,finished_at:new Date().toISOString(),pid,
    exit_code:exit!.code,signal:exit!.signal,status:resultStatus,stdout,stderr,output_complete:complete,
    stdout_sha256:sha256(stdout),stderr_sha256:sha256(stderr),native_session_ids:[...nativeIds],
    cleared_parent_identity_fields:cleared,quiescent:!pid || !groupAlive(pid),
    ...(launchError?{launch_error:launchError}:{}),
    ...(terminationErrors.length?{termination_errors:terminationErrors}:{}),
  };
  await writeJson(resolve(options.evidenceDir,"process.json"),result);
  return result;
}
type zInput = Parameters<typeof commandSchema.parse>[0];
export async function checkedProcess(input: zInput, options: Parameters<typeof boundedProcess>[1]): Promise<ProcessResult> {
  const result = await boundedProcess(input,options);
  if(result.status !== "exited" || result.exit_code !== 0 || !result.output_complete || !result.quiescent)
    throw new Error(`command_${result.status}:${result.exit_code}:${options.evidenceDir}`);
  return result;
}
export async function commandInput(spec: CommandSpec, variables:Record<string,string>, fallback:string) {
  if (!spec.stdinTemplate) return fallback;
  const template=await readFile(resolve(variables.root ?? process.cwd(),spec.stdinTemplate),"utf8");
  return template.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g,(_,key)=>{
    if(!(key in variables))throw new Error(`unknown_prompt_placeholder:${key}`);return variables[key]!;
  });
}
