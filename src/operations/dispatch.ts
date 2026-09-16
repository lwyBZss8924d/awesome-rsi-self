import { lstat, mkdir, open, readdir, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { dailyConfigSchema, type DailyConfigInput, type DailyOptions, type DailyState } from "./contracts.ts";
import { runDaily } from "./daily.ts";
import { checkedProcess } from "./process.ts";
import { absoluteNoSymlink } from "./projection.ts";
import { noSymlinkPath, readJson, sha256, writeJson } from "../io.ts";

const hash=(value:unknown)=>sha256(JSON.stringify(value));
async function exists(file:string){try{await lstat(file);return true;}catch(error:any){if(error.code==="ENOENT")return false;throw error;}}
type DispatchOptions=Pick<DailyOptions,"hooks"|"signal"|"runId">&{dryRun?:boolean};

/** One entrypoint: resume one known pending publication, otherwise sync a clean base and start once. */
export async function runScheduledCycle(root:string,input:DailyConfigInput,options:DispatchOptions={}){
  root=await absoluteNoSymlink(root);
  const config=dailyConfigSchema.parse(input),base=await noSymlinkPath(root,".local/daily");
  const attempt=randomUUID(),attemptPrefix=`.local/daily/dispatch/${attempt}`;
  const ownedAttempt=(item="")=>noSymlinkPath(root,item?`${attemptPrefix}/${item}`:attemptPrefix);
  const attemptDir=await ownedAttempt(),lockPath=await noSymlinkPath(root,".local/daily/dispatch.lock.json");
  await mkdir(attemptDir,{recursive:true});
  let lock;
  try{lock=await open(lockPath,"wx",0o600);await lock.writeFile(JSON.stringify({schema_version:"rsi.dispatch-lock.v1",pid:process.pid,attempt,created_at:new Date().toISOString()}));}
  catch(error:any){if(error.code==="EEXIST")return {schema_version:"rsi.dispatch-result.v1",action:"blocked",reason:"dispatch_lock_held",native_scheduled_accepted:false};throw error;}
  const cycleStarted=Date.now();let deadlineAt=cycleStarted+config.budgetSeconds*1000,sequence=0;
  const git=async(args:string[])=> {
    const key=`git-${++sequence}`,evidenceDir=await ownedAttempt(key);
    await ownedAttempt(`${key}/started.json`);await ownedAttempt(`${key}/process.json`);
    return (await checkedProcess({argv:["git",...args],timeoutSeconds:Math.min(config.budgetSeconds,120)},{cwd:root,evidenceDir,deadlineAt,signal:options.signal})).stdout.trim();
  };
  const snapshot=async()=>({revision:await git(["rev-parse","HEAD"]),branch:await git(["branch","--show-current"]),dirty:await git(["status","--porcelain=v1","--untracked-files=all"])});
  let before:Awaited<ReturnType<typeof snapshot>>|null=null;
  const finish=async(value:Record<string,unknown>)=>{
    let after:unknown;
    try{after=await snapshot();}catch(error){after={available:false,error:String(error)};}
    const fullRun=value.run as DailyState|undefined;
    const run=fullRun?{schema_version:"rsi.daily-run-summary.v1",run_id:fullRun.run_id,status:fullRun.status,source_revision:fullRun.source_revision,selected_sources:fullRun.selected_sources,outcome:fullRun.outcome,error:fullRun.error??null,record_path:resolve(base,"runs",fullRun.run_id,"state.json")}:undefined;
    const result={schema_version:"rsi.dispatch-result.v1",attempt_id:attempt,...value,...(run?{run}:{}),source_before:before,source_after:after,native_scheduled_accepted:false,record_path:await ownedAttempt("result.json")};
    await writeJson(result.record_path,result);return result;
  };
  try{
    before=await snapshot();
    if(before.dirty)return await finish({action:"blocked",reason:"dispatch_source_dirty"});
    const states:{state:DailyState;dir:string}[]=[];
    const runs=await noSymlinkPath(root,".local/daily/runs");
    if(await exists(runs))for(const entry of (await readdir(runs,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
      if(!entry.isDirectory())throw new Error("unknown_run_directory_entry");
      const file=await noSymlinkPath(root,`.local/daily/runs/${entry.name}/state.json`);
      if(!await exists(file))throw new Error("run_state_missing");
      const state=await readJson(file) as DailyState;
      if(state.schema_version!=="rsi.daily-run.v1"||state.run_id!==entry.name||!["running","completed","blocked","cancelled"].includes(state.status)||!state.phases)throw new Error("unknown_run_state");
      states.push({state,dir:resolve(runs,entry.name)});
    }
    const unfinished=states.filter(row=>row.state.status!=="completed");
    if(unfinished.length){
      if(unfinished.length!==1)return await finish({action:"blocked",reason:"multiple_unfinished_runs",run_ids:unfinished.map(row=>row.state.run_id)});
      const {state,dir}=unfinished[0]!,publication=state.phases.publish;
      const observation=publication?.result as any;
      if(state.status!=="blocked" || publication?.state!=="passed" || publication.result_sha256!==hash(observation) || observation.resume_safe!==true || observation.publication_accepted!==false || observation.pr_open!==true || !["required_checks_pending","automerge_queued"].includes(observation.reason))
        return await finish({action:"blocked",reason:"unfinished_run_requires_reconciliation",run_id:state.run_id});
      const saved=dailyConfigSchema.parse(await readJson(await noSymlinkPath(root,`.local/daily/runs/${state.run_id}/config.json`)));
      if(hash(saved)!==state.config_sha256 || before.revision!==state.source_revision)return await finish({action:"blocked",reason:"resume_source_or_config_drift",run_id:state.run_id});
      if(options.dryRun)return await finish({action:"would_resume",run_id:state.run_id,config_source:"saved_run",supplied_config_differs:hash(config)!==state.config_sha256});
      deadlineAt=cycleStarted+saved.budgetSeconds*1000;
      const result=await runDaily(root,saved,{...options,runId:state.run_id,resume:true,deadlineAt});
      return await finish({action:"resume",run_id:state.run_id,config_source:"saved_run",supplied_config_differs:hash(config)!==state.config_sha256,run:result});
    }
    const runId=options.runId??new Date().toISOString().slice(0,10);
    const completed=states.find(row=>row.state.run_id===runId);
    if(completed)return await finish({action:"already_completed",run_id:runId,run:completed.state});
    if(!config.publication?.enabled)return await finish({action:"blocked",reason:"dispatch_publication_required"});
    const pub=config.publication;
    if(before.branch!==pub.base)return await finish({action:"blocked",reason:"dispatch_base_branch_required",expected_branch:pub.base});
    const remote=await git(["remote","get-url",pub.remote]);
    if(![`https://github.com/${pub.repoSlug}`,`https://github.com/${pub.repoSlug}.git`,`git@github.com:${pub.repoSlug}.git`].includes(remote))throw new Error("publication_remote_repo_mismatch");
    if(options.dryRun)return await finish({action:"would_start",run_id:runId,base:pub.base});
    // Hold the same lock used by manual daily runs only while synchronizing the source.
    const syncLock=await noSymlinkPath(root,".local/daily/lock.json");
    const sync=await open(syncLock,"wx",0o600);
    let synchronizedRevision=before.revision;
    try{
      await sync.writeFile(JSON.stringify({run_id:`dispatch-${attempt}`,pid:process.pid,token:attempt,started_at:new Date().toISOString()}));
      if((await snapshot()).dirty)throw new Error("dispatch_source_changed_before_sync");
      await git(["fetch","--no-tags",pub.remote,pub.base]);
      const fetched=await git(["rev-parse","FETCH_HEAD"]);
      await git(["merge-base","--is-ancestor",before.revision,fetched]);
      await git(["merge","--ff-only",fetched]);
      const synced=await snapshot();
      if(synced.revision!==fetched||synced.branch!==pub.base||synced.dirty)throw new Error("dispatch_base_sync_mismatch");
      synchronizedRevision=synced.revision;
      await writeJson(await ownedAttempt("base-sync.json"),{before:before.revision,after:synced.revision,remote:pub.remote,branch:pub.base});
    }finally{await sync.close();if((await readJson(await noSymlinkPath(root,".local/daily/lock.json"))).token===attempt)await unlink(syncLock);}
    if(synchronizedRevision!==before.revision)return await finish({
      action:"restart_required",reason:"source_revision_changed",run_id:runId,config_source:"supplied",
      restart:{expected_revision:synchronizedRevision,budget_deadline_at:new Date(deadlineAt).toISOString(),remaining_budget_seconds:Math.max(0,(deadlineAt-Date.now())/1000),
        next_action:"Start a fresh CLI process from this revision with the same config and run ID; do not reuse loaded API hooks. Respect the remaining cycle budget or defer to a later scheduled invocation."},
    });
    const result=await runDaily(root,config,{...options,runId,deadlineAt});
    return await finish({action:"start",run_id:runId,config_source:"supplied",run:result});
  }catch(error){
    return await finish({action:"blocked",reason:String(error)});
  }finally{
    await lock.close();if((await readJson(await noSymlinkPath(root,".local/daily/dispatch.lock.json"))).attempt===attempt)await unlink(lockPath);
  }
}
