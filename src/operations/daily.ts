import { mkdir, readFile, readdir, lstat, open, unlink, writeFile } from "node:fs/promises";
import { resolve, relative, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { DOMParser } from "linkedom";
import { sourceSchema, sourceKey, SOURCE_MANIFEST, type Source } from "../contracts.ts";
import { readJson, writeJson, loadSources, sha256, noSymlinkPath } from "../io.ts";
import { dailyConfigSchema, workerResultSchema, type DailyConfigInput, type DailyConfig, type DailyState, type DailyOptions, type DailyContext, type CommandSpec } from "./contracts.ts";
import { checkedProcess, commandInput, type ProcessResult } from "./process.ts";
import { absoluteNoSymlink, EXPORT_PATHS, exportKnowledge } from "./projection.ts";
import { arxivIdentity, arxivSourceId, filterRelevant, hasKnownArxivSource, hfRows, upstreamArxivDelta } from "./discovery.ts";

const stamp=()=>new Date().toISOString();
const digest=(value:unknown)=>sha256(JSON.stringify(value));
const idPattern=/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/;
export async function abortablePause(milliseconds:number,signal:AbortSignal){
  if(signal.aborted)throw new Error("run_cancelled");
  await new Promise<void>((resolvePause,reject)=>{
    const onAbort=()=>{clearTimeout(timer);reject(new Error("run_cancelled"));};
    const timer=setTimeout(()=>{signal.removeEventListener("abort",onAbort);resolvePause();},Math.max(0,milliseconds));
    signal.addEventListener("abort",onAbort,{once:true});
  });
}
export function classifyRequiredChecks(checks:any[],required:string[]){
  const rows=required.map(name=>{
    const matches=checks.filter(c=>c.name===name||c.context===name);
    const failed=matches.some(c=>["FAILURE","ERROR","CANCELLED","TIMED_OUT","ACTION_REQUIRED","STARTUP_FAILURE","STALE"].includes(c.conclusion??c.state));
    const passed=matches.length>0&&matches.every(c=>c.conclusion==="SUCCESS"||c.state==="SUCCESS");
    return {name,status:failed?"failed":passed?"passed":"pending"};
  });
  return {status:rows.some(r=>r.status==="failed")?"failed":rows.every(r=>r.status==="passed")?"passed":"pending",checks:rows};
}
async function exists(path:string){try{await lstat(path);return true;}catch(e:any){if(e.code==="ENOENT")return false;throw e;}}
function alive(pid:number){try{process.kill(pid,0);return true;}catch(e:any){return e.code!=="ESRCH";}}
function completed(result:any){if(result?.ok !== true)throw new Error("hook_result_not_accepted");return result;}
function publishedPath(path:string){return EXPORT_PATHS.some(p=>path===p||path.startsWith(`${p}/`));}
async function readCursor(root:string){const file=resolve(root,".local/daily/cursor.json");return await exists(file)?await readJson(file):{schema_version:"rsi.daily-cursor.v1",sources:{},upstreams:{}};}

export async function dailyPlan(root:string, input:DailyConfigInput) {
  const config=dailyConfigSchema.parse(input), sources=(await loadSources(root)).sources, cursor=await readCursor(root);
  const available=sources.filter(s=>(!config.sourceIds || config.sourceIds.includes(s.id)) && !(s.kind==="paper" && !s.version));
  const pending=available.filter(s=>cursor.sources[sourceKey(s)]?.source_sha256!==digest(s));
  return {schema_version:"rsi.daily-plan.v1",config_sha256:digest(config),budget_seconds:config.budgetSeconds,max_sources:config.maxSources,
    sources:pending.slice(0,config.maxSources).map(s=>({id:s.id,key:sourceKey(s),source_sha256:digest(s)})),pending_sources:pending.length,
    discovery:config.discovery.map(d=>({id:d.id,format:d.format})),upstreams:config.upstreams.map(u=>({id:u.id,url:u.url,ref:u.ref})),
    stages:["input-scan","fetch","prepare","research","compile","lint","build","candidate","verify","publish","projection","checkpoint"],
    publication_enabled:config.publication?.enabled===true,scheduled_activation:"not_managed_by_this_command"};
}

export function normalizeHfPapers(value:unknown):Source[] {
  const rows=hfRows(value);
  return rows.map((row:any)=>{
    const p=row?.paper ?? row;
    if(typeof p?.id!=="string" || !/^\d{4}\.\d{4,5}(?:v\d+)?$/.test(p.id) || typeof p.title!=="string")throw new Error("hf_paper_missing_identity");
    const match=p.id.match(/^(.*?)(v\d+)?$/)!,id=match[1]!,version=match[2];
    return sourceSchema.parse({id:`arxiv-${id}${version?`-${version}`:""}`,kind:"paper",title:p.title,version,urls:{canonical:`https://arxiv.org/abs/${p.id}`,...(version?{html:`https://arxiv.org/html/${p.id}`,tex:`https://arxiv.org/src/${p.id}`}:{})},tags:["daily-discovery"],provenance:{discovered_by:"hf-papers",version_resolution:version?"explicit":"pending"}});
  });
}
export function mergeDiscovered(existing:Source[], discovered:Source[]) {
  const merged=[...existing], added:Source[]=[], conflicts:{id:string;reason:string}[]=[];
  for(const row of discovered){
    const candidate=sourceSchema.parse(row), found=merged.find(s=>s.id===candidate.id || s.urls.canonical===candidate.urls.canonical);
    if(!found){merged.push(candidate);added.push(candidate);continue;}
    if(found.kind!==candidate.kind || found.urls.canonical.replace(/v\d+$/,"")!==candidate.urls.canonical.replace(/v\d+$/,""))conflicts.push({id:candidate.id,reason:"identity_conflict"});
    else if(candidate.version && found.version && candidate.version!==found.version)conflicts.push({id:candidate.id,reason:`new_version:${candidate.version};registry_preserved:${found.version}`});
    // A discovery cannot silently replace a reviewed source revision or metadata.
  }
  return {sources:merged,added,conflicts};
}

type ArxivRequestOptions={signal?:AbortSignal;deadlineAt?:number;fetch?:typeof fetch};
type ArxivClock={now:()=>number;pause:(milliseconds:number,signal:AbortSignal)=>Promise<void>};

/** One queue for actual metadata requests. The clock port is for deterministic tests only. */
export function createArxivMetadataClient(clock:ArxivClock={now:Date.now,pause:abortablePause}){
  let tail=Promise.resolve(),availableAt=0;
  return async(url:string,options:ArxivRequestOptions={}):Promise<string>=>{
    const deadline=Number.isFinite(options.deadlineAt)?options.deadlineAt!:clock.now()+30_000;
    if(deadline<=clock.now())throw new Error("run_budget_exhausted");
    const timeout=AbortSignal.timeout(Math.max(1,Math.ceil(deadline-clock.now())));
    const signal=options.signal?AbortSignal.any([options.signal,timeout]):timeout;
    signal.throwIfAborted();
    const previous=tail;let release!:()=>void;
    const ticket=new Promise<void>(resolveTicket=>{release=resolveTicket;});
    tail=previous.then(()=>ticket);
    try{
      await new Promise<void>((resolveTurn,reject)=>{
        const abort=()=>reject(signal.reason??new Error("run_cancelled"));
        signal.addEventListener("abort",abort,{once:true});
        previous.then(()=>{signal.removeEventListener("abort",abort);resolveTurn();});
        if(signal.aborted)abort();
      });
      let retrying429=false;
      for(let attempt=0;attempt<2;attempt++){
        signal.throwIfAborted();
        if(availableAt>=deadline||clock.now()>=deadline)throw new Error(retrying429?"arxiv_version_lookup_http:429:retry_after_exceeds_deadline":"run_budget_exhausted");
        if(availableAt>clock.now())await clock.pause(availableAt-clock.now(),signal);
        signal.throwIfAborted();
        if(clock.now()>=deadline)throw new Error("run_budget_exhausted");
        const requestSignal=AbortSignal.any([signal,AbortSignal.timeout(Math.max(1,Math.ceil(Math.min(30_000,deadline-clock.now()))))]);
        let retryAfter=0;
        try{
          const response=await (options.fetch??globalThis.fetch)(url,{signal:requestSignal,headers:{Accept:"application/atom+xml"}});
          if(!response.ok){
            if(response.status===429){
              const value=response.headers.get("Retry-After")?.trim();
              if(value){const parsed=/^\d+(?:\.\d+)?$/.test(value)?clock.now()+Number(value)*1000:Date.parse(value);if(!Number.isNaN(parsed))retryAfter=parsed;}
            }
            await response.body?.cancel().catch(()=>{});
            requestSignal.throwIfAborted();
            if(response.status===429&&attempt===0){retrying429=true;continue;}
            throw new Error(`arxiv_version_lookup_http:${response.status}`);
          }
          const reader=response.body?.getReader();if(!reader)throw new Error("arxiv_version_response_missing");
          const chunks:Uint8Array[]=[];let total=0;
          const cancel=()=>{void reader.cancel(requestSignal.reason).catch(()=>{});};
          requestSignal.addEventListener("abort",cancel,{once:true});
          try{
            while(true){requestSignal.throwIfAborted();const next=await reader.read();if(next.done)break;total+=next.value.byteLength;if(total>2*1024*1024)throw new Error("arxiv_version_response_limit");chunks.push(next.value);}
            requestSignal.throwIfAborted();
            return Buffer.concat(chunks).toString("utf8");
          }finally{requestSignal.removeEventListener("abort",cancel);await reader.cancel().catch(()=>{});}
        }finally{
          // arXiv API guidance asks for a 3-second delay between consecutive calls.
          // Retain the queue through body consumption/cancellation, including 429 retries.
          availableAt=Math.max(availableAt,clock.now()+3000,retryAfter);
        }
      }
      throw new Error("arxiv_version_lookup_http:429");
    }finally{release();}
  };
}
const arxivMetadataClient=createArxivMetadataClient();

export async function resolveArxivVersions(candidates:Source[],options:ArxivRequestOptions&{metadataClient?:ReturnType<typeof createArxivMetadataClient>}={}){
  const unresolved=candidates.filter(s=>s.kind==="paper"&&!s.version);
  if(!unresolved.length)return candidates;
  const ids=unresolved.map(s=>arxivIdentity(s.urls.canonical)?.id);
  if(ids.some(id=>!id))throw new Error("version_resolution_requires_arxiv_id");
  if(ids.length>100)throw new Error("arxiv_version_batch_exceeds_100");
  const url=`https://export.arxiv.org/api/query?id_list=${ids.join(",")}&max_results=${ids.length}`;
  const xml=await (options.metadataClient??arxivMetadataClient)(url,options),doc=new DOMParser().parseFromString(xml,"text/xml");
  const resolved=new Map<string,string>();
  for(const entry of Array.from(doc.getElementsByTagName("entry"))){const identifier=entry.getElementsByTagName("id")[0]?.textContent?.trim();const identity=identifier?arxivIdentity(identifier):null;if(identity?.version)resolved.set(identity.id,identity.version);}
  return candidates.map(s=>{
    if(s.kind!=="paper"||s.version)return s;
    const id=arxivIdentity(s.urls.canonical)!.id,version=resolved.get(id);
    if(!version)throw new Error(`arxiv_version_unavailable:${id}`);
    return sourceSchema.parse({...s,id:arxivSourceId(id,version),version,urls:{canonical:`https://arxiv.org/abs/${id}${version}`,html:`https://arxiv.org/html/${id}${version}`,tex:`https://arxiv.org/src/${id}${version}`},provenance:{...s.provenance,version_resolution:"arxiv_atom",version_lookup_url:url,version_lookup_sha256:sha256(xml)}});
  });
}

async function assertProcessesQuiescent(runDir:string){
  async function walk(dir:string):Promise<void>{
    if(!await exists(dir))return;
    for(const e of await readdir(dir,{withFileTypes:true})){
      const item=resolve(dir,e.name);if(e.isSymbolicLink())throw new Error("symlink_in_run_evidence");
      if(e.isDirectory()){await walk(item);continue;}
      if(e.name!=="started.json")continue;
      const start=await readJson(item),terminal=resolve(dir,"process.json");
      if(!await exists(terminal))throw new Error(`process_receipt_unavailable:${relative(runDir,dir)}`);
      const result=await readJson(terminal);
      if(result.pid!==start.pid || !result.quiescent || (start.pid && alive(-start.pid)))throw new Error("prior_process_not_quiescent");
    }
  }
  await walk(runDir);
}
export async function takeDailyLock(base:string, runId:string, resume:boolean){
  const file=await noSymlinkPath(base,"lock.json"),token=randomUUID();await mkdir(base,{recursive:true});
  try{const f=await open(file,"wx",0o600);await f.writeFile(JSON.stringify({run_id:runId,pid:process.pid,token,started_at:stamp()}));await f.close();}
  catch(e:any){
    if(e.code!=="EEXIST")throw e;
    if(!resume)throw new Error("daily_lock_held");
    const recoveryPath=await noSymlinkPath(base,"lock-recovery.json"),recoveryToken=randomUUID();
    let recovery;
    try{recovery=await open(recoveryPath,"wx",0o600);}catch(error:any){if(error.code==="EEXIST")throw new Error("daily_lock_recovery_held");throw error;}
    try{
      await recovery.writeFile(JSON.stringify({pid:process.pid,token:recoveryToken,run_id:runId}));
      // Ownership is re-read only after obtaining exclusive recovery authority.
      const previousBytes=await readFile(await noSymlinkPath(base,"lock.json"),"utf8"),previous=JSON.parse(previousBytes),before=await lstat(file);
      if(previous.run_id!==runId || !Number.isInteger(previous.pid) || alive(previous.pid))throw new Error("daily_lock_held");
      await assertProcessesQuiescent(resolve(base,"runs",runId));
      const current=await lstat(await noSymlinkPath(base,"lock.json"));
      if(current.ino!==before.ino || await readFile(file,"utf8")!==previousBytes)throw new Error("daily_lock_owner_changed");
      await unlink(file);
      return await takeDailyLock(base,runId,false);
    }finally{await recovery.close();if((await readJson(recoveryPath)).token===recoveryToken)await unlink(recoveryPath);}
  }
  return async()=>{if((await readJson(file)).token===token)await unlink(file);};
}

export async function runDaily(root:string, input:DailyConfigInput, options:DailyOptions={}):Promise<DailyState> {
  root=await absoluteNoSymlink(root);
  const config=dailyConfigSchema.parse(input),runId=options.runId ?? new Date().toISOString().slice(0,10);
  if(!idPattern.test(runId))throw new Error("invalid_run_id");
  const base=await noSymlinkPath(root,".local/daily"),runDir=resolve(base,"runs",runId);
  await noSymlinkPath(root,relative(root,runDir));
  const release=await takeDailyLock(base,runId,options.resume===true),statePath=resolve(runDir,"state.json");
  const controller=new AbortController(),forward=()=>controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort",forward,{once:true});if(options.signal?.aborted)forward();
  const deadlineAt=Math.min(Date.now()+config.budgetSeconds*1000,options.deadlineAt??Infinity);
  const timer=setTimeout(()=>controller.abort(new Error("run_budget_exhausted")),Math.max(0,deadlineAt-Date.now()));
  let sequence=0,state:DailyState|undefined;const invocationId=randomUUID();
  const exec=async(argv:string[],cwd:string=root,label="command",commandDeadline=deadlineAt)=>checkedProcess({argv,timeoutSeconds:Math.min(config.budgetSeconds,300)}, {cwd,evidenceDir:resolve(state?resolve(runDir,"processes"):resolve(base,"preflight",`${runId}-${invocationId}`),`${String(++sequence).padStart(4,"0")}-${label}-${randomUUID().slice(0,8)}`),signal:controller.signal,deadlineAt:Math.min(deadlineAt,commandDeadline)});
  const git=async(args:string[],cwd:string=root,label="git")=>(await exec(["git",...args],cwd,label)).stdout.trim();
  const save=async()=>{state!.updated_at=stamp();await writeJson(statePath,state);};
  const phase=async<T>(name:string,work:()=>Promise<T>):Promise<T>=>{
    if(controller.signal.aborted)throw new Error("run_cancelled_or_budget_exhausted");
    const old=state!.phases[name];
    if(old?.state==="passed"){
      if(old.result_sha256!==digest(old.result))throw new Error(`phase_receipt_digest_mismatch:${name}`);
      if(name!=="publish" || (old.result as any)?.publication_accepted===true)return old.result as T;
    }
    if(old?.state==="running")throw new Error(`phase_requires_reconciliation:${name}`);
    if(old?.state==="failed" && !options.resume)throw new Error(`explicit_resume_required:${name}`);
    state!.phases[name]={state:"running",started_at:stamp()};await save();
    try{const result=await work();if(controller.signal.aborted)throw new Error("run_cancelled_or_budget_exhausted");state!.phases[name]={...state!.phases[name]!,state:"passed",completed_at:stamp(),result,result_sha256:digest(result)};await save();return result;}
    catch(error){state!.phases[name]={...state!.phases[name]!,state:"failed",completed_at:stamp(),error:String(error)};await save();throw error;}
  };
  try{
    const revision=await git(["rev-parse","HEAD"]);
    if(!/^[a-f0-9]{40}$/.test(revision))throw new Error("source_commit_required");
    if(await exists(statePath)){
      state=await readJson(statePath);
      if(state!.config_sha256!==digest(config) || state!.source_revision!==revision)throw new Error("resume_source_or_config_drift");
      if(state!.status==="completed")return state!;
      if(!options.resume)throw new Error("explicit_resume_required");
      await assertProcessesQuiescent(runDir);state!.status="running";delete state!.error;
    }else{
      const previousCursor=await readCursor(root);
      const adopted=[...new Set<string>([previousCursor.accepted_revision,...Object.values(previousCursor.sources??{}).map((s:any)=>s.accepted_revision)].filter(Boolean))];
      for(const accepted of adopted)await git(["merge-base","--is-ancestor",accepted,revision],root,"adopted-base-check");
      state={schema_version:"rsi.daily-run.v1",run_id:runId,config_sha256:digest(config),source_revision:revision,created_at:stamp(),updated_at:stamp(),status:"running",worktree:resolve(base,"worktrees",runId),phases:{},selected_sources:[],outcome:{source_scan_complete:false,checks_passed:false,pr_open:config.publication?.enabled?null:false,merged:config.publication?.enabled?null:false,projection_synced:config.projection?null:false,native_scheduled_accepted:false}};
      await writeJson(resolve(runDir,"config.json"),config);await save();
    }
    await phase("workspace",async()=>{
      if(await git(["status","--porcelain=v1","--untracked-files=all"]))throw new Error("daily_source_dirty");
      await noSymlinkPath(root,relative(root,state!.worktree));
      await git(["worktree","add","--detach",state!.worktree,revision]);return {root:state!.worktree,revision};
    });
    const ctx:DailyContext={root:state!.worktree,runDir,runId,signal:controller.signal,deadlineAt};
    const cursor=await readCursor(root);
    const inputs=await phase("input-scan",async()=>{
      if(!config.upstreams.length&&!config.discovery.length)throw new Error("source_scan_not_configured");
      const upstreams:Record<string,unknown>={},discovered:Source[]=[],selections:Record<string,unknown>={};
      const registered=(await loadSources(ctx.root)).sources;
      for(const upstream of config.upstreams){
        if(!/^(https:\/\/|file:\/\/)/.test(upstream.url) || upstream.ref.startsWith("-") || upstream.ref.includes(".."))throw new Error("unsafe_upstream_address");
        const repo=await noSymlinkPath(root,`.local/daily/upstreams/${upstream.id}.git`);
        if(!await exists(repo))await git(["init","--bare",repo]);
        await git(["--git-dir",repo,"fetch","--no-tags","--depth=1",upstream.url,upstream.ref]);
        const head=await git(["--git-dir",repo,"rev-parse","FETCH_HEAD"]),files:Record<string,{path:string;sha256:string}>={},observations:unknown[]=[];
        const previous=cursor.upstreams[upstream.id]?.commit ?? null;
        for(const item of upstream.paths){
          const output=await noSymlinkPath(resolve(runDir,"inputs/upstreams",upstream.id),item);
          if(item.startsWith("-")||item.includes(":"))throw new Error("unsafe_upstream_input_path");
          const content=(await exec(["git","--git-dir",repo,"show",`${head}:${item}`],root,"upstream-input")).stdout;
          await mkdir(dirname(output),{recursive:true});await writeFile(output,content);files[item]={path:relative(runDir,output),sha256:sha256(content)};
          if(upstream.discoverArxiv){
            let previousContent:string|null=null;
            if(previous===head)previousContent=content;
            else if(previous){
              const oldFile=await git(["--git-dir",repo,"ls-tree","--name-only",previous,"--",item]);
              previousContent=oldFile?(await exec(["git","--git-dir",repo,"show",`${previous}:${item}`],root,"previous-upstream-input")).stdout:"";
            }
            const delta=upstreamArxivDelta(content,previousContent,{upstream_id:upstream.id,commit:head,previous_commit:previous,path:item,sha256:sha256(content),url:upstream.url});
            observations.push({path:item,...delta});
            const candidates=delta.sources.filter(s=>!hasKnownArxivSource(s,[...registered,...discovered]));
            // Each resolver call has a byte/time ceiling; the total deadline bounds the list.
            for(let offset=0;offset<candidates.length;offset+=100){
              discovered.push(...await resolveArxivVersions(candidates.slice(offset,offset+100),{signal:ctx.signal,deadlineAt}));
            }
          }
        }
        const observationFile=resolve(runDir,"inputs/upstream-scans",`${upstream.id}.json`);
        await writeJson(observationFile,{schema_version:"rsi.upstream-scan.v1",upstream_id:upstream.id,commit:head,previous_commit:previous,observations,removed_sources_action:"observation_only"});
        upstreams[upstream.id]={commit:head,previous_commit:previous,changed:head!==previous,files,discovery:relative(runDir,observationFile),discovery_sha256:sha256(await readFile(observationFile))};
      }
      for(const discovery of config.discovery){
        const attemptId=randomUUID(),attemptDir=resolve(runDir,"discovery",discovery.id,attemptId),output=resolve(attemptDir,"result.json"),request=resolve(attemptDir,"request.json");
        await writeJson(request,{schema_version:"rsi.discovery-request.v1",run_id:runId,attempt_id:attemptId,upstreams,output});
        const requestSha=sha256(await readFile(request)),variables={root:ctx.root,runDir,request,output,requestSha256:requestSha};
        const receipt=await checkedProcess(discovery.command,{cwd:ctx.root,evidenceDir:resolve(attemptDir,"process"),variables,signal:ctx.signal,deadlineAt,stdin:await commandInput(discovery.command,variables,await readFile(request,"utf8"))});
        if(discovery.format==="hf_papers"){
          await writeFile(resolve(attemptDir,"raw.json"),receipt.stdout);
          const payload=JSON.parse(receipt.stdout),rows=hfRows(payload),candidates=normalizeHfPapers(payload);
          const selected=filterRelevant(candidates.map((source,i)=>{const row=rows[i],paper=row?.paper??row;return {source,abstract:String(paper?.summary??paper?.abstract??row?.summary??row?.abstract??"")};}),discovery.relevance);
          await writeJson(resolve(attemptDir,"selection.json"),{...selected,sources:undefined,raw_sha256:sha256(receipt.stdout),run_id:runId,request_sha256:requestSha});
          selections[discovery.id]={counts:selected.counts,receipt:relative(runDir,resolve(attemptDir,"selection.json"))};
          for(let offset=0;offset<selected.sources.length;offset+=100){
            const batch=selected.sources.slice(offset,offset+100);
            discovered.push(...(discovery.resolveVersions?await resolveArxivVersions(batch,{signal:ctx.signal,deadlineAt}):batch));
          }
        }
        else{
          const safeOutput=await noSymlinkPath(runDir,relative(runDir,output)),stat=await lstat(safeOutput);
          if(!stat.isFile()||stat.size>discovery.command.maxOutputBytes)throw new Error("discovery_result_invalid_file");
          const data=await readJson(safeOutput);
          if(data.schema_version!=="rsi.discovery.v1" || data.run_id!==runId || data.request_sha256!==requestSha || data.complete!==true || !Array.isArray(data.sources))throw new Error("source_scan_incomplete_or_unbound");
          const selected=filterRelevant(data.sources.map((s:unknown)=>({source:sourceSchema.parse(s)})),discovery.relevance);
          await writeJson(resolve(attemptDir,"selection.json"),{...selected,sources:undefined,raw_sha256:sha256(await readFile(output)),run_id:runId,request_sha256:requestSha});
          selections[discovery.id]={counts:selected.counts,receipt:relative(runDir,resolve(attemptDir,"selection.json"))};
          discovered.push(...selected.sources);
        }
      }
      const current=await loadSources(ctx.root),merge=mergeDiscovered(current.sources,discovered);
      if(merge.added.length)await writeJson(resolve(ctx.root,SOURCE_MANIFEST),{...current,updated_at:stamp(),sources:merge.sources});
      return {complete:true,upstreams,selections,discovered:discovered.length,added:merge.added.map(s=>s.id),conflicts:merge.conflicts};
    });
    state!.outcome.source_scan_complete=inputs.complete;
    const selection=await phase("selection",async()=>{
      const all=(await loadSources(ctx.root)).sources;
      return all.filter(s=>(!config.sourceIds||config.sourceIds.includes(s.id)) && !(s.kind==="paper"&&!s.version) && cursor.sources[sourceKey(s)]?.source_sha256!==digest(s)).slice(0,config.maxSources);
    });
    state!.selected_sources=selection.map(s=>s.id);await save();
    const prepared:Record<string,unknown>={};
    for(const source of selection){
      const key=sourceKey(source);
      await phase(`fetch-${key}`,async()=>{if(!options.hooks?.fetch)throw new Error("fetch_hook_required");return options.hooks.fetch(source,ctx);});
      prepared[key]=await phase(`prepare-${key}`,async()=>{if(!options.hooks?.prepare)throw new Error("prepare_hook_required");return options.hooks.prepare(source,ctx);});
    }
    let researchProcess:Pick<ProcessResult,"native_session_ids">|undefined;
    if(selection.length){
      const research=await phase("research",async()=>{
        if(!config.research)throw new Error("research_command_required");
        return runWorker(config.research,"research",{sources:selection,prepared,source_manifest_sha256:sha256(await readFile(resolve(ctx.root,SOURCE_MANIFEST)))},ctx);
      });
      researchProcess=research.process;
      await phase("compile",async()=>{
        if(!options.hooks?.compile || !research.result.contribution)throw new Error("contribution_or_compile_hook_missing");
        return options.hooks.compile(research.result.contribution,ctx);
      });
    }
    await phase("lint",async()=>{if(!options.hooks?.lint)throw new Error("lint_hook_required");return completed(await options.hooks.lint(ctx));});
    await phase("build",async()=>{if(!options.hooks?.build)throw new Error("build_hook_required");return completed(await options.hooks.build(ctx));});
    const candidate=await phase("candidate",async()=>{
      if(await git(["rev-parse","HEAD"],ctx.root)!==state!.source_revision)throw new Error("unexpected_worker_commit");
      const changed=[...new Set([...(await git(["diff","--name-only","HEAD","-z"],ctx.root)).split("\0"),...(await git(["ls-files","--others","--exclude-standard","-z"],ctx.root)).split("\0")].filter(Boolean))].sort();
      for(const item of changed){
        if(!publishedPath(item))throw new Error(`daily_nonknowledge_change:${item}`);
        const file=await noSymlinkPath(ctx.root,item);
        if(await exists(file) && /(?:\/Users\/|\/home\/|[A-Za-z]:\\Users\\|file:\/\/\/)/.test(await readFile(file,"utf8")))throw new Error(`private_machine_path_in_candidate:${item}`);
      }
      if(changed.length){await git(["add","--all","--",...changed],ctx.root);await git(["commit","-m",`knowledge: daily RSI update ${runId}`],ctx.root);}
      const commit=await git(["rev-parse","HEAD"],ctx.root),files:Record<string,string|null>={};
      for(const item of changed){const file=await noSymlinkPath(ctx.root,item);files[item]=await exists(file)?sha256(await readFile(file)):null;}
      return {commit,digest:digest(files),files,changed};
    });
    if(candidate.changed.length){
      const review=await phase("verify",async()=>{
        if(!config.verifier)throw new Error("independent_verifier_required");
        const researchReceipt=state!.phases.research?.result as any;
        const result=await runWorker(config.verifier,"verify",{candidate,source_manifest_sha256:sha256(await readFile(resolve(ctx.root,SOURCE_MANIFEST))),sources:selection,prepared,research_result_file:researchReceipt?.result_file ?? null,research_contribution:researchReceipt?.result?.contribution ?? null},ctx);
        const judgment=result.result.review;
        if(!judgment || judgment.candidate_commit!==candidate.commit || judgment.candidate_digest!==candidate.digest || judgment.verdict!=="accept" || judgment.issues.length || (selection.length>0 && judgment.checked_claims<1))throw new Error("candidate_review_not_accepted");
        if(await git(["rev-parse","HEAD"],ctx.root)!==candidate.commit || await git(["status","--porcelain=v1","--untracked-files=all"],ctx.root))throw new Error("candidate_changed_during_review");
        const produced=researchProcess?.native_session_ids ?? [],verified=result.process.native_session_ids;
        if(produced.some(id=>verified.includes(id)))throw new Error("reviewer_is_same_native_session");
        return result;
      });
      await phase("candidate-note",async()=>{
        const note={schema_version:"pouw.v1",outcome:"bounded daily knowledge candidate independently reviewed",candidate_commit:candidate.commit,candidate_digest:candidate.digest,run_id:runId,primary_session_id:process.env.CODEX_THREAD_ID??null,partner_sessions:[...(researchProcess?.native_session_ids??[]).map(id=>({role:"research",session_id:id})),...review.process.native_session_ids.map(id=>({role:"verifier",session_id:id}))],source_raw_session_ids:[...new Set([...(researchProcess?.native_session_ids??[]),...review.process.native_session_ids])],limits:["Native Scheduled acceptance is a separate observation."],evidence_sha256:digest(state!.phases.verify)};
        const file=resolve(runDir,"candidate-pouw.json");await writeJson(file,note);
        await git(["notes","--ref=commits","add","--file",file,candidate.commit],ctx.root);
        const recorded=await git(["notes","--ref=commits","show",candidate.commit],ctx.root);
        if(digest(JSON.parse(recorded))!==digest(note))throw new Error("pouw_note_verification_failed");
        return {commit:candidate.commit,note_sha256:sha256(recorded)};
      });
    }
    state!.outcome.checks_passed=true;await save();
    if(!config.publication?.enabled && (candidate.changed.length || selection.length))throw new Error("publication_disabled_candidate_pending");
    let acceptedRoot=ctx.root,acceptedRevision=candidate.commit;
    if(config.publication?.enabled && candidate.changed.length){
      const published=await phase("publish",()=>publishCandidate(ctx,config,candidate,git,exec));
      state!.outcome.pr_open=published.pr_open;state!.outcome.merged=published.merged;await save();
      if(!published.publication_accepted)throw new Error(`publication_${published.resume_safe?"pending":"blocked"}:${published.reason}`);
      acceptedRevision=published.merge_commit!;
      acceptedRoot=await phase("merged-workspace",async()=>{
        const target=resolve(base,"merged",runId);await git(["worktree","add","--detach",target,acceptedRevision]);return target;
      });
    }else if(config.publication?.enabled){
      // A verified no-change pass observes the current published base, not a new merge.
      const remote=await git(["ls-remote",config.publication.remote,`refs/heads/${config.publication.base}`]);
      if(remote.split(/\s+/)[0]!==candidate.commit)throw new Error("nochange_base_not_published");
      state!.outcome.pr_open=false;state!.outcome.merged=false;
    }
    if(config.projection){
      if(config.publication?.enabled && candidate.changed.length && !state!.outcome.merged)throw new Error("projection_requires_merge");
      const projection=config.projection;
      const projected=await phase("projection",()=>exportKnowledge(acceptedRoot,{...projection,sourceRevision:acceptedRevision,signal:ctx.signal,deadlineAt}));
      state!.outcome.projection_synced=projected.projection_synced;
    }
    await phase("checkpoint",async()=>{
      for(const source of selection)cursor.sources[sourceKey(source)]={source_sha256:digest(source),accepted_revision:acceptedRevision,run_id:runId,at:stamp()};
      for(const [id,item]of Object.entries(inputs.upstreams))cursor.upstreams[id]={...(item as object),run_id:runId};
      cursor.accepted_revision=acceptedRevision;
      await writeJson(resolve(base,"cursor.json"),cursor);
      return {accepted_revision:acceptedRevision,sources:selection.map(sourceKey),no_selected_sources:selection.length===0,no_new_sources:selection.length===0&&inputs.added.length===0,source_scan_complete:true};
    });
    state!.status="completed";await save();return state!;
  }catch(error){
    if(state){state.status=controller.signal.aborted||Date.now()>=deadlineAt?"cancelled":"blocked";state.error=String(error);await save();return state;}
    throw error;
  }finally{clearTimeout(timer);options.signal?.removeEventListener("abort",forward);await release();}
}

async function runWorker(spec:CommandSpec,stage:string,payload:unknown,ctx:DailyContext){
  const dir=resolve(ctx.runDir,"workers",stage,randomUUID()),request=resolve(dir,"request.json"),output=resolve(dir,"result.json");
  const value={schema_version:"rsi.worker-request.v1",run_id:ctx.runId,stage,root:ctx.root,output,payload};
  await writeJson(request,value);
  const requestSha=sha256(await readFile(request));
  const variables={root:ctx.root,runDir:ctx.runDir,request,output,requestSha256:requestSha};
  const proc=await checkedProcess(spec,{cwd:ctx.root,evidenceDir:resolve(dir,"process"),variables,signal:ctx.signal,deadlineAt:ctx.deadlineAt,stdin:await commandInput(spec,variables,`Read request ${request}. Return rsi.worker-result.v1 bound to request_sha256 ${requestSha}; write the JSON result to ${output}.\n`)});
  const st=await lstat(output);if(st.isSymbolicLink()||!st.isFile()||st.size>spec.maxOutputBytes)throw new Error("worker_result_invalid_file");
  const result=workerResultSchema.parse(await readJson(output));
  if(result.request_sha256!==requestSha || result.outcome!=="complete")throw new Error("worker_result_not_bound_complete");
  for(const artifact of result.artifacts){const file=await noSymlinkPath(ctx.root,artifact.path);if(sha256(await readFile(file))!==artifact.sha256)throw new Error(`worker_artifact_mismatch:${artifact.path}`);}
  await writeJson(resolve(dir,"validated.json"),{request_sha256:requestSha,result_sha256:sha256(await readFile(output)),native_session_ids_observed:proc.native_session_ids,worker_identity_claims_accepted:false});
  const {stdout:_,stderr:__,...processReceipt}=proc;
  return {result,process:processReceipt,result_file:output};
}

async function publishCandidate(ctx:DailyContext,config:DailyConfig,candidate:{commit:string;digest:string;changed:string[]},git:(args:string[],cwd?:string,label?:string)=>Promise<string>,exec:(argv:string[],cwd?:string,label?:string,deadlineAt?:number)=>Promise<ProcessResult>){
  const pub=config.publication!;
  const remote=await git(["remote","get-url",pub.remote],ctx.root);
  if(![`https://github.com/${pub.repoSlug}`,`https://github.com/${pub.repoSlug}.git`,`git@github.com:${pub.repoSlug}.git`].includes(remote))throw new Error("publication_remote_repo_mismatch");
  if(await git(["rev-parse","HEAD"],ctx.root)!==candidate.commit || await git(["status","--porcelain=v1","--untracked-files=all"],ctx.root))throw new Error("publication_candidate_drift");
  const branch=`${pub.branchPrefix}/${ctx.runId}`;
  const remoteHeads=await git(["ls-remote",pub.remote,`refs/heads/${branch}`],ctx.root);
  if(remoteHeads && remoteHeads.split(/\s+/)[0]!==candidate.commit)throw new Error("publication_branch_conflict");
  if(!remoteHeads)await git(["push",pub.remote,`${candidate.commit}:refs/heads/${branch}`],ctx.root);
  const gh=async(args:string[],deadline?:number)=>JSON.parse((await exec(["gh",...args,"--repo",pub.repoSlug],ctx.root,"github",deadline)).stdout);
  let rows=await gh(["pr","list","--head",branch,"--base",pub.base,"--state","all","--json","number,url,state,headRefOid"]);
  if(!Array.isArray(rows)||rows.length>1)throw new Error("publication_pr_identity_ambiguous");
  if(!rows.length){
    const body=resolve(ctx.runDir,"pr-body.txt");await writeFile(body,`Source-grounded daily knowledge update.\n\nCandidate: ${candidate.commit}\nCandidate digest: ${candidate.digest}\n\nLocal lint/build and independent changed-claim review passed for this exact candidate. Native Scheduled acceptance is recorded separately.\n`);
    await exec(["gh","pr","create","--repo",pub.repoSlug,"--head",branch,"--base",pub.base,"--title",`knowledge: RSI daily ${ctx.runId}`,"--body-file",body],ctx.root,"pr-create");
    rows=await gh(["pr","list","--head",branch,"--base",pub.base,"--state","all","--json","number,url,state,headRefOid"]);
  }
  if(rows.length!==1 || rows[0].headRefOid!==candidate.commit)throw new Error("publication_pr_head_mismatch");
  const number=String(rows[0].number);
  const waitStarted=Date.now(),waitUntil=Math.min(waitStarted+pub.waitSeconds*1000,ctx.deadlineAt-60_000);
  let polls=0;
  const observe=async()=>{const limit=waitUntil>Date.now()?waitUntil:ctx.deadlineAt;const value=await gh(["pr","view",number,"--json","state,headRefOid,mergeCommit,statusCheckRollup,autoMergeRequest,url"],limit);polls++;if(value.headRefOid!==candidate.commit)throw new Error("publication_check_head_mismatch");return value;};
  let pr=await observe();
  const pending=(reason:string,resume_safe:boolean)=>({pr_open:["OPEN","MERGED"].includes(pr.state),pr_state:pr.state,merged:pr.state==="MERGED",publication_accepted:false,reason,resume_safe,url:pr.url,merge_commit:pr.mergeCommit?.oid??null,polls,wait_ms:Date.now()-waitStarted,required_checks:classifyRequiredChecks(pr.statusCheckRollup??[],pub.requiredChecks)});
  while(true){
    if(!["OPEN","MERGED"].includes(pr.state))return pending("pull_request_closed",false);
    const checks=classifyRequiredChecks(pr.statusCheckRollup??[],pub.requiredChecks);
    if(checks.status==="failed")return pending("required_checks_failed",false);
    if(checks.status==="passed")break;
    if(Date.now()>=waitUntil)return pending("required_checks_pending",true);
    await abortablePause(Math.min(pub.pollSeconds*1000,waitUntil-Date.now()),ctx.signal);pr=await observe();
  }
  if(pr.state!=="MERGED"){
    if(!pub.autoMerge)return pending("automerge_disabled",false);
    if(!pr.autoMergeRequest)await exec(["gh","pr","merge",number,"--repo",pub.repoSlug,"--merge","--auto","--match-head-commit",candidate.commit],ctx.root,"pr-merge");
    pr=await observe();
    while(true){
      if(!["OPEN","MERGED"].includes(pr.state))return pending("pull_request_closed",false);
      const checks=classifyRequiredChecks(pr.statusCheckRollup??[],pub.requiredChecks);
      if(checks.status==="failed")return pending("required_checks_failed",false);
      if(pr.state==="MERGED"&&checks.status==="passed")break;
      if(Date.now()>=waitUntil)return pending(checks.status==="pending"?"required_checks_pending":"automerge_queued",true);
      await abortablePause(Math.min(pub.pollSeconds*1000,waitUntil-Date.now()),ctx.signal);pr=await observe();
    }
  }
  if(!pr.mergeCommit?.oid)throw new Error("merged_commit_identity_unavailable");
  await git(["fetch","--no-tags",pub.remote,pub.base],ctx.root);
  const merged=String(pr.mergeCommit.oid);
  if(await git(["diff",candidate.commit,merged,"--",...candidate.changed],ctx.root))throw new Error("merged_content_differs_from_reviewed_candidate");
  return {pr_open:true,pr_state:pr.state,merged:true,publication_accepted:true,reason:null,resume_safe:false,url:pr.url,merge_commit:merged,polls,wait_ms:Date.now()-waitStarted,required_checks:classifyRequiredChecks(pr.statusCheckRollup??[],pub.requiredChecks)};
}
