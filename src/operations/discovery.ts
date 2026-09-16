import { sourceSchema, type Source } from "../contracts.ts";
import { sha256 } from "../io.ts";
import type { RelevancePolicy } from "./contracts.ts";

export const ARXIV_ID_PATTERN = "(?:\\d{4}\\.\\d{4,5}|[a-z][a-z.-]*/\\d{7})";
export const arxivSourceId = (id:string,version?:string)=>`arxiv-${id.replaceAll("/","-").toLowerCase()}${version?`-${version}`:""}`;
export function arxivIdentity(url:string) {
  const match=url.match(new RegExp(`^https?://(?:www\\.)?arxiv\\.org/(?:abs|html|pdf|src)/(${ARXIV_ID_PATTERN})(v\\d+)?(?:\\.pdf)?(?:[?#].*)?$`,"i"));
  return match?{id:match[1]!,version:match[2]}:null;
}
export interface ArxivReference {id:string;version?:string;title:string;title_status:"supplied"|"placeholder";title_resolution:string;url:string;line:number;line_sha256:string;}
const cleanTitle=(value:string)=>value.replace(/\[([^\]]+)\]\([^)]*\)/g,"$1").replace(/^\*\*|\*\*$/g,"").replace(/\\\|/g,"|").replace(/\s+/g," ").trim();
export function meaningfulDiscoveryTitle(value:string){
  const title=cleanTitle(value);
  return !!title&&!/^(?:paper|pdf|arxiv|abstract|html|full[ -]?text|link|source|tex|here|download|📄)$/i.test(title)&&!/^https?:\/\//i.test(title)&&!/^arXiv .+\(title unresolved\)$/.test(title);
}
export function extractArxivReferences(markdown:string):ArxivReference[] {
  const found=new Map<string,ArxivReference>();let titleColumn:number|null=null;
  for(const [offset,line] of markdown.split(/\r?\n/).entries()){
    const trimmed=line.trim(),cells=trimmed.startsWith("|")?trimmed.replace(/^\||\|$/g,"").split(/(?<!\\)\|/).map(cleanTitle):null;
    if(cells){const header=cells.findIndex(cell=>/^[^\p{L}\p{N}]*(?:paper\s+)?title$/iu.test(cell));if(header>=0&&!/https?:\/\//.test(line))titleColumn=header;}
    else titleColumn=null;
    const pattern=new RegExp(`https?://(?:www\\.)?arxiv\\.org/(?:abs|html|pdf|src)/(${ARXIV_ID_PATTERN})(v\\d+)?(?:\\.pdf)?`,"gi");
    for(const match of line.matchAll(pattern)){
      const id=match[1]!,version=match[2],key=`${id.toLowerCase()}@${version??"unversioned"}`;
      const link=[...line.matchAll(/\[([^\]]+)\]\(([^\s)]+)\)/g)].find(item=>item[2]===match[0]);
      const candidates=[{value:cells&&titleColumn!==null?cells[titleColumn]:undefined,method:"upstream_table_title"},{value:link?.[1],method:"upstream_named_link"},{value:line.match(/\*\*([^*]+)\*\*/)?.[1],method:"upstream_emphasis"}];
      const supplied=candidates.find(item=>item.value&&meaningfulDiscoveryTitle(item.value));
      const title=supplied?cleanTitle(supplied.value!):`arXiv ${id}${version??""} (title unresolved)`;
      if(found.has(key)&&(found.get(key)!.title_status==="supplied"||!supplied))continue;
      found.set(key,{id,version,title,title_status:supplied?"supplied":"placeholder",title_resolution:supplied?.method??"identifier_placeholder",url:match[0],line:offset+1,line_sha256:sha256(line)});
    }
  }
  return [...found.values()];
}
export function upstreamArxivDelta(current:string,previous:string|null, provenance:{upstream_id:string;commit:string;previous_commit:string|null;path:string;sha256:string;url:string}){
  const before=extractArxivReferences(previous??""),after=extractArxivReferences(current);
  const key=(r:ArxivReference)=>`${r.id.toLowerCase()}@${r.version??"unversioned"}`;
  const oldKeys=new Set(before.map(key)),newKeys=new Set(after.map(key));
  const sources=after.map(ref=>sourceSchema.parse({
    id:arxivSourceId(ref.id,ref.version),kind:"paper",title:ref.title,version:ref.version,
    urls:{canonical:`https://arxiv.org/abs/${ref.id}${ref.version??""}`,...(ref.version?{html:`https://arxiv.org/html/${ref.id}${ref.version}`,tex:`https://arxiv.org/src/${ref.id}${ref.version}`}:{})},
    tags:["upstream-discovery"],
    provenance:{discovered_by:"upstream-arxiv-links",upstream_id:provenance.upstream_id,upstream_commit:provenance.commit,upstream_previous_commit:provenance.previous_commit,
      upstream_path:provenance.path,upstream_file_sha256:provenance.sha256,upstream_line:ref.line,upstream_line_sha256:ref.line_sha256,
      title_status:ref.title_status,title_resolution:ref.title_resolution,
      ...(provenance.url.startsWith("https://")?{upstream_url:provenance.url}:{}),version_resolution:ref.version?"explicit":"pending"},
  }));
  return {schema_version:"rsi.upstream-discovery.v1",bootstrap:previous===null,scanned_links:after.length,added:after.filter(r=>!oldKeys.has(key(r))),removed:before.filter(r=>!newKeys.has(key(r))),unchanged:after.filter(r=>oldKeys.has(key(r))).length,sources};
}
export function hasKnownArxivSource(candidate:Source,existing:Source[]){
  const wanted=arxivIdentity(candidate.urls.canonical);
  return existing.some(source=>{
    if(source.id===candidate.id || source.urls.canonical===candidate.urls.canonical)return true;
    const known=arxivIdentity(source.urls.canonical);
    return !!wanted&&!wanted.version&&!!known&&known.id.toLowerCase()===wanted.id.toLowerCase();
  });
}
export function hfRows(value:unknown):any[]{
  const payload=value as any,rows=Array.isArray(payload)?payload:(payload?.papers??payload?.items??payload?.data);
  if(!Array.isArray(rows))throw new Error("hf_response_not_a_paper_list");return rows;
}
export function filterRelevant(candidates:{source:Source;abstract?:string}[],policy?:RelevancePolicy){
  const decisions=candidates.map(({source,abstract=""})=>{
    const fields={title:source.title,abstract};
    const matches=(terms:string[])=>Object.entries(fields).flatMap(([field,text])=>terms.filter(term=>text.toLocaleLowerCase().includes(term.toLocaleLowerCase())).map(term=>({field,term})));
    const exclude=matches(policy?.excludeAny??[]),defer=matches(policy?.deferAny??[]),include=matches(policy?.includeAny??[]);
    const decision=exclude.length?"exclude":defer.length?"defer":!policy||include.length?"include":policy.unmatched;
    return {id:source.id,decision,matched:exclude.length?exclude:defer.length?defer:include,input_sha256:sha256(JSON.stringify(fields)),policy_sha256:sha256(JSON.stringify(policy??null))};
  });
  return {schema_version:"rsi.discovery-selection.v1",counts:{scanned:candidates.length,include:decisions.filter(d=>d.decision==="include").length,defer:decisions.filter(d=>d.decision==="defer").length,exclude:decisions.filter(d=>d.decision==="exclude").length},decisions,
    sources:candidates.filter((_,i)=>decisions[i]!.decision==="include").map(({source},i)=>source)};
}
