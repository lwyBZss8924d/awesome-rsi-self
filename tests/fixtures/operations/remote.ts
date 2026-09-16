// Simulated GitHub transport; local Git operations still use the real Git binary.
import { readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
const args=process.argv.slice(2),file=process.env.RSI_TEST_REMOTE_STATE!;
const state=JSON.parse(await readFile(file,"utf8"));
const save=()=>writeFile(file,JSON.stringify(state));
const kind=process.argv[1]!.split("/").at(-1);
if(kind==="git"){
  if(args[0]==="ls-remote"){
    const ref=args[2]!,sha=ref.endsWith("/main")?state.base:state.head;
    if(sha)console.log(`${sha}\t${ref}`);
  }else if(args[0]==="push"){
    state.pushes++;state.head=args[2]!.split(":")[0];await save();
  }else if(args[0]==="fetch"){
    // Objects already exist locally; simulate only the transport's FETCH_HEAD update.
    const target=spawnSync(process.env.RSI_TEST_REAL_GIT!,["rev-parse","--git-path","FETCH_HEAD"],{encoding:"utf8"});
    await writeFile(resolve(process.cwd(),target.stdout.trim()),`${state.base}\t\tfixture\n`);
  }else{
    const child=spawnSync(process.env.RSI_TEST_REAL_GIT!,args,{stdio:"inherit"});process.exit(child.status??1);
  }
}else if(kind==="gh"){
  if(args[1]==="view"){
    state.views=(state.views??0)+1;
    if(state.autoChecksAfterViews&&state.views>=state.autoChecksAfterViews)state.checks=true;
    if(state.queued){state.mergeViews=(state.mergeViews??0)+1;if(state.mergeViews>=state.mergeAfterViews){state.merged=true;state.base=state.head;}}
    await save();
  }
  const base={number:1,url:"https://github.com/fixture/wiki/pull/1",state:state.merged?"MERGED":"OPEN",headRefOid:state.wrongHead?"0".repeat(40):state.head};
  if(args[1]==="list")console.log(JSON.stringify(state.pr?[base]:[]));
  else if(args[1]==="create"){state.creates++;state.pr=true;await save();console.log(base.url);}
  else if(args[1]==="view")console.log(JSON.stringify({...base,mergeCommit:state.merged?{oid:state.head}:null,autoMergeRequest:state.queued?{enabledAt:"fixture"}:null,statusCheckRollup:[{name:"check",conclusion:state.merged&&state.postMergeConclusion?state.postMergeConclusion:state.checkConclusion??(state.checks?"SUCCESS":"PENDING")}]}));
  else if(args[1]==="merge"){state.merges++;if(state.mergeAfterViews){state.queued=true;}else{state.merged=true;state.base=state.head;}await save();}
  else throw new Error(`unsupported fixture gh invocation ${JSON.stringify(args)}`);
}
