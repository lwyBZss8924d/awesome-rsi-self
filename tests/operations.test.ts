import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath, symlink, unlink, chmod, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { dailyPlan, runDaily, runScheduledCycle, upstreamArxivDelta, filterRelevant, normalizeHfPapers, resolveArxivVersions, mergeDiscovered, exportKnowledge, type DailyConfigInput } from "../src/operations/index.ts";
import { boundedProcess } from "../src/operations/process.ts";
import { takeDailyLock } from "../src/operations/daily.ts";
import { sourceSchema } from "../src/contracts.ts";
import { createKnowledgeApi, prepareDailySource } from "../src/cli.ts";
import { fetchSource } from "../src/ingest/index.ts";

const roots:string[]=[];
const worker=resolve(import.meta.dir,"fixtures/operations/worker.ts");
afterEach(async()=>{for(const p of roots.splice(0))await rm(p,{recursive:true,force:true});});
async function temp(){const p=await realpath(await mkdtemp(resolve(tmpdir(),"rsi-operations-")));roots.push(p);return p;}
function git(root:string,...args:string[]){const p=spawnSync("git",args,{cwd:root,encoding:"utf8"});if(p.status!==0)throw new Error(p.stderr);return p.stdout.trim();}
const source=sourceSchema.parse({id:"arxiv-2607.13104",kind:"paper",title:"Fixture paper",version:"v1",urls:{canonical:"https://arxiv.org/abs/2607.13104v1",html:"https://arxiv.org/html/2607.13104v1",tex:"https://arxiv.org/src/2607.13104v1"},tags:[]});
async function repo(){
  const root=await temp();await mkdir(resolve(root,"sources"));
  await writeFile(resolve(root,".gitignore"),".local/\n");
  await writeFile(resolve(root,"README.md"),"# Fixture Wiki\n");
  await writeFile(resolve(root,"LICENSE"),"Fixture license\n");
  await writeFile(resolve(root,"llms.txt"),"# Fixture\n\n> Testing.\n\n## Wiki\n");
  await writeFile(resolve(root,"sources/source-manifest.json"),JSON.stringify({schema_version:"rsi.sources.v1",updated_at:"2026-01-01T00:00:00Z",sources:[source]}));
  git(root,"init","-b","main");git(root,"config","user.name","Fixture");git(root,"config","user.email","fixture@example.invalid");
  git(root,"add",".");git(root,"commit","-m","fixture");return root;
}
function config(mode="verify"):DailyConfigInput{return {
  schema_version:"rsi.daily-config.v1",budgetSeconds:30,maxSources:1,
  discovery:[{id:"test",format:"normalized",command:{argv:["bun",worker,"discover","{request}","{output}"]}}],
  research:{argv:["bun",worker,"research","{request}","{output}","{requestSha256}"]},
  verifier:{argv:["bun",worker,mode,"{request}","{output}","{requestSha256}"]},
};}
function hooks(counter={compile:0}){return {
  fetch:async()=>({status:"fixture"}),prepare:async()=>({status:"fixture"}),
  compile:async(_c:unknown,ctx:{root:string})=>{counter.compile++;await mkdir(resolve(ctx.root,"wiki"),{recursive:true});await writeFile(resolve(ctx.root,"wiki/fixture.md"),"# Fixture\nSource-grounded implementation transport test only.\n");return {ok:true};},
  lint:async()=>({ok:true}),build:async()=>({ok:true}),
};}
async function remoteFixture(root:string,overrides:Record<string,unknown>={}){
  git(root,"remote","add","origin","https://github.com/fixture/wiki.git");
  const bin=resolve(root,".local/bin"),stateFile=resolve(root,".local/remote.json");await mkdir(bin,{recursive:true});
  const module=resolve(import.meta.dir,"fixtures/operations/remote.ts");
  for(const command of ["git","gh"]){const file=resolve(bin,command);await writeFile(file,`#!/usr/bin/env bun\nimport ${JSON.stringify(module)};\n`);await chmod(file,0o755);}
  await writeFile(stateFile,JSON.stringify({base:git(root,"rev-parse","HEAD"),head:null,pr:false,merged:false,checks:false,pushes:0,creates:0,merges:0,...overrides}));
  const previous={PATH:process.env.PATH,RSI_TEST_REAL_GIT:process.env.RSI_TEST_REAL_GIT,RSI_TEST_REMOTE_STATE:process.env.RSI_TEST_REMOTE_STATE};
  process.env.RSI_TEST_REAL_GIT=spawnSync("which",["git"],{encoding:"utf8"}).stdout.trim();process.env.RSI_TEST_REMOTE_STATE=stateFile;process.env.PATH=`${bin}:${previous.PATH}`;
  return {stateFile,restore:()=>{for(const [key,value]of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value;}}};
}

