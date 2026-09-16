import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { sha256 } from "../src/io.ts";
import { createArxivMetadataClient, normalizeHfPapers, resolveArxivVersions } from "../src/operations/daily.ts";
import { extractArxivReferences, upstreamArxivDelta } from "../src/operations/discovery.ts";

const cleanup:string[]=[];
afterEach(async()=>{for(const item of cleanup.splice(0))await rm(item,{recursive:true,force:true});});
async function fixture(){const root=await realpath(await mkdtemp(resolve(tmpdir(),"rsi-metadata-")));cleanup.push(root);return {root,runId:"metadata-run",runDir:resolve(root,"metadata-run")};}
function client(){let at=0;return createArxivMetadataClient({now:()=>at,pause:async(ms,signal)=>{signal.throwIfAborted();at+=ms;}});}
const source=()=>normalizeHfPapers([{paper:{id:"2607.13104",title:"paper"}}]);
const responseBytes=()=>Buffer.concat([Buffer.from([0xef,0xbb,0xbf]),Buffer.from('<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>http://arxiv.org/abs/2607.13104v3</id><title>  Source-grounded\n Research &amp; Retrieval  </title></entry></feed>')]);
const fakeFetch=(bytes:Buffer)=> (async()=>new Response(new Uint8Array(bytes),{headers:{"content-type":"application/atom+xml;charset=utf-8"}})) as unknown as typeof fetch;

describe("retained Atom metadata and meaningful titles",()=>{
  test("retains exact bytes including BOM and binds matched bibliographic title to evidence",async()=>{
    const context=await fixture(),bytes=responseBytes();
    const [resolved]=await resolveArxivVersions(source(),{metadataClient:client(),fetch:fakeFetch(bytes),evidence:context});
    const provenance=resolved!.provenance!,evidence=provenance.version_lookup_evidence as any;
    expect(resolved!.title).toBe("Source-grounded Research & Retrieval");expect(resolved!.version).toBe("v3");expect(provenance.title_resolution).toBe("arxiv_atom");expect(provenance.title_previous).toEqual({value:"paper",resolution:"provided"});
    expect(evidence.run_id).toBe(context.runId);expect(evidence.path.startsWith("inputs/arxiv-metadata/")).toBe(true);expect(evidence.sha256).toBe(sha256(bytes));expect(provenance.version_lookup_sha256).toBe(sha256(bytes));
    expect(await readFile(resolve(context.runDir,evidence.path))).toEqual(bytes);
    const receiptBytes=await readFile(resolve(context.runDir,evidence.receipt_path)),receipt=JSON.parse(receiptBytes.toString("utf8"));expect(sha256(receiptBytes)).toBe(evidence.receipt_sha256);expect(receipt.body.bytes).toBe(bytes.length);expect(receipt.body.path).toBe(evidence.path);expect(receipt.status).toBe(200);expect(receipt.request_url).toContain("id_list=2607.13104");
    expect(JSON.stringify(provenance)).not.toContain(context.root);
  });
  test("duplicate raw bytes are retained once while acquisitions receive distinct immutable receipts",async()=>{
    const context=await fixture(),bytes=responseBytes(),metadataClient=client(),fetch=fakeFetch(bytes);
    const [a]=await resolveArxivVersions(source(),{metadataClient,fetch,evidence:context}),[b]=await resolveArxivVersions(source(),{metadataClient,fetch,evidence:context});
    const first=a!.provenance!.version_lookup_evidence as any,second=b!.provenance!.version_lookup_evidence as any;
    expect(first.path).toBe(second.path);expect(first.receipt_path).not.toBe(second.receipt_path);expect((await readdir(resolve(context.runDir,"inputs/arxiv-metadata"))).filter(item=>item.endsWith(".xml"))).toHaveLength(1);
    expect(await readFile(resolve(context.runDir,first.path))).toEqual(bytes);
  });
  test("conflicting retained bytes and symlinked evidence roots are not overwritten",async()=>{
    const context=await fixture(),bytes=responseBytes(),metadataClient=client(),fetch=fakeFetch(bytes);
    const [first]=await resolveArxivVersions(source(),{metadataClient,fetch,evidence:context}),record=first!.provenance!.version_lookup_evidence as any;
    await writeFile(resolve(context.runDir,record.path),"foreign edit");
    await expect(resolveArxivVersions(source(),{metadataClient,fetch,evidence:context})).rejects.toThrow("metadata_evidence_conflict");expect(await readFile(resolve(context.runDir,record.path),"utf8")).toBe("foreign edit");
    const other=await fixture(),outside=resolve(other.root,"outside");await mkdir(outside);await mkdir(other.runDir);await symlink(outside,resolve(other.runDir,"inputs"));
    await expect(resolveArxivVersions(source(),{metadataClient:client(),fetch,evidence:other})).rejects.toThrow("symlink_path");expect(await readdir(outside)).toEqual([]);
  });
  test("README Title columns outrank generic paper labels and carry line provenance",()=>{
    const markdown="| Year | 📝 Title | Venue | Paper |\n|---|---|---|---|\n| 2023 | Large Language Models Can Self-Improve | EMNLP | [paper](https://arxiv.org/abs/2210.11610) |\n| 2022 | Large Language Models Are Human-Level Prompt Engineers | arXiv | [paper](https://arxiv.org/abs/2211.01910) |\n";
    const result=upstreamArxivDelta(markdown,null,{upstream_id:"fixture",commit:"a".repeat(40),previous_commit:null,path:"README.md",sha256:sha256(markdown),url:"https://github.com/example/research"});
    expect(result.sources.map(s=>s.title)).toEqual(["Large Language Models Can Self-Improve","Large Language Models Are Human-Level Prompt Engineers"]);expect(result.sources[0]!.provenance?.title_resolution).toBe("upstream_table_title");expect(result.sources[0]!.provenance?.upstream_line).toBe(3);expect(result.sources[1]!.provenance?.title_status).toBe("supplied");
  });
  test("meaningful emphasis repairs generic links and unresolved labels stay explicit",()=>{
    const rows=extractArxivReferences("- **Named method**: [paper](https://arxiv.org/abs/2609.00211)\n- [paper](https://arxiv.org/abs/2609.00212)\n- [Later named title](https://arxiv.org/html/2609.00212)\n- [PDF](https://arxiv.org/pdf/2609.00213.pdf)\n");
    expect(rows[0]!.title).toBe("Named method");expect(rows[1]!.title).toBe("Later named title");expect(rows[2]!.title).toContain("title unresolved");expect(rows[2]!.title_status).toBe("placeholder");expect(rows[2]!.title_resolution).toBe("identifier_placeholder");
  });
  test("ambiguous Atom identities retain original evidence but cannot assign a version",async()=>{
    const context=await fixture(),bytes=Buffer.from('<feed><entry><id>https://arxiv.org/abs/2607.13104v1</id><title>First</title></entry><entry><id>https://arxiv.org/abs/2607.13104v2</id><title>Second</title></entry></feed>');
    await expect(resolveArxivVersions(source(),{metadataClient:client(),fetch:fakeFetch(bytes),evidence:context})).rejects.toThrow("arxiv_metadata_identity_ambiguous");expect(await readFile(resolve(context.runDir,`inputs/arxiv-metadata/${sha256(bytes)}.xml`))).toEqual(bytes);
  });
});
