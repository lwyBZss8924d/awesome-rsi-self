// Deterministic transport fixture. This is never evidence of model or business quality.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
const [mode,requestFile,outputFile,requestSha,marker]=process.argv.slice(2);
const requestBytes=await readFile(requestFile!,"utf8"),requestValue=JSON.parse(requestBytes);
const discovery={schema_version:"rsi.discovery.v1",run_id:requestValue.run_id,request_sha256:createHash("sha256").update(requestBytes).digest("hex"),complete:true,sources:[]};
if(mode==="discover"){
  await writeFile(outputFile!,JSON.stringify(discovery));
}else if(mode==="incomplete"){
  await writeFile(outputFile!,JSON.stringify({...discovery,complete:false}));
}else if(mode==="stale-discovery"){
  if(await Bun.file(marker!).exists())process.exit(0);
  await mkdir(dirname(marker!),{recursive:true});await writeFile(marker!,"attempted");await writeFile(outputFile!,JSON.stringify(discovery));process.exit(1);
}else if(mode==="hf"){
  console.log(JSON.stringify([
    {paper:{id:"2609.00101v1",title:"Self-improving agent harness"}},
    {paper:{id:"2609.00102v1",title:"A new method",summary:"Long-horizon agent memory is evaluated."}},
    {paper:{id:"2609.00103v1",title:"A self-improving survey"}},
    {paper:{id:"2609.00104v1",title:"A self-improving game"}},
    {paper:{id:"2609.00105v1",title:"Materials physics"}}
  ]));
}else{
  const request=JSON.parse(await readFile(requestFile!,"utf8"));
  const base={schema_version:"rsi.worker-result.v1",request_sha256:requestSha,outcome:"complete",artifacts:[],notes:["Read-only fixture; dispatcher owns and commits candidate changes. Notes cannot accept a mismatched review."]};
  if(mode==="research")await writeFile(outputFile!,JSON.stringify({...base,contribution:{fixture:true}}));
  if(mode==="verify"||mode==="wrong-review")await writeFile(outputFile!,JSON.stringify({...base,review:{candidate_commit:mode==="wrong-review"?"0".repeat(40):request.payload.candidate.commit,candidate_digest:request.payload.candidate.digest,verdict:"accept",checked_claims:1,issues:[]}}));
}
