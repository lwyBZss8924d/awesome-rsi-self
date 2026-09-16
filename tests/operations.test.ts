import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath, symlink, unlink, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { dailyPlan, runDaily, normalizeHfPapers, resolveArxivVersions, mergeDiscovered, exportKnowledge, type DailyConfigInput } from "../src/operations/index.ts";
import { boundedProcess } from "../src/operations/process.ts";
import { sourceSchema } from "../src/contracts.ts";

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
  test("real local Git candidate, fixture workers, separate outcome axes and idempotency",async()=>{
    const root=await repo(),count={compile:0},cfg=config();
    const plan=await dailyPlan(root,cfg);expect(plan.sources).toHaveLength(1);
    const result=await runDaily(root,cfg,{runId:"fixture-day",hooks:hooks(count)});
    expect(result.status).toBe("completed");expect(result.outcome.checks_passed).toBe(true);expect(result.outcome.pr_open).toBe(false);expect(result.outcome.merged).toBe(false);expect(result.outcome.native_scheduled_accepted).toBe(false);
    const repeated=await runDaily(root,cfg,{runId:"fixture-day",hooks:hooks(count)});expect(repeated.status).toBe("completed");expect(count.compile).toBe(1);
    expect((await dailyPlan(root,cfg)).pending_sources).toBe(0);
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
