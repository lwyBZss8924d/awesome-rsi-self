// Deterministic transport fixture. This is never evidence of model or business quality.
import { readFile, writeFile } from "node:fs/promises";
const [mode,requestFile,outputFile,requestSha]=process.argv.slice(2);
if(mode==="discover"){
  await writeFile(outputFile!,JSON.stringify({schema_version:"rsi.discovery.v1",complete:true,sources:[]}));
}else if(mode==="incomplete"){
  await writeFile(outputFile!,JSON.stringify({schema_version:"rsi.discovery.v1",complete:false,sources:[]}));
}else{
  const request=JSON.parse(await readFile(requestFile!,"utf8"));
  const base={schema_version:"rsi.worker-result.v1",request_sha256:requestSha,outcome:"complete",artifacts:[]};
  if(mode==="research")await writeFile(outputFile!,JSON.stringify({...base,contribution:{fixture:true}}));
  if(mode==="verify"||mode==="wrong-review")await writeFile(outputFile!,JSON.stringify({...base,review:{candidate_commit:mode==="wrong-review"?"0".repeat(40):request.payload.candidate.commit,candidate_digest:request.payload.candidate.digest,verdict:"accept",checked_claims:1,issues:[]}}));
}