describe("bounded process",()=>{
  test("clears inherited native identities and retains bounded stdout",async()=>{
    const root=await temp(),previous=process.env.CODEX_THREAD_ID;process.env.CODEX_THREAD_ID="parent-must-not-leak";
    try{const r=await boundedProcess({argv:["bun","-e","console.log(JSON.stringify({inherited:process.env.CODEX_THREAD_ID??null}))"]},{cwd:root,evidenceDir:resolve(root,"process")});expect(r.status).toBe("exited");expect(JSON.parse(r.stdout).inherited).toBeNull();expect(r.cleared_parent_identity_fields).toContain("CODEX_THREAD_ID");expect(r.quiescent).toBe(true);}finally{if(previous===undefined)delete process.env.CODEX_THREAD_ID;else process.env.CODEX_THREAD_ID=previous;}
  });
  test("times out and reaps only its process group",async()=>{
    const root=await temp();const r=await boundedProcess({argv:["bun","-e","setInterval(()=>{},1000)"],timeoutSeconds:0.1},{cwd:root,evidenceDir:resolve(root,"process")});expect(r.status).toBe("timeout");expect(r.quiescent).toBe(true);
  });
  test("rejects incomplete oversized output",async()=>{
    const root=await temp();const r=await boundedProcess({argv:["bun","-e","console.log('a'.repeat(10000))"],maxOutputBytes:128},{cwd:root,evidenceDir:resolve(root,"process")});expect(r.status).toBe("output_limit");expect(r.output_complete).toBe(false);expect(Buffer.byteLength(r.stdout)).toBeLessThanOrEqual(128);
  });
  test("launch failure writes a terminal receipt without a live child",async()=>{
    const root=await temp();const r=await boundedProcess({argv:["/does-not-exist/rsi-fixture"]},{cwd:root,evidenceDir:resolve(root,"process")});expect(r.status).toBe("failed");expect(r.quiescent).toBe(true);expect(r.launch_error).toBeDefined();expect(JSON.parse(await readFile(resolve(root,"process/process.json"),"utf8")).pid).toBeNull();
  });
});
describe("input discovery",()=>{
  test("missing scan is unavailable and never successful zero",async()=>{
    const root=await repo();const result=await runDaily(root,{schema_version:"rsi.daily-config.v1"},{runId:"no-scan",hooks:hooks()});expect(result.status).toBe("blocked");expect(result.outcome.source_scan_complete).toBe(false);expect(result.error).toContain("source_scan_not_configured");
  });
  test("HF candidates without version remain unresolved",()=>{
    const [candidate]=normalizeHfPapers([{paper:{id:"2607.13104",title:"Paper"}}]);expect(candidate!.version).toBeUndefined();expect(candidate!.urls.tex).toBeUndefined();expect(()=>normalizeHfPapers({failed:true})).toThrow();
  });
  test("discovery cannot silently replace reviewed versions",()=>{
    const r=mergeDiscovered([source],[{...source,version:"v2",urls:{canonical:"https://arxiv.org/abs/2607.13104v2"}}]);expect(r.sources[0]!.version).toBe("v1");expect(r.conflicts).toHaveLength(1);
  });
  test("arXiv Atom binds the exact observed version rather than inventing v1",async()=>{
    const papers=normalizeHfPapers([{paper:{id:"2607.13104",title:"Paper"}}]);
    const mock=(async()=>new Response('<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>http://arxiv.org/abs/2607.13104v3</id></entry></feed>')) as unknown as typeof fetch;
    const result=await resolveArxivVersions(papers,{fetch:mock});expect(result[0]!.id).toBe("arxiv-2607.13104-v3");expect(result[0]!.version).toBe("v3");expect(result[0]!.urls.tex).toEndWith("2607.13104v3");
    const missing=(async()=>new Response('<feed/>')) as unknown as typeof fetch;await expect(resolveArxivVersions(papers,{fetch:missing})).rejects.toThrow("version_unavailable");
  });
});
describe("curated projection",()=>{
  test("preview, apply, repeat and owned deletion preserve foreign files",async()=>{
    const root=await repo(),target=resolve(await temp(),"kb");
    await mkdir(resolve(root,"wiki"));await writeFile(resolve(root,"wiki/old.md"),"# Old\n");git(root,"add",".");git(root,"commit","-m","wiki");
    const preview=await exportKnowledge(root,{target,dryRun:true});expect(preview.writes).toContain("wiki/old.md");
    const first=await exportKnowledge(root,{target});expect(first.projection_synced).toBe(true);
    await writeFile(resolve(target,"foreign.txt"),"owner content");
    const repeat=await exportKnowledge(root,{target});expect(repeat.writes).toEqual([]);
    await unlink(resolve(root,"wiki/old.md"));git(root,"add","-A");git(root,"commit","-m","retire page");
    const updated=await exportKnowledge(root,{target});expect(updated.removals).toEqual(["wiki/old.md"]);expect(await readFile(resolve(target,"foreign.txt"),"utf8")).toBe("owner content");
  });
  test("foreign edits block before overwriting any file",async()=>{
    const root=await repo(),target=resolve(await temp(),"kb");await exportKnowledge(root,{target});await writeFile(resolve(target,"README.md"),"changed by another owner");
    await expect(exportKnowledge(root,{target})).rejects.toThrow("projection_foreign_edit");expect(await readFile(resolve(target,"README.md"),"utf8")).toContain("another owner");
  });
  test("symlink and private machine context cannot be exported",async()=>{
    const root=await repo(),target=resolve(await temp(),"kb");await mkdir(resolve(root,"wiki"));await symlink(resolve(root,"README.md"),resolve(root,"wiki/link.md"));git(root,"add",".");git(root,"commit","-m","symlink");await expect(exportKnowledge(root,{target})).rejects.toThrow("symlink");
    await unlink(resolve(root,"wiki/link.md"));await writeFile(resolve(root,"wiki/private.md"),"owner root /home/someone/private");git(root,"add","-A");git(root,"commit","-m","private");await expect(exportKnowledge(root,{target})).rejects.toThrow("private_machine_path");
  });
  test("source dirty and revision mismatch remain blocking",async()=>{
    const root=await repo(),target=resolve(await temp(),"kb");await expect(exportKnowledge(root,{target,sourceRevision:"0".repeat(40)})).rejects.toThrow("revision_mismatch");await writeFile(resolve(root,"README.md"),"uncommitted");await expect(exportKnowledge(root,{target})).rejects.toThrow("source_dirty");
  });
});
describe("finite daily state machine",()=>{
  test("unpublished candidates remain pending without consuming sources or projecting",async()=>{
    const root=await repo(),count={compile:0},cfg=config();
    const target=resolve(await temp(),"projection");cfg.projection={target};
    await exportKnowledge(root,{target});const original=await readFile(resolve(target,".rsi-projection.json"),"utf8");
    const plan=await dailyPlan(root,cfg);expect(plan.sources).toHaveLength(1);
    const result=await runDaily(root,cfg,{runId:"fixture-day",hooks:hooks(count)});
    expect(result.status).toBe("blocked");expect(result.error).toContain("publication_disabled_candidate_pending");expect(result.outcome.checks_passed).toBe(true);expect(result.outcome.pr_open).toBe(false);expect(result.outcome.merged).toBe(false);expect(result.outcome.native_scheduled_accepted).toBe(false);
    const repeated=await runDaily(root,cfg,{runId:"fixture-day",resume:true,hooks:hooks(count)});expect(repeated.status).toBe("blocked");expect(count.compile).toBe(1);
    const next=await runDaily(root,cfg,{runId:"fixture-next-day",hooks:hooks(count)});expect(next.error).toContain("publication_disabled_candidate_pending");expect((await dailyPlan(root,cfg)).pending_sources).toBe(1);
    expect(await readFile(resolve(target,".rsi-projection.json"),"utf8")).toBe(original);
    expect(git(root,"status","--porcelain")).toBe("");
  },20000);
  test("wrong commit review blocks and does not consume the source",async()=>{
    const root=await repo(),count={compile:0},cfg=config("wrong-review");
    const r=await runDaily(root,cfg,{runId:"bad-review",hooks:hooks(count)});expect(r.status).toBe("blocked");expect(r.error).toContain("review_not_accepted");expect(r.outcome.checks_passed).toBe(false);
    expect((await dailyPlan(root,cfg)).pending_sources).toBe(1);
    const again=await runDaily(root,cfg,{runId:"bad-review",resume:true,hooks:hooks(count)});expect(again.status).toBe("blocked");expect(count.compile).toBe(1);
  },20000);
  test("incomplete discovery fails without research or commit",async()=>{
    const root=await repo(),cfg=config();cfg.discovery![0]!.command.argv[2]="incomplete";
    const r=await runDaily(root,cfg,{runId:"scan-failure",hooks:hooks()});expect(r.status).toBe("blocked");expect(r.error).toContain("scan_incomplete");expect(r.phases.research).toBeUndefined();
  });
  test("live lock cannot be displaced by resume",async()=>{
    const root=await repo();await mkdir(resolve(root,".local/daily"),{recursive:true});await writeFile(resolve(root,".local/daily/lock.json"),JSON.stringify({pid:process.pid,run_id:"locked"}));
    await expect(runDaily(root,config(),{runId:"locked",resume:true,hooks:hooks()})).rejects.toThrow("daily_lock_held");
  });
  test("unexpected code edits cannot be published as Wiki",async()=>{
    const root=await repo(),h=hooks();h.compile=async(_c,ctx)=>{await writeFile(resolve(ctx.root,"runtime.ts"),"// unwanted implementation\n");return {ok:true};};
    const r=await runDaily(root,config(),{runId:"code-edit",hooks:h});expect(r.status).toBe("blocked");expect(r.error).toContain("daily_nonknowledge_change");
  },20000);
  test("pending publication resumes exact head without another research, push or PR",async()=>{
    const root=await repo(),cfg=config(),count={compile:0};
    git(root,"remote","add","origin","https://github.com/fixture/wiki.git");
    cfg.publication={enabled:true,repoSlug:"fixture/wiki",requiredChecks:["check"]};
    const bin=resolve(root,".local/bin"),stateFile=resolve(root,".local/remote.json");await mkdir(bin,{recursive:true});
    const remoteModule=resolve(import.meta.dir,"fixtures/operations/remote.ts");
    for(const command of ["git","gh"]){const file=resolve(bin,command);await writeFile(file,`#!/usr/bin/env bun\nimport ${JSON.stringify(remoteModule)};\n`);await chmod(file,0o755);}
    await writeFile(stateFile,JSON.stringify({base:git(root,"rev-parse","HEAD"),head:null,pr:false,merged:false,checks:false,pushes:0,creates:0,merges:0}));
    const previous={PATH:process.env.PATH,RSI_TEST_REAL_GIT:process.env.RSI_TEST_REAL_GIT,RSI_TEST_REMOTE_STATE:process.env.RSI_TEST_REMOTE_STATE};
    process.env.RSI_TEST_REAL_GIT=spawnSync("which",["git"],{encoding:"utf8"}).stdout.trim();process.env.RSI_TEST_REMOTE_STATE=stateFile;process.env.PATH=`${bin}:${previous.PATH}`;
    try{
      const first=await runDaily(root,cfg,{runId:"pending-ci",hooks:hooks(count)});expect(first.status).toBe("blocked");expect(first.outcome.checks_passed).toBe(true);expect(first.outcome.pr_open).toBe(true);expect(first.outcome.merged).toBe(false);
      const remote=JSON.parse(await readFile(stateFile,"utf8"));remote.checks=true;await writeFile(stateFile,JSON.stringify(remote));
      const resumed=await runDaily(root,cfg,{runId:"pending-ci",resume:true,hooks:hooks(count)});expect(resumed.status).toBe("completed");expect(resumed.outcome.merged).toBe(true);expect(count.compile).toBe(1);
      const final=JSON.parse(await readFile(stateFile,"utf8"));expect(final.pushes).toBe(1);expect(final.creates).toBe(1);expect(final.merges).toBe(1);
    }finally{for(const [key,value]of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
  },20000);
});

describe("review regressions and autonomous discovery",()=>{
  test("upstream links retain exact provenance; removals are only observations",()=>{
    const delta=upstreamArxivDelta("[New](https://arxiv.org/html/2609.00201v2) [same](https://arxiv.org/src/2609.00201v2)\n[Pending](https://arxiv.org/abs/2609.00202)","[Old](https://arxiv.org/abs/2608.00200v1)",{upstream_id:"research",commit:"a".repeat(40),previous_commit:"b".repeat(40),path:"README.md",sha256:"c".repeat(64),url:"https://github.com/example/research"});
    expect(delta.scanned_links).toBe(2);expect(delta.added).toHaveLength(2);expect(delta.removed).toHaveLength(1);expect(delta.sources[1]!.version).toBeUndefined();expect(delta.sources[0]!.provenance?.upstream_line).toBe(1);expect(delta.sources[0]!.provenance?.upstream_commit).toBe("a".repeat(40));
  });
  test("real local upstream scan registers links while one selected source is researched",async()=>{
    const root=await repo(),upstream=await repo(),cfg=config();
    await writeFile(resolve(upstream,"README.md"),"# RSI\n\n[New source](https://arxiv.org/abs/2609.00211v2)\n");git(upstream,"add","README.md");git(upstream,"commit","-m","new reference");
    cfg.upstreams=[{id:"research",url:`file://${upstream}`,paths:["README.md"]}];cfg.sourceIds=[source.id];
    const r=await runDaily(root,cfg,{runId:"upstream",hooks:hooks()});expect(r.outcome.source_scan_complete).toBe(true);expect(r.selected_sources).toEqual([source.id]);
    const registered=JSON.parse(await readFile(resolve(r.worktree,"sources/source-manifest.json"),"utf8"));const added=registered.sources.find((s:any)=>s.id==="arxiv-2609.00211-v2");
    expect(added.provenance.upstream_commit).toBe(git(upstream,"rev-parse","HEAD"));expect(added.provenance.upstream_line).toBe(3);expect(added.version).toBe("v2");
  },10000);
  test("research and verifier receive routes to the original retained Atom responses",async()=>{
    const root=await repo(),upstream=await repo(),cfg=config();
    await writeFile(resolve(upstream,"README.md"),"[Metadata source](https://arxiv.org/abs/2609.00221)\n");git(upstream,"add","README.md");git(upstream,"commit","-m","metadata reference");
    cfg.upstreams=[{id:"research",url:`file://${upstream}`,paths:["README.md"]}];cfg.sourceIds=[source.id];
    const bytes=Buffer.from('<feed><entry><id>https://arxiv.org/abs/2609.00221v2</id><title>Original bibliographic title</title></entry></feed>'),previous=globalThis.fetch;
    globalThis.fetch=(async()=>new Response(new Uint8Array(bytes),{headers:{"content-type":"application/atom+xml"}})) as unknown as typeof fetch;
    try{
      const isolated=new URL("../src/operations/daily.ts",import.meta.url);isolated.search="metadata-route-fixture";
      const {runDaily:run}=await import(isolated.href),result=await run(root,cfg,{runId:"metadata-route",hooks:hooks()});expect(result.outcome.checks_passed).toBe(true);
      const runDir=resolve(root,".local/daily/runs/metadata-route");
      for(const stage of ["research","verify"]){
        const attempt=(await readdir(resolve(runDir,"workers",stage)))[0]!,request=JSON.parse(await readFile(resolve(runDir,"workers",stage,attempt,"request.json"),"utf8"));
        const route=request.payload.metadata_evidence;expect(route.root).toBe(runDir);expect(route.run_id).toBe("metadata-route");expect(route.responses).toHaveLength(1);
        expect(await readFile(resolve(route.root,route.responses[0].path))).toEqual(bytes);expect(await Bun.file(resolve(route.root,route.responses[0].receipt_path)).exists()).toBe(true);
      }
      const registry=JSON.parse(await readFile(resolve(result.worktree,"sources/source-manifest.json"),"utf8")),registered=registry.sources.find((s:any)=>s.id==="arxiv-2609.00221-v2");
      expect(registered.title).toBe("Original bibliographic title");expect(registered.provenance.version_lookup_evidence.run_id).toBe("metadata-route");expect(JSON.stringify(registered)).not.toContain(root);
    }finally{globalThis.fetch=previous;}
  },10000);
  test("HF RAW filtering counts include, defer and exclude before registration",async()=>{
    const root=await repo(),cfg=config();cfg.sourceIds=[source.id];
    cfg.discovery=[{id:"hf",format:"hf_papers",resolveVersions:false,relevance:{includeAny:["self-improving","agent memory"],deferAny:["survey"],excludeAny:["game"],unmatched:"defer"},command:{argv:["bun",worker,"hf","{request}","{output}"]}}];
    const r=await runDaily(root,cfg,{runId:"hf-filter",hooks:hooks()});const scan=r.phases["input-scan"]!.result as any;
    expect(scan.selections.hf.counts).toEqual({scanned:5,include:2,defer:2,exclude:1});expect(scan.added).toEqual(["arxiv-2609.00101-v1","arxiv-2609.00102-v1"]);expect(r.selected_sources).toEqual([source.id]);
    const rawPath=resolve(root,".local/daily/runs/hf-filter",scan.selections.hf.receipt.replace("selection.json","raw.json"));expect(JSON.parse(await readFile(rawPath,"utf8"))).toHaveLength(5);
  },10000);
  test("worker commits cannot hide code or an entirely committed contribution",async()=>{
    for(const mode of ["committed-code","all-committed"]){
      const root=await repo(),h=hooks();h.compile=async(_c,ctx)=>{
        if(mode==="committed-code"){await writeFile(resolve(ctx.root,"runtime.ts"),"// outside publication scope\n");git(ctx.root,"add","runtime.ts");git(ctx.root,"commit","-m","worker runtime");}
        await mkdir(resolve(ctx.root,"wiki"),{recursive:true});await writeFile(resolve(ctx.root,"wiki/committed.md"),"# Worker page\n");
        if(mode==="all-committed"){git(ctx.root,"add","wiki");git(ctx.root,"commit","-m","worker page");}return {ok:true};
      };
      const r=await runDaily(root,config(),{runId:mode,hooks:h});expect(r.error).toContain("unexpected_worker_commit");expect(r.phases.verify).toBeUndefined();expect(r.outcome.checks_passed).toBe(false);
    }
  },10000);
  test("concurrent dead-lock recovery permits exactly one holder",async()=>{
    const root=await temp(),base=resolve(root,"daily");await mkdir(base);await writeFile(resolve(base,"lock.json"),JSON.stringify({pid:2_000_000_000,run_id:"dead",token:"old"}));
    const results=await Promise.allSettled([takeDailyLock(base,"dead",true),takeDailyLock(base,"dead",true)]);expect(results.filter(r=>r.status==="fulfilled")).toHaveLength(1);expect(results.filter(r=>r.status==="rejected")).toHaveLength(1);
    const current=JSON.parse(await readFile(resolve(base,"lock.json"),"utf8"));expect(current.pid).toBe(process.pid);expect(current.token).not.toBe("old");
    for(const result of results)if(result.status==="fulfilled")await result.value();
  });
  test("failed discovery output cannot satisfy a later zero-output attempt",async()=>{
    const root=await repo(),cfg=config();cfg.discovery![0]!.command.argv=["bun",worker,"stale-discovery","{request}","{output}","{requestSha256}","{root}/.local/discovery-marker"];
    const first=await runDaily(root,cfg,{runId:"stale-scan",hooks:hooks()});expect(first.outcome.source_scan_complete).toBe(false);
    const second=await runDaily(root,cfg,{runId:"stale-scan",resume:true,hooks:hooks()});expect(second.outcome.source_scan_complete).toBe(false);expect(second.error).toContain("ENOENT");
    const dir=resolve(root,".local/daily/runs/stale-scan/discovery/test"),attempts=await readdir(dir);expect(attempts).toHaveLength(2);
    const requests=await Promise.all(attempts.map(id=>readFile(resolve(dir,id,"request.json"),"utf8")));expect(requests[0]).not.toBe(requests[1]);
    const results=await Promise.all(attempts.map(async id=>await Bun.file(resolve(dir,id,"result.json")).exists()));expect(results.filter(Boolean)).toHaveLength(1);
  },10000);
  test("render rejects directory and leaf symlinks before touching external targets",async()=>{
    for(const target of ["views","views/current.json","docs","docs/index.html"]){
      const root=await repo(),external=await temp(),outside=resolve(external,"sentinel.txt");await writeFile(outside,"preserve");
      if(target.includes("/")){await mkdir(resolve(root,target.split("/")[0]!));await symlink(outside,resolve(root,target));}else await symlink(external,resolve(root,target));
      const api=createKnowledgeApi(root);await expect(api.call("kb render",{})).rejects.toThrow("symlink_path");expect(await readFile(outside,"utf8")).toBe("preserve");
    }
  });
  test("production prepare adapter cancels and reaps its helper within daily budget",async()=>{
    const root=await repo(),bin=resolve(root,".local/helper-bin"),pidPath=resolve(root,".local/helper.pid");await mkdir(bin,{recursive:true});
    const python=resolve(bin,"python3");await writeFile(python,`#!/usr/bin/env bun\nimport {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(pidPath)},String(process.pid));setInterval(()=>{},1000);\n`);await chmod(python,0o755);
    const previous=process.env.PATH;process.env.PATH=`${bin}:${previous}`;
    try{
      const cfg=config();cfg.budgetSeconds=2;
      const h={...hooks(),fetch:async(s:any,ctx:any)=>fetchSource(ctx.root,s.id,{fetch:(async(url:any)=>new Response(String(url).includes("/html/")?"<article><h1>Fixture</h1><p>Text.</p></article>":"\\documentclass{article}\\begin{document}Fixture\\end{document}",{headers:{"content-type":String(url).includes("/html/")?"text/html":"application/octet-stream"}})) as unknown as typeof fetch}),prepare:async(s:any,ctx:any)=>prepareDailySource(s.id,ctx)};
      const started=Date.now(),r=await runDaily(root,cfg,{runId:"prepare-cancel",hooks:h});expect(r.status).toBe("cancelled");expect(Date.now()-started).toBeLessThan(4000);
      const pid=Number(await readFile(pidPath,"utf8"));expect(()=>process.kill(pid,0)).toThrow();expect(r.phases.research).toBeUndefined();
    }finally{if(previous===undefined)delete process.env.PATH;else process.env.PATH=previous;}
  },6000);
  test("bounded polling observes CI and a queued merge without another run",async()=>{
    const root=await repo(),remote=await remoteFixture(root,{autoChecksAfterViews:3,mergeAfterViews:3}),cfg=config();cfg.budgetSeconds=90;cfg.publication={enabled:true,repoSlug:"fixture/wiki",waitSeconds:1,pollSeconds:0.01};
    try{const r=await runDaily(root,cfg,{runId:"poll",hooks:hooks()});expect(r.status).toBe("completed");expect(r.outcome.merged).toBe(true);const observed=JSON.parse(await readFile(remote.stateFile,"utf8"));expect(observed.views).toBeGreaterThanOrEqual(6);expect(observed.merges).toBe(1);expect((r.phases.publish!.result as any).publication_accepted).toBe(true);}finally{remote.restore();}
  },10000);
  test("externally merged PR with failed CI is observed but never accepted or projected",async()=>{
    const root=await repo(),remote=await remoteFixture(root),cfg=config();cfg.publication={enabled:true,repoSlug:"fixture/wiki",waitSeconds:0};cfg.projection={target:resolve(await temp(),"projection")};
    try{
      const first=await runDaily(root,cfg,{runId:"external-merge",hooks:hooks()});expect(first.outcome.merged).toBe(false);
      const observed=JSON.parse(await readFile(remote.stateFile,"utf8"));observed.merged=true;observed.base=observed.head;observed.checkConclusion="FAILURE";await writeFile(remote.stateFile,JSON.stringify(observed));
      const resumed=await runDaily(root,cfg,{runId:"external-merge",resume:true,hooks:hooks()});expect(resumed.status).toBe("blocked");expect(resumed.outcome.merged).toBe(true);expect(resumed.error).toContain("required_checks_failed");expect((resumed.phases.publish!.result as any).publication_accepted).toBe(false);expect(await Bun.file(resolve(cfg.projection.target,".rsi-projection.json")).exists()).toBe(false);
    }finally{remote.restore();}
  },10000);
  test("dispatch resumes saved publication then requires restart after next-day fast-forward",async()=>{
    const root=await repo(),count={compile:0},remote=await remoteFixture(root),cfg=config();cfg.publication={enabled:true,repoSlug:"fixture/wiki",waitSeconds:0};cfg.projection={target:resolve(await temp(),"projection")};
    try{
      const original=git(root,"rev-parse","HEAD"),first=await runDaily(root,cfg,{runId:"yesterday",hooks:hooks(count)});expect(first.status).toBe("blocked");
      const observed=JSON.parse(await readFile(remote.stateFile,"utf8"));observed.checks=true;await writeFile(remote.stateFile,JSON.stringify(observed));
      const changed={...cfg,sourceIds:["different-preference"]};
      const resumed:any=await runScheduledCycle(root,changed,{runId:"today",hooks:hooks(count)});expect(resumed.action).toBe("resume");expect(resumed.run_id).toBe("yesterday");expect(resumed.config_source).toBe("saved_run");expect(resumed.supplied_config_differs).toBe(true);expect(resumed.run.status).toBe("completed");expect(count.compile).toBe(1);
      const next:any=await runScheduledCycle(root,cfg,{runId:"today",hooks:hooks(count)});expect(next.action).toBe("restart_required");expect(next.run).toBeUndefined();expect(next.source_before.revision).toBe(original);expect(next.source_after.revision).not.toBe(original);expect(next.restart.expected_revision).toBe(next.source_after.revision);expect(await Bun.file(resolve(root,".local/daily/runs/today/state.json")).exists()).toBe(false);expect(await readFile(resolve(root,"wiki/fixture.md"),"utf8")).toContain("Fixture");expect(await readFile(resolve(cfg.projection.target,"wiki/fixture.md"),"utf8")).toContain("Fixture");
      const final=JSON.parse(await readFile(remote.stateFile,"utf8"));expect(final.pushes).toBe(1);expect(final.creates).toBe(1);expect(count.compile).toBe(1);
    }finally{remote.restore();}
  },15000);
  test("runtime-changing fast-forward never invokes previously loaded hooks",async()=>{
    const root=await repo(),runtime=resolve(root,"runtime.mjs");
    await writeFile(runtime,"export const behavior = 'old-runtime';\n");git(root,"add","runtime.mjs");git(root,"commit","-m","old runtime");
    const loaded=await import(`file://${runtime}`),before=git(root,"rev-parse","HEAD");expect(loaded.behavior).toBe("old-runtime");
    git(root,"checkout","-b","incoming-runtime");await writeFile(runtime,"export const behavior = 'new-runtime';\n");git(root,"add","runtime.mjs");git(root,"commit","-m","new runtime");const updated=git(root,"rev-parse","HEAD");git(root,"checkout","main");
    const remote=await remoteFixture(root,{base:updated}),cfg=config();cfg.publication={enabled:true,repoSlug:"fixture/wiki"};let staleCalls=0;
    try{
      const h=hooks();h.fetch=async()=>{staleCalls++;throw new Error(`unexpected ${loaded.behavior}`);};
      const result:any=await runScheduledCycle(root,cfg,{runId:"runtime-advance",hooks:h});
      expect(result.action).toBe("restart_required");expect(result.source_before.revision).toBe(before);expect(result.source_after.revision).toBe(updated);expect(result.restart.expected_revision).toBe(updated);expect(result.restart.remaining_budget_seconds).toBeGreaterThan(0);expect(staleCalls).toBe(0);
      expect(await readFile(runtime,"utf8")).toContain("new-runtime");expect(await Bun.file(resolve(root,".local/daily/runs/runtime-advance/state.json")).exists()).toBe(false);expect(await Bun.file(resolve(root,".local/daily/lock.json")).exists()).toBe(false);
      const receipt=JSON.parse(await readFile(result.record_path,"utf8"));expect(receipt.action).toBe("restart_required");expect(receipt.run).toBeUndefined();
    }finally{remote.restore();}
  },10000);
  test("dispatch evidence symlink is rejected before mkdir or any Git process",async()=>{
    for(const dryRun of [true,false]){
      const root=await repo(),outside=await temp(),sentinel=resolve(outside,"sentinel.txt"),marker=resolve(root,".local/git-called");
      await writeFile(sentinel,"untouched");await mkdir(resolve(root,".local/daily"),{recursive:true});await symlink(outside,resolve(root,".local/daily/dispatch"));
      const bin=resolve(root,".local/git-trap");await mkdir(bin);const trap=resolve(bin,"git");await writeFile(trap,`#!/usr/bin/env bun\nimport {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)},'called');process.exit(71);\n`);await chmod(trap,0o755);
      const previous=process.env.PATH;process.env.PATH=`${bin}:${previous}`;
      try{await expect(runScheduledCycle(root,config(),{dryRun,hooks:hooks()})).rejects.toThrow("symlink_path");expect(await readFile(sentinel,"utf8")).toBe("untouched");expect(await readdir(outside)).toEqual(["sentinel.txt"]);expect(await Bun.file(marker).exists()).toBe(false);expect(await Bun.file(resolve(root,".local/daily/dispatch.lock.json")).exists()).toBe(false);}
      finally{if(previous===undefined)delete process.env.PATH;else process.env.PATH=previous;}
    }
  });
  test("projection retains public navigation context without activating AGENTS",async()=>{
    const root=await repo(),target=resolve(await temp(),"projection");await mkdir(resolve(root,"workflows/daily"),{recursive:true});await writeFile(resolve(root,"SPEC.md"),"# Specification\n");await writeFile(resolve(root,"workflows/daily/llms.txt"),"# Daily\n");await writeFile(resolve(root,"AGENTS.md"),"# Active source instructions\n");git(root,"add",".");git(root,"commit","-m","public contexts");
    await exportKnowledge(root,{target});expect(await Bun.file(resolve(target,"SPEC.md")).exists()).toBe(true);expect(await Bun.file(resolve(target,"workflows/daily/llms.txt")).exists()).toBe(true);expect(await Bun.file(resolve(target,"AGENTS.md")).exists()).toBe(false);
  });
});
