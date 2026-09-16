import { lstat, readdir, readFile, mkdir, writeFile, rename, unlink, rmdir, open, realpath } from "node:fs/promises";
import { resolve, dirname, relative, parse } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { sha256, readJson, writeJson, noSymlinkPath, confined } from "../io.ts";
import { checkedProcess } from "./process.ts";
import type { CommandSpec } from "./contracts.ts";

export const EXPORT_PATHS = ["README.md", "SPEC.md", "LICENSE", "NOTICE", "NOTICE.txt", "llms.txt", "sources/source-manifest.json", "views/current.json", "manifests", "wiki", "docs", "workflows"];
const RECEIPT = ".rsi-projection.json";
const SHA = /^[a-f0-9]{64}$/;
export interface ExportOptions {
  target: string;
  sourceRevision?: string;
  dryRun?: boolean;
  catalogCommand?: CommandSpec;
  signal?: AbortSignal;
  deadlineAt?: number;
}
interface OwnershipReceipt {
  schema_version: "rsi.projection.v1";
  source_revision: string;
  files: Record<string,string>;
}
async function exists(file:string) {try {await lstat(file);return true;}catch(e:any){if(e.code === "ENOENT")return false;throw e;}}
export async function absoluteNoSymlink(target:string) {
  const absolute=resolve(target), parts=relative(parse(absolute).root,absolute).split("/").filter(Boolean);
  let at=parse(absolute).root;
  for(const part of parts){at=resolve(at,part);try {if((await lstat(at)).isSymbolicLink())throw new Error(`symlink_path:${at}`);}catch(e:any){if(e.code !== "ENOENT")throw e;}}
  return absolute;
}
function publicPath(item:string) {
  if(item.split(/[\\/]/).some(part=>!part || part.startsWith(".") || part === "raw" || part === "auth.json" || /^AGENTS(?:\.override)?\.md$/i.test(part)))return false;
  return EXPORT_PATHS.some(p=>item === p || item.startsWith(`${p}/`));
}
async function collect(root:string) {
  const files:Record<string,Buffer>={};
  async function walk(item:string) {
    const file=await noSymlinkPath(root,item);
    if(!await exists(file))return;
    if(!publicPath(item))throw new Error(`nonpublic_export_path:${item}`);
    const st=await lstat(file);
    if(st.isDirectory()){for(const child of (await readdir(file)).sort())await walk(`${item}/${child}`);return;}
    if(!st.isFile())throw new Error(`unsupported_export_file:${item}`);
    const bytes=await readFile(file);
    if(bytes.includes(0))throw new Error(`binary_export_requires_explicit_policy:${item}`);
    if(/(?:\/Users\/|\/home\/|[A-Za-z]:\\Users\\|file:\/\/\/)/.test(bytes.toString("utf8")))throw new Error(`private_machine_path_in_export:${item}`);
    files[item]=bytes;
  }
  for(const item of EXPORT_PATHS)await walk(item);
  if(!files["README.md"] || !files["llms.txt"] || !files["LICENSE"])throw new Error("export_required_files_missing");
  return files;
}
function parseReceipt(value:unknown):OwnershipReceipt {
  const r=value as OwnershipReceipt;
  if(r?.schema_version !== "rsi.projection.v1" || !/^[a-f0-9]{40}$/.test(r.source_revision) || !r.files || Array.isArray(r.files))throw new Error("invalid_projection_receipt");
  for(const [p,digest]of Object.entries(r.files)){if(!publicPath(p) || !SHA.test(digest))throw new Error("invalid_projection_ownership");confined("/",p);}
  return r;
}

