import { mkdir, readFile, readdir, lstat, open, unlink, writeFile } from "node:fs/promises";
import { resolve, relative, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { DOMParser } from "linkedom";
import { sourceSchema, sourceKey, SOURCE_MANIFEST, type Source } from "../contracts.ts";
import { readJson, writeJson, loadSources, sha256, noSymlinkPath } from "../io.ts";
import { dailyConfigSchema, workerResultSchema, type DailyConfigInput, type DailyConfig, type DailyState, type DailyOptions, type DailyContext, type CommandSpec } from "./contracts.ts";
import { checkedProcess, commandInput, type ProcessResult } from "./process.ts";
import { absoluteNoSymlink, EXPORT_PATHS, exportKnowledge } from "./projection.ts";

const stamp=()=>new Date().toISOString();
const digest=(value:unknown)=>sha256(JSON.stringify(value));
const idPattern=/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/;
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
  const payload=value as any;
  const rows=Array.isArray(payload)?payload:(payload?.papers ?? payload?.items ?? payload?.data);
  if(!Array.isArray(rows))throw new Error("hf_response_not_a_paper_list");
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

export async function resolveArxivVersions(candidates:Source[],options:{signal?:AbortSignal;deadlineAt?:number;fetch?:typeof fetch}={}){
  const unresolved=candidates.filter(s=>s.kind==="paper"&&!s.version);
  if(!unresolved.length)return candidates;
  const ids=unresolved.map(s=>s.urls.canonical.match(/\/abs\/(\d{4}\.\d{4,5})$/)?.[1]);
  if(ids.some(id=>!id))throw new Error("version_resolution_requires_arxiv_id");
  if(ids.length>100)throw new Error("arxiv_version_batch_exceeds_100");
  const milliseconds=Math.min(30000,(options.deadlineAt??Infinity)-Date.now());
  if(milliseconds<=0)throw new Error("run_budget_exhausted");
  const signal=options.signal?AbortSignal.any([options.signal,AbortSignal.timeout(milliseconds)]):AbortSignal.timeout(milliseconds);
  const url=`https://export.arxiv.org/api/query?id_list=${ids.join(",")}&max_results=${ids.length}`;
  const response=await (options.fetch??globalThis.fetch)(url,{signal,headers:{Accept:"application/atom+xml"}});
  if(!response.ok)throw new Error(`arxiv_version_lookup_http:${response.status}`);
  const reader=response.body?.getReader();if(!reader)throw new Error("arxiv_version_response_missing");
  const chunks:Uint8Array[]=[];let total=0;
  try{while(true){const next=await reader.read();if(next.done)break;total+=next.value.byteLength;if(total>2*1024*1024)throw new Error("arxiv_version_response_limit");chunks.push(next.value);}}
  finally{await reader.cancel().catch(()=>{});}
  const xml=Buffer.concat(chunks).toString("utf8"),doc=new DOMParser().parseFromString(xml,"text/xml");
  const resolved=new Map<string,string>();
  for(const entry of Array.from(doc.getElementsByTagName("entry"))){const identifier=entry.getElementsByTagName("id")[0]?.textContent?.trim();const match=identifier?.match(/\/abs\/(\d{4}\.\d{4,5})(v\d+)$/);if(match)resolved.set(match[1]!,match[2]!);}
  return candidates.map(s=>{
    if(s.kind!=="paper"||s.version)return s;
    const id=s.urls.canonical.match(/\/abs\/(\d{4}\.\d{4,5})$/)![1]!,version=resolved.get(id);
    if(!version)throw new Error(`arxiv_version_unavailable:${id}`);
    return sourceSchema.parse({...s,id:`arxiv-${id}-${version}`,version,urls:{canonical:`https://arxiv.org/abs/${id}${version}`,html:`https://arxiv.org/html/${id}${version}`,tex:`https://arxiv.org/src/${id}${version}`},provenance:{...s.provenance,version_resolution:"arxiv_atom",version_lookup_url:url,version_lookup_sha256:sha256(xml)}});
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
async function takeLock(base:string, runId:string, resume:boolean){
  const file=resolve(base,"lock.json"),token=randomUUID();await mkdir(base,{recursive:true});
  try{const f=await open(file,"wx",0o600);await f.writeFile(JSON.stringify({run_id:runId,pid:process.pid,token,started_at:stamp()}));await f.close();}
  catch(e:any){
    if(e.code!=="EEXIST")throw e;
    const previous=await readJson(file);
    if(!resume || previous.run_id!==runId || !Number.isInteger(previous.pid) || alive(previous.pid))throw new Error("daily_lock_held");
    await assertProcessesQuiescent(resolve(base,"runs",runId));
    await unlink(file);return takeLock(base,runId,false);
  }
  return async()=>{if((await readJson(file)).token===token)await unlink(file);};
}

export async function runDaily(root:string, input:DailyConfigInput, options:DailyOptions={}):Promise<DailyState> {
  root=await absoluteNoSymlink(root);
  const config=dailyConfigSchema.parse(input),runId=options.runId ?? new Date().toISOString().slice(0,10);
  if(!idPattern.test(runId))throw new Error("invalid_run_id");
  const base=await noSymlinkPath(root,".local/daily"),runDir=resolve(base,"runs",runId);
  await noSymlinkPath(root,relative(root,runDir));
  const release=await takeLock(base,runId,options.resume===true),statePath=resolve(runDir,"state.json");
  const controller=new AbortController(),forward=()=>controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort",forward,{once:true});if(options.signal?.aborted)forward();
  const deadlineAt=Date.now()+config.budgetSeconds*1000;
  const timer=setTimeout(()=>controller.abort(new Error("run_budget_exhausted")),config.budgetSeconds*1000);
  let sequence=0,state:DailyState|undefined;
  const exec=async(argv:string[],cwd:string=root,label="command")=>checkedProcess({argv,timeoutSeconds:Math.min(config.budgetSeconds,300)}, {cwd,evidenceDir:resolve(runDir,"processes",`${String(++sequence).padStart(4,"0")}-${label}-${randomUUID().slice(0,8)}`),signal:controller.signal,deadlineAt});
  const git=async(args:string[],cwd:string=root,label="git")=>(await exec(["git",...args],cwd,label)).stdout.trim();
  const save=async()=>{state!.updated_at=stamp();await writeJson(statePath,state);};
  const phase=async<T>(name:string,work:()=>Promise<T>):Promise<T>=>{
    if(controller.signal.aborted)throw new Error("run_cancelled_or_budget_exhausted");
    const old=state!.phases[name];
    if(old?.state==="passed"){
      if(old.result_sha256!==digest(old.result))throw new Error(`phase_receipt_digest_mismatch:${name}`);
      if(name!=="publish" || (old.result as any)?.merged)return old.result as T;
    }
    if(old?.state==="running")throw new Error(`phase_requires_reconciliation:${name}`);
    if(old?.state==="failed" && !options.resume)throw new Error(`explicit_resume_required:${name}`);
    state!.phases[name]={state:"running",started_at:stamp()};await save();
    try{const result=await work();if(controller.signal.aborted)throw new Error("run_cancelled_or_budget_exhausted");state!.phases[name]={...state!.phases[name]!,state:"passed",completed_at:stamp(),result,result_sha256:digest(result)};await save();return result;}
    catch(error){state!.phases[name]={...state!.phases[name]!,state:"failed",completed_at:stamp(),error:String(error)};await save();throw error;}
  };
  try{
    await mkdir(runDir,{recursive:true});
    const revision=await git(["rev-parse","HEAD"]);
    if(!/^[a-f0-9]{40}$/.test(revision))throw new Error("source_commit_required");
    if(await exists(statePath)){
      state=await readJson(statePath);
      if(state!.config_sha256!==digest(config) || state!.source_revision!==revision)throw new Error("resume_source_or_config_drift");
      if(state!.status==="completed")return state!;
      if(!options.resume)throw new Error("explicit_resume_required");
      await assertProcessesQuiescent(runDir);state!.status="running";delete state!.error;
    }else{
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
      const upstreams:Record<string,unknown>={},discovered:Source[]=[];
      for(const upstream of config.upstreams){
        if(!/^(https:\/\/|file:\/\/)/.test(upstream.url) || upstream.ref.startsWith("-") || upstream.ref.includes(".."))throw new Error("unsafe_upstream_address");
        const repo=await noSymlinkPath(root,`.local/daily/upstreams/${upstream.id}.git`);
        if(!await exists(repo))await git(["init","--bare",repo]);
        await git(["--git-dir",repo,"fetch","--no-tags","--depth=1",upstream.url,upstream.ref]);
        const head=await git(["--git-dir",repo,"rev-parse","FETCH_HEAD"]),files:Record<string,{path:string;sha256:string}>={};
        for(const item of upstream.paths){
          const output=await noSymlinkPath(resolve(runDir,"inputs/upstreams",upstream.id),item);
          if(item.startsWith("-")||item.includes(":"))throw new Error("unsafe_upstream_input_path");
          const content=(await exec(["git","--git-dir",repo,"show",`${head}:${item}`],root,"upstream-input")).stdout;
          await mkdir(dirname(output),{recursive:true});await writeFile(output,content);files[item]={path:relative(runDir,output),sha256:sha256(content)};
        }
        const previous=cursor.upstreams[upstream.id]?.commit ?? null;
        upstreams[upstream.id]={commit:head,previous_commit:previous,changed:head!==previous,files};
      }
      for(const discovery of config.discovery){
        const output=resolve(runDir,"inputs",`${discovery.id}.json`),request=resolve(runDir,"inputs",`${discovery.id}.request.json`);
        await writeJson(request,{schema_version:"rsi.discovery-request.v1",run_id:runId,upstreams,output});
        const variables={root:ctx.root,runDir,request,output};
        const receipt=await checkedProcess(discovery.command,{cwd:ctx.root,evidenceDir:resolve(runDir,"discovery",discovery.id),variables,signal:ctx.signal,deadlineAt,stdin:await commandInput(discovery.command,variables,await readFile(request,"utf8"))});
        if(discovery.format==="hf_papers"){
          const candidates=normalizeHfPapers(JSON.parse(receipt.stdout));
          discovered.push(...(discovery.resolveVersions?await resolveArxivVersions(candidates,{signal:ctx.signal,deadlineAt}):candidates));
        }
        else{
          const data=await readJson(output);
          if(data.schema_version!=="rsi.discovery.v1" || data.complete!==true || !Array.isArray(data.sources))throw new Error("source_scan_incomplete");
          discovered.push(...data.sources.map((s:unknown)=>sourceSchema.parse(s)));
        }
      }
      const current=await loadSources(ctx.root),merge=mergeDiscovered(current.sources,discovered);
      if(merge.added.length)await writeJson(resolve(ctx.root,SOURCE_MANIFEST),{...current,updated_at:stamp(),sources:merge.sources});
      return {complete:true,upstreams,discovered:discovered.length,added:merge.added.map(s=>s.id),conflicts:merge.conflicts};
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
    let acceptedRoot=ctx.root,acceptedRevision=candidate.commit;
    if(config.publication?.enabled && candidate.changed.length){
      const published=await phase("publish",()=>publishCandidate(ctx,config,candidate,git,exec));
      state!.outcome.pr_open=published.pr_open;state!.outcome.merged=published.merged;await save();
      if(!published.merged)throw new Error(`publication_pending:${published.reason}`);
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
      await writeJson(resolve(base,"cursor.json"),cursor);
      return {accepted_revision:acceptedRevision,sources:selection.map(sourceKey),no_selected_sources:selection.length===0,no_new_sources:selection.length===0&&inputs.added.length===0,source_scan_complete:true};
    });
    state!.status="completed";await save();return state!;
  }catch(error){
    if(state){state.status=controller.signal.aborted?"cancelled":"blocked";state.error=String(error);await save();return state;}
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

async function publishCandidate(ctx:DailyContext,config:DailyConfig,candidate:{commit:string;digest:string;changed:string[]},git:(args:string[],cwd?:string,label?:string)=>Promise<string>,exec:(argv:string[],cwd?:string,label?:string)=>Promise<ProcessResult>){
  const pub=config.publication!;
  const remote=await git(["remote","get-url",pub.remote],ctx.root);
  if(![`https://github.com/${pub.repoSlug}`,`https://github.com/${pub.repoSlug}.git`,`git@github.com:${pub.repoSlug}.git`].includes(remote))throw new Error("publication_remote_repo_mismatch");
  if(await git(["rev-parse","HEAD"],ctx.root)!==candidate.commit || await git(["status","--porcelain=v1","--untracked-files=all"],ctx.root))throw new Error("publication_candidate_drift");
  const branch=`${pub.branchPrefix}/${ctx.runId}`;
  const remoteHeads=await git(["ls-remote",pub.remote,`refs/heads/${branch}`],ctx.root);
  if(remoteHeads && remoteHeads.split(/\s+/)[0]!==candidate.commit)throw new Error("publication_branch_conflict");
  if(!remoteHeads)await git(["push",pub.remote,`${candidate.commit}:refs/heads/${branch}`],ctx.root);
  const gh=async(args:string[])=>JSON.parse((await exec(["gh",...args,"--repo",pub.repoSlug],ctx.root,"github")).stdout);
  let rows=await gh(["pr","list","--head",branch,"--base",pub.base,"--state","all","--json","number,url,state,headRefOid"]);
  if(!Array.isArray(rows)||rows.length>1)throw new Error("publication_pr_identity_ambiguous");
  if(!rows.length){
    const body=resolve(ctx.runDir,"pr-body.txt");await writeFile(body,`Source-grounded daily knowledge update.\n\nCandidate: ${candidate.commit}\nCandidate digest: ${candidate.digest}\n\nLocal lint/build and independent changed-claim review passed for this exact candidate. Native Scheduled acceptance is recorded separately.\n`);
    await exec(["gh","pr","create","--repo",pub.repoSlug,"--head",branch,"--base",pub.base,"--title",`knowledge: RSI daily ${ctx.runId}`,"--body-file",body],ctx.root,"pr-create");
    rows=await gh(["pr","list","--head",branch,"--base",pub.base,"--state","all","--json","number,url,state,headRefOid"]);
  }
  if(rows.length!==1 || rows[0].headRefOid!==candidate.commit)throw new Error("publication_pr_head_mismatch");
  const number=String(rows[0].number);
  let pr=await gh(["pr","view",number,"--json","state,headRefOid,mergeCommit,statusCheckRollup,url"]);
  if(pr.headRefOid!==candidate.commit)throw new Error("publication_check_head_mismatch");
  if(pr.state!=="MERGED"){
    const checks=pr.statusCheckRollup??[];
    const passed=pub.requiredChecks.every(name=>checks.some((c:any)=>(c.name===name||c.context===name)&&(c.conclusion==="SUCCESS"||c.state==="SUCCESS")));
    if(!passed)return {pr_open:true,merged:false,reason:"required_checks_pending_or_failed",url:pr.url,merge_commit:null};
    if(!pub.autoMerge)return {pr_open:true,merged:false,reason:"automerge_disabled",url:pr.url,merge_commit:null};
    await exec(["gh","pr","merge",number,"--repo",pub.repoSlug,"--merge","--auto","--match-head-commit",candidate.commit],ctx.root,"pr-merge");
    pr=await gh(["pr","view",number,"--json","state,headRefOid,mergeCommit,statusCheckRollup,url"]);
  }
  if(pr.headRefOid!==candidate.commit)throw new Error("merged_pr_head_mismatch");
  if(pr.state!=="MERGED"||!pr.mergeCommit?.oid)return {pr_open:true,merged:false,reason:"automerge_queued",url:pr.url,merge_commit:null};
  await git(["fetch","--no-tags",pub.remote,pub.base],ctx.root);
  const merged=String(pr.mergeCommit.oid);
  if(await git(["diff",candidate.commit,merged,"--",...candidate.changed],ctx.root))throw new Error("merged_content_differs_from_reviewed_candidate");
  return {pr_open:true,merged:true,reason:null,url:pr.url,merge_commit:merged};
}
