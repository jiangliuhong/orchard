import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { TestStore, temporary } from "./helpers.js";
import { ConfigRestoreService } from "../src/config-git/restore.js";
import { serializeSnapshot, parseSnapshot, exportSnapshot, refreshManifest, portableScriptHash, type PortableSnapshot, type PortableDictionary } from "../src/config-git/snapshot.js";
import { encryptValue, generateKeyMaterial } from "../src/secrets/aead.js";
import { KeyringStore, resolveKeyringPath } from "../src/secrets/keyring.js";
const code = (c: string) => (e: any) => e.code === c;
function dictionary(): PortableDictionary { const id = randomUUID(), versionId = randomUUID(); return { id, kind: "plain", currentVersionId: versionId, versions: [{ id: versionId, dictionaryId: id, kind: "plain", name: "Settings", description: "", enabled: true, entries: { baseUrl: { type: "string", value: "https://example.com" }, removeMe: { type: "number", value: 10 } } }] }; }
function snapshot(d = dictionary()): PortableSnapshot { return { dictionaries: [d], general: { theme: "dark" }, providers: [], webBridge: { applications: {}, environments: {}, tools: {}, enabledTools: {} }, scripts: [], workflows: [] }; }
function setup(t: any) { const store = new TestStore(temporary(t)); t.after(() => store.close()); return { store, restore: new ConfigRestoreService(store) }; }
test("v2 dictionary file tree is stable and roundtrips, v1 retains strict format guards", () => {
 const s = snapshot(), b = serializeSnapshot(s); assert.equal(b.manifest.formatVersion, 2); assert.ok(b.manifest.categories.includes("dictionaries")); assert.deepEqual(serializeSnapshot(parseSnapshot(b.files)).files, b.files); assert.deepEqual(refreshManifest(b.files).files, b.files);
 const legacy = structuredClone(s); delete legacy.dictionaries; assert.equal(serializeSnapshot(legacy).manifest.formatVersion, 1);
 const files = { ...b.files, "manifest.json": b.files["manifest.json"]!.replace('"formatVersion":2', '"formatVersion":1') }; assert.throws(() => parseSnapshot(files));
});
test("dictionary restore preserves identity, local sequence, history and current pointer, conflicts block atomically", async t => {
 const {store, restore} = setup(t), s = snapshot(), d = s.dictionaries![0]!;
 await restore.apply("first", (await restore.preview(s, { categories: ["dictionaries"] })).token);
 assert.equal(store.one("SELECT revision FROM dictionaries WHERE id=?", d.id)!.revision, 1);
 assert.equal((await restore.preview(s, {categories:["dictionaries"]})).changes[0]!.changeType, "same");
 const old = d.currentVersionId; d.currentVersionId = randomUUID(); d.versions = [{...d.versions[0]!, id:d.currentVersionId, entries:{ baseUrl:{type:"string",value:"new"} }}];
 await restore.apply("second", (await restore.preview(s, {categories:["dictionaries"]})).token);
 assert.equal(store.one("SELECT count(*) n FROM dictionary_versions")!.n, 2); assert.equal(store.one("SELECT version_no FROM dictionary_versions WHERE id=?", d.currentVersionId)!.version_no, 2);
 const recovery = restore.recoveryPoints().find(p => p.id === restore.operations()[1]!.recoveryPointId)!;
 await restore.apply("undo", (await restore.previewRecoveryPoint(recovery.id)).token);
 assert.equal(store.one("SELECT current_version_id FROM dictionaries WHERE id=?",d.id)!.current_version_id, old);
 assert.equal(store.one("SELECT count(*) n FROM dictionary_versions")!.n, 2);
 const conflict = structuredClone(s); conflict.dictionaries![0]!.versions[0]!.description = "changed";
 await assert.rejects(restore.preview(conflict, {categories:["dictionaries"]}), code("VERSION_ID_CONFLICT"));
 const other = snapshot(); await assert.rejects(restore.preview(other, {categories:["dictionaries"]}), code("IDENTITY_CONFLICT"));
 const exported = exportSnapshot(store, { ...s.webBridge }, "dark"); assert.equal(exported.manifest.formatVersion,2); assert.equal(exported.snapshot.dictionaries![0]!.versions.length,1);
});
test("missing keys and authentication failures block selected dictionaries, unrelated categories remain usable and key changes expire previews", async t => {
 const {store,restore} = setup(t), d = dictionary(), material = generateKeyMaterial(), keyId = randomUUID();
 d.kind = "encrypted"; d.versions[0]!.kind = "encrypted"; d.versions[0]!.entries = { token:{type:"string",encryptedValue:encryptValue(material,{keyId,dictionaryId:d.id,key:"token"},"secret-never-exported")} };
 const s = snapshot(d), files = serializeSnapshot(s).files; assert.ok(!JSON.stringify(files).includes("secret-never-exported"));
 await assert.rejects(restore.preview(s,{categories:["dictionaries"]}),code("SECRET_KEY_MISSING"));
 await restore.preview(s,{categories:["general"]});
 const keyring = new KeyringStore(resolveKeyringPath(store.files.root)); keyring.save({formatVersion:1,generation:1,keys:[{keyId,algorithm:"aes-256-gcm",material:material.toString("base64"),createdAt:Date.now()}],operations:[]});
 const preview = await restore.preview(s,{categories:["dictionaries"]});
 keyring.save({...keyring.load()!, generation:2}); await assert.rejects(restore.apply("expired",preview.token),code("PREVIEW_EXPIRED"));
 const damaged = structuredClone(s); const e = damaged.dictionaries![0]!.versions[0]!.entries.token!; if("encryptedValue" in e) e.encryptedValue.tag=Buffer.alloc(16).toString("base64");
 await assert.rejects(restore.preview(parseSnapshot(refreshManifest(serializeSnapshot(damaged).files).files),{categories:["dictionaries"]}),code("SECRET_DECRYPT_FAILED"));
});
test("v2 script dictionary dependencies are indexed and restore closes categories; v1 rejects declarations", async t => {
 const {store,restore} = setup(t), s = snapshot(), id = s.dictionaries![0]!.id;
 const definition = { id:"script",name:"Script",description:"",runtime:"nodejs" as const,entryFile:"main.ts",inputSchema:true,outputSchema:true,files:{"main.ts":"export default x => x;\n"},dictionaryBindings:{settings:{dictionaryId:id,kind:"plain" as const,keys:["baseUrl"]}} };
 s.scripts=[{id:"script",name:"Script",description:"",runtime:"nodejs",archived:false,currentPublishedVersionId:"version",draft:null,versions:[{id:"version",definition}]}];
 const b=serializeSnapshot(s); assert.equal(b.manifest.objects.find(o=>o.category==="scripts")!.dependencies[0]!.category,"dictionaries");
 const p=await restore.preview(parseSnapshot(b.files),{categories:["scripts"]}); assert.deepEqual(p.categories,["scripts","dictionaries"]); await restore.apply("closure",p.token); assert.ok(store.one("SELECT id FROM dictionaries WHERE id=?",id));
 const legacy=structuredClone(s); delete legacy.dictionaries; assert.throws(()=>serializeSnapshot(legacy),code("FORMAT_UNSUPPORTED"));
 const noBindings=structuredClone(definition); delete (noBindings as any).dictionaryBindings; assert.equal(portableScriptHash("v",noBindings),portableScriptHash("v",{...noBindings}));
});
test("dictionary committed-before-journal interruption recovers without mixed definitions or duplicate versions", async t => {
 const {store} = setup(t), s=snapshot(); let inject=true;
 const service=new ConfigRestoreService(store,undefined,{fault(phase){if(inject && phase==="database_committed_before_journal"){inject=false;throw new Error("interruption");}}});
 const preview=await service.preview(s,{categories:["dictionaries"],source:{kind:"git",sha:"a".repeat(40)}});
 await assert.rejects(service.apply("crash",preview.token),/interruption/); assert.equal(service.operations()[0]!.phase,"recovery_required");
 const restarted=new ConfigRestoreService(store); await restarted.recover(); const op=restarted.operations()[0]!; assert.equal(op.phase,"completed"); assert.equal(op.result!.sourceSha,"a".repeat(40)); assert.equal(op.result!.changed,1);
 await restarted.apply("crash",preview.token); assert.equal(store.one("SELECT count(*) n FROM dictionary_versions")!.n,1);
});
test("nested workflow dictionary bindings validate JSON pointers before import",async t=>{
 const {restore}=setup(t),s=snapshot(),id=s.dictionaries![0]!.id;
 const w={formatVersion:1,id:"workflow",name:"Workflow",inputSchema:true,outputSchema:true,entryNodeId:"code",nodes:[{id:"code",name:"Code",type:"code.nodejs",input:{source:"object",properties:{url:{source:"dictionary",dictionaryId:id,key:"baseUrl",pointer:"/missing"}}},outputSchema:true,config:{script:"scripts/main.ts"}}],edges:[],result:{source:"node",nodeId:"code"}};
 s.workflows=[{id:"workflow",name:"Workflow",currentPublishedVersionId:"version",draft:null,versions:[{id:"version",files:{"workflow.json":JSON.stringify(w),"layout.json":"{}","scripts/main.ts":"export default x=>x;"}}]}];
 await assert.rejects(restore.preview(parseSnapshot(serializeSnapshot(s).files),{categories:["workflows"]}),code("DICTIONARY_POINTER_INVALID"));
});