export async function exportKnowledge(root:string, options:ExportOptions) {
  const source=await absoluteNoSymlink(root), target=await absoluteNoSymlink(options.target);
  if(source === target || target.startsWith(`${source}/`) || source.startsWith(`${target}/`))throw new Error("overlapping_projection_roots");
  const evidence=resolve(source,".local/exports",randomUUID());
  const git=async(args:string[]) => (await checkedProcess({argv:["git",...args]}, {cwd:source,evidenceDir:resolve(evidence,randomUUID()),signal:options.signal,deadlineAt:options.deadlineAt})).stdout.trim();
  const revision=await git(["rev-parse","HEAD"]);
  if(options.sourceRevision && options.sourceRevision !== revision)throw new Error("projection_revision_mismatch");
  if(await git(["status","--porcelain=v1","--untracked-files=all","--",...EXPORT_PATHS]))throw new Error("projection_source_dirty");
  const files=await collect(source), hashes=Object.fromEntries(Object.entries(files).map(([p,b])=>[p,sha256(b)]));
  const tree=await git(["ls-tree","-r","-z","--full-tree",revision,"--",...EXPORT_PATHS]);
  const committed:Record<string,string>={};
  for(const entry of tree.split("\0").filter(Boolean)){
    const match=entry.match(/^(\d+) blob ([a-f0-9]{40})\t(.+)$/s);
    if(!match || match[1]!=="100644" && match[1]!=="100755")throw new Error("nonregular_committed_export_entry");
    committed[match[3]!]=match[2]!;
  }
  if(Object.keys(committed).length!==Object.keys(files).length)throw new Error("projection_snapshot_tree_mismatch");
  for(const [p,bytes]of Object.entries(files)){
    const blob=createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
    if(committed[p]!==blob)throw new Error(`projection_snapshot_commit_mismatch:${p}`);
  }
  const receiptPath=await noSymlinkPath(target,RECEIPT);
  const previous=await exists(receiptPath)?parseReceipt(await readJson(receiptPath)):null;
  const removals=Object.keys(previous?.files??{}).filter(p=>!(p in hashes));
  const writes=Object.keys(hashes).filter(p=>previous?.files[p] !== hashes[p]);
  for(const p of new Set([...Object.keys(previous?.files??{}),...Object.keys(hashes)])){
    const targetPath=await noSymlinkPath(target,p), present=await exists(targetPath);
    const owned=previous?.files[p];
    if(owned){if(!present || !(await lstat(targetPath)).isFile() || sha256(await readFile(targetPath)) !== owned)throw new Error(`projection_foreign_edit:${p}`);}
    else if(present)throw new Error(`projection_foreign_collision:${p}`);
  }
  const result={schema_version:"rsi.export-result.v1",source_revision:revision,files:hashes,writes,removals,dry_run:options.dryRun===true,projection_synced:false,catalog_updated:false};
  if(options.dryRun)return result;
  await mkdir(target,{recursive:true});
  const lockPath=await noSymlinkPath(target,".rsi-projection.lock"), lock=await open(lockPath,"wx",0o600);
  const transaction=randomUUID(), previousBytes:Record<string,Buffer|null>={};let receiptCommitted=false;
  try {
    await lock.writeFile(JSON.stringify({pid:process.pid,transaction,started_at:new Date().toISOString()}));
    await mkdir(resolve(evidence,"staged"),{recursive:true});
    for(const p of [...writes,...removals]){
      const dest=await noSymlinkPath(target,p);
      previousBytes[p]=await exists(dest)?await readFile(dest):null;
      if(previous?.files[p] && sha256(previousBytes[p]!) !== previous.files[p])throw new Error(`projection_changed_after_preview:${p}`);
      if(!previous?.files[p] && previousBytes[p]!==null)throw new Error(`projection_collision_after_preview:${p}`);
    }
    for(const p of writes){const temp=confined(resolve(evidence,"staged"),p);await mkdir(dirname(temp),{recursive:true});await writeFile(temp,files[p]!,{flag:"wx"});}
    await writeJson(resolve(evidence,"transaction.json"),{state:"prepared",source_revision:revision,previous,files:hashes,writes,removals});
    for(const p of writes){
      const dest=await noSymlinkPath(target,p);await mkdir(dirname(dest),{recursive:true});
      if(await exists(dest)?sha256(await readFile(dest))!==previous?.files[p]:previous?.files[p]!==undefined)throw new Error(`projection_changed_during_apply:${p}`);
      const temp=`${dest}.${transaction}.tmp`;await writeFile(temp,files[p]!,{flag:"wx"});await rename(temp,dest);
    }
    for(const p of removals){const dest=await noSymlinkPath(target,p);if(sha256(await readFile(dest))!==previous?.files[p])throw new Error(`projection_changed_during_apply:${p}`);await unlink(dest);}
    for(const p of removals){let at=dirname(confined(target,p));while(at!==target){try{await rmdir(at);}catch{break;}at=dirname(at);}}
    await writeJson(receiptPath,{schema_version:"rsi.projection.v1",source_revision:revision,files:hashes} satisfies OwnershipReceipt);
    receiptCommitted=true;
    result.projection_synced=true;
    await writeJson(resolve(evidence,"transaction.json"),{state:"committed",...result});
  } catch(error) {
    for(const [p,bytes] of receiptCommitted?[]:Object.entries(previousBytes).reverse()){
      const dest=await noSymlinkPath(target,p);
      if(await exists(dest)){
        const digest=sha256(await readFile(dest));
        if(digest!==hashes[p] && digest!==previous?.files[p])continue;
      }
      if(bytes===null){if(await exists(dest))await unlink(dest);}else{await mkdir(dirname(dest),{recursive:true});await writeFile(dest,bytes);}
    }
    await writeJson(resolve(evidence,"failure.json"),{error:String(error),rollback:"only_matching_owned_bytes"});
    throw error;
  } finally {await lock.close();await unlink(lockPath);}
  if(options.catalogCommand){
    await checkedProcess(options.catalogCommand,{cwd:source,evidenceDir:resolve(evidence,"catalog"),variables:{target,root:source,revision},signal:options.signal,deadlineAt:options.deadlineAt});
    result.catalog_updated=true;
  }
  await writeJson(resolve(evidence,"result.json"),result);
  return {...result,evidence_dir:relative(source,evidence)};
}
