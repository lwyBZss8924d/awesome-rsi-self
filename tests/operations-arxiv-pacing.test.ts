import { describe, expect, test } from "bun:test";
import { createArxivMetadataClient, normalizeHfPapers, resolveArxivVersions } from "../src/operations/daily.ts";

const xml='<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>http://arxiv.org/abs/2607.13104v3</id></entry></feed>';
const papers=()=>normalizeHfPapers([{paper:{id:"2607.13104",title:"Fixture paper"}}]);
function clock(start=0){
  const value={at:start,waits:[] as number[]};
  return {value,now:()=>value.at,pause:async(ms:number,signal:AbortSignal)=>{signal.throwIfAborted();value.waits.push(ms);value.at+=ms;signal.throwIfAborted();}};
}
const transport=(callback:(url:any,init:any)=>Promise<Response>)=>callback as unknown as typeof fetch;

describe("shared arXiv metadata pacing",()=>{
  test("separate upstream and HF resolver calls share the same 3-second request gate",async()=>{
    const time=clock(),client=createArxivMetadataClient(time),starts:number[]=[];
    const fetch=transport(async()=>{starts.push(time.now());return new Response(xml);});
    const first=await resolveArxivVersions(papers(),{metadataClient:client,fetch});
    time.value.at+=2304; // A bounded HF CLI call between the two independent source loops.
    const second=await resolveArxivVersions(papers(),{metadataClient:client,fetch});
    expect(starts).toEqual([0,3000]);expect(time.value.waits).toEqual([696]);expect(first[0]!.version).toBe("v3");expect(second[0]!.version).toBe("v3");
  });
  test("a concurrent next request waits for the prior response body and its cooldown",async()=>{
    const time=clock(),client=createArxivMetadataClient(time),starts:number[]=[];let body!:ReadableStreamDefaultController<Uint8Array>,ready!:()=>void;
    const firstStarted=new Promise<void>(resolve=>{ready=resolve;});
    const fetch=transport(async()=>{
      starts.push(time.now());
      if(starts.length===1)return new Response(new ReadableStream<Uint8Array>({start(controller){body=controller;ready();}}));
      return new Response(xml);
    });
    const first=resolveArxivVersions(papers(),{metadataClient:client,fetch,deadlineAt:20_000});await firstStarted;
    time.value.at=1000;const second=resolveArxivVersions(papers(),{metadataClient:client,fetch,deadlineAt:20_000});await Promise.resolve();expect(starts).toEqual([0]);
    time.value.at=5000;body.enqueue(new TextEncoder().encode(xml));body.close();await Promise.all([first,second]);
    expect(starts).toEqual([0,8000]);expect(time.value.waits).toEqual([3000]);
  });
  test("Retry-After seconds and HTTP date are honored by the one allowed retry",async()=>{
    for(const kind of ["seconds","date"]){
      const start=Date.UTC(2026,8,16,9,31,40),time=clock(start),client=createArxivMetadataClient(time),starts:number[]=[];
      const retryAfter=kind==="seconds"?"7":new Date(start+7000).toUTCString();
      const fetch=transport(async()=>{starts.push(time.now());return starts.length===1?new Response("rate limited",{status:429,headers:{"Retry-After":retryAfter}}):new Response(xml);});
      const result=await resolveArxivVersions(papers(),{metadataClient:client,fetch,deadlineAt:start+20_000});
      expect(starts).toEqual([start,start+7000]);expect(result[0]!.version).toBe("v3");
    }
  });
  test("a second 429 remains an error and cannot cause a third attempt",async()=>{
    const time=clock(),client=createArxivMetadataClient(time),starts:number[]=[];
    const fetch=transport(async()=>{starts.push(time.now());return new Response("rate limited",{status:429,headers:{"Retry-After":"0"}});});
    await expect(resolveArxivVersions(papers(),{metadataClient:client,fetch,deadlineAt:20_000})).rejects.toThrow("arxiv_version_lookup_http:429");
    expect(starts).toEqual([0,3000]);
  });
  test("Retry-After beyond the remaining deadline blocks without retry or skipped success",async()=>{
    const time=clock(),client=createArxivMetadataClient(time);let requests=0;
    const fetch=transport(async()=>{requests++;return new Response("rate limited",{status:429,headers:{"Retry-After":"8"}});});
    await expect(resolveArxivVersions(papers(),{metadataClient:client,fetch,deadlineAt:5000})).rejects.toThrow("arxiv_version_lookup_http:429:retry_after_exceeds_deadline");
    expect(requests).toBe(1);expect(time.value.waits).toEqual([]);
  });
  test("an already exhausted deadline never starts a request",async()=>{
    const time=clock(5000),client=createArxivMetadataClient(time);let requests=0;
    const fetch=transport(async()=>{requests++;return new Response(xml);});
    await expect(resolveArxivVersions(papers(),{metadataClient:client,fetch,deadlineAt:5000})).rejects.toThrow("run_budget_exhausted");expect(requests).toBe(0);
  });
  test("abort while waiting to retry prevents the retry",async()=>{
    const time=clock(),abort=new AbortController();let requests=0;
    const client=createArxivMetadataClient({now:time.now,pause:async()=>{abort.abort(new Error("cancelled-by-owner"));abort.signal.throwIfAborted();}});
    const fetch=transport(async()=>{requests++;return new Response("rate limited",{status:429});});
    await expect(resolveArxivVersions(papers(),{metadataClient:client,fetch,signal:abort.signal,deadlineAt:20_000})).rejects.toThrow("cancelled-by-owner");expect(requests).toBe(1);
  });
  test("queued cancellation neither starts HTTP nor lets a later caller bypass the active stream",async()=>{
    const time=clock(),client=createArxivMetadataClient(time),starts:number[]=[];let body!:ReadableStreamDefaultController<Uint8Array>,ready!:()=>void;
    const firstStarted=new Promise<void>(resolve=>{ready=resolve;});
    const fetch=transport(async()=>{starts.push(time.now());if(starts.length===1)return new Response(new ReadableStream<Uint8Array>({start(c){body=c;ready();}}));return new Response(xml);});
    const first=resolveArxivVersions(papers(),{metadataClient:client,fetch,deadlineAt:20_000});await firstStarted;
    const abort=new AbortController(),queued=resolveArxivVersions(papers(),{metadataClient:client,fetch,signal:abort.signal,deadlineAt:20_000});abort.abort(new Error("queued-cancelled"));
    await expect(queued).rejects.toThrow("queued-cancelled");const third=resolveArxivVersions(papers(),{metadataClient:client,fetch,deadlineAt:20_000});await Promise.resolve();expect(starts).toEqual([0]);
    time.value.at=2000;body.enqueue(new TextEncoder().encode(xml));body.close();await Promise.all([first,third]);expect(starts).toEqual([0,5000]);
  });
  test("non-429 HTTP errors and unavailable versions are never retried or fabricated",async()=>{
    const time=clock(),client=createArxivMetadataClient(time);let requests=0;
    await expect(resolveArxivVersions(papers(),{metadataClient:client,fetch:transport(async()=>{requests++;return new Response("unavailable",{status:503});})})).rejects.toThrow("arxiv_version_lookup_http:503");expect(requests).toBe(1);
    await expect(resolveArxivVersions(papers(),{metadataClient:client,fetch:transport(async()=>{requests++;return new Response("<feed/>");})})).rejects.toThrow("arxiv_version_unavailable");expect(requests).toBe(2);
  });
});
