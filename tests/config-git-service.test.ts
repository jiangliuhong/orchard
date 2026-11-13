import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { temporary, TestStore } from './helpers.js';
import { ConfigGitService } from '../src/config-git/service.js';
import { ConfigRestoreService } from '../src/config-git/restore.js';
import { WebBridgeConfig } from '../src/web-bridge/config.js';
import { parseSnapshot, serializeSnapshot, type PortableSnapshot } from '../src/config-git/snapshot.js';
import type { GitRepositoryOptions } from '../src/config-git/repository.js';
import { localReference } from '../src/config-git/snapshot-primitives.js';
import { AppError } from '../src/domain/errors.js';

async function setup(t: test.TestContext, options: GitRepositoryOptions = {}) {
  const root = temporary(t), remote = join(root, 'remote.git'); mkdirSync(remote);
  execFileSync('git', ['init', '--bare', '--initial-branch=main'], { cwd: remote, stdio: 'ignore' });
  const store = new TestStore(join(root, 'data')), restore = new ConfigRestoreService(store);
  const service = new ConfigGitService(store, new WebBridgeConfig(store.files.root), restore, { testTransport: () => remote, ...options });
  t.after(async () => { await service.close(); store.close(); });
  await service.repository.bind({ remoteUrl: 'https://example.com/config.git', branch: 'main', identity: { name: 'Test', email: 'test@example.com' } });
  const publish = async (snapshot: PortableSnapshot, push = false) => {
    const p = await service.repository.previewCommit({ files: serializeSnapshot(snapshot).files, revision: 'fixture', message: 'fixture', push });
    return (await service.repository.confirmCommit({ token: p.token, requestId: crypto.randomUUID(), revision: 'fixture' })).sha!;
  };
  return { store, restore, service, publish, remote };
}
function snapshot(): PortableSnapshot { return { general: { theme: 'dark' }, providers: [], webBridge: { applications: {}, environments: {}, tools: {}, enabledTools: {} }, scripts: [], workflows: [] }; }
function script(id: string, content: string) {
  const definition = { id, name: id, description: '', runtime: 'nodejs' as const, entryFile: 'main.ts', timeoutMs: 10000, resultMode: 'json' as const, inputSchema: true, outputSchema: true, files: { 'main.ts': content } };
  return { id, name: id, description: '', runtime: 'nodejs' as const, archived: false, currentPublishedVersionId: `${id}-v`, draft: null, versions: [{ id: `${id}-v`, definition }] };
}
test('restore collects mappings, consumes persisted mappings, delivers same saved theme to changed browser', async t => {
  const { service, restore, publish, store } = await setup(t), source = snapshot();
  const ref = localReference('providers', 'pi-cli', 'executable');
  source.providers.push({ id: 'pi-cli', enabled: true, config: { executable: ref, transport: 'legacy' }, defaultModel: '', models: [] });
  const sha = await publish(source);
  const missing = await service.restorePreview({ source: { kind: 'git', sha }, categories: ['providers'] });
  assert.equal(missing.sourceSha, sha); assert.equal(missing.requiredMappings[0]?.key, ref.localRef); assert.ok(missing.blockers.length);
  await assert.rejects(service.apply({ token: missing.token, requestId: 'blocked' }), { code: 'PREVIEW_EXPIRED' });
  writeFileSync(store.files.path('config-git/local-mappings.json'), JSON.stringify({ [ref.localRef]: '/secret/local/bin' }));
  const ready = await service.restorePreview({ source: { kind: 'git', sha }, categories: ['providers'] });
  assert.deepEqual(ready.blockers, []); assert.ok(!JSON.stringify(ready).includes('/secret/local/bin'));
  await service.apply({ token: ready.token, requestId: 'mapped' });
  assert.equal(store.provider('pi-cli')!.config.executable, '/secret/local/bin');
  restore.saveGeneralSnapshot('dark');
  const general = await service.restorePreview({ source: { kind: 'git', sha }, categories: ['general'], theme: 'light', clientId: 'browser', preferenceRevision: 2 });
  assert.equal(general.noChanges, false);
  await service.apply({ token: general.token, requestId: 'theme' });
  assert.equal(restore.pendingGeneral('browser')[0]?.theme, 'dark');
});
test('legacy browser references do not block remote sync on an unbound machine', async t => {
  const { service, publish, store } = await setup(t), source = snapshot();
  source.webBridge.applications.crm = { id: 'crm', name: 'CRM', enabled: true };
  source.webBridge.environments.crm = [{ id: 'shared-env', key: 'production', origin: 'https://example.com', enabled: true, profileId: localReference('webBridge', 'crm', 'shared-env', 'profileId') }];
  const sha = await publish(source);
  const preview = await service.restorePreview({ source: { kind: 'git', sha }, categories: ['webBridge'] });
  assert.deepEqual(preview.requiredMappings, []);
  assert.deepEqual(preview.blockers, []);
  assert.ok(preview.warnings?.some(warning => warning.includes('浏览器绑定仅保存在本机')));
  await service.apply({ token: preview.token, requestId: 'unbound-browser' });
  const restored = JSON.parse(store.one<{ config_json: string }>("SELECT config_json FROM bridge_configuration WHERE id='current'")!.config_json).environments.crm[0];
  assert.equal(restored.key, 'production');
  assert.equal(restored.profileId, undefined);
});
test('model-config-only changes remain actionable in the provider restore preview', async t => {
  const { service, store, publish } = await setup(t), source = snapshot();
  const ref = localReference('providers', 'pi-cli', 'executable');
  source.providers.push({ id: 'pi-cli', enabled: true, config: { executable: ref, transport: 'native' }, defaultModel: 'model', models: [{ id: 'model', name: 'Model', source: 'configured', enabled: true, deleted: false }], agentModelConfigs: [{ id: 'analysis-config', name: 'Analysis', description: 'Original', modelId: 'model', enabled: true }] });
  const initialSha = await publish(source);
  const initial = await service.restorePreview({ source: { kind: 'git', sha: initialSha }, categories: ['providers'], mappings: { [ref.localRef]: '/local/bin/pi' } });
  assert.deepEqual(initial.blockers, []);
  await service.apply({ token: initial.token, requestId: 'initial-provider' });
  const unchanged = await service.restorePreview({ source: { kind: 'git', sha: initialSha }, categories: ['providers'] });
  assert.equal(unchanged.noChanges, true);
  source.providers[0]!.agentModelConfigs![0]!.description = 'Updated';
  const sha = await publish(source);
  const preview = await service.restorePreview({ source: { kind: 'git', sha }, categories: ['providers'] });
  assert.deepEqual(preview.blockers, []);
  assert.equal(preview.noChanges, false);
  const diff = preview.diffs.find(d => d.category === 'providers' && d.objectId === 'pi-cli')!;
  assert.equal(diff.changeType, 'update');
  assert.match(diff.detail!, /Agent/);
  await service.apply({ token: preview.token, requestId: 'model-config-only' });
  assert.equal(store.one("SELECT description FROM agent_model_configs WHERE id='analysis-config'")!.description, 'Updated');
  const after = await service.restorePreview({ source: { kind: 'git', sha }, categories: ['providers'] });
  assert.equal(after.noChanges, true);
});
test('commit preference and generation locks reject changed confirmations', async t => {
  const { service } = await setup(t), prefs = { theme: 'dark' as const, clientId: 'browser', preferenceRevision: 1 };
  const p = await service.commitPreview({ ...prefs, message: 'first' });
  await assert.rejects(service.commit({ ...prefs, preferenceRevision: 2, token: p.token, requestId: 'bad' }), { code: 'PREVIEW_EXPIRED' });
  service.coordinator.withWrite(() => {});
  await assert.rejects(service.commit({ ...prefs, token: p.token, requestId: 'generation' }), { code: 'PREVIEW_EXPIRED' });
  const fresh = await service.commitPreview({ ...prefs, message: 'password=history-credential-marker' });
  const result = await service.commit({ ...prefs, token: fresh.token, requestId: 'good' }); assert.equal(result.committed, true);
  const history = await service.history({}); assert.equal(history.items[0]?.sha, result.sha); assert.equal(history.nextCursor, undefined); assert.ok(!JSON.stringify(history).includes('history-credential-marker'));
});
function pauseFetch(occurrence = 1) {
  let armed = false, entered!: () => void, release!: () => void;
  const reached = new Promise<void>(resolve => { entered = resolve; }), waiting = new Promise<void>(resolve => { release = resolve; });
  return { reached, release, arm: () => { armed = true; }, checkpoint: async (phase: string) => {
    if (armed && phase === 'before-fetch' && --occurrence === 0) { entered(); await waiting; }
  } };
}
function saveProvider(store: TestStore) {
  store.saveProvider({ id: 'pi-cli', enabled: false, config: { executable: '/local/bin/pi', transport: 'legacy' }, defaultModel: '', models: [], revision: 1, updatedAt: Date.now() });
}
test('preview copies configuration before fetch and permits edits and new activities while waiting', async t => {
  const gate = pauseFetch(), { service, store } = await setup(t, { testCheckpoint: gate.checkpoint });
  gate.arm(); const pending = service.commitPreview({ theme: 'dark', message: 'preview', push: true });
  await gate.reached;
  try {
    assert.doesNotThrow(() => saveProvider(store));
    assert.doesNotThrow(() => service.coordinator.withActivity('new-run', () => {}));
  } finally { gate.release(); }
  const preview = await pending;
  assert.equal(preview.diffs.some(diff => diff.category === 'providers'), false);
  await assert.rejects(service.commit({ token: preview.token, requestId: 'stale-preview', theme: 'dark' }), { code: 'PREVIEW_EXPIRED' });
  assert.equal((await service.repository.status()).head, null);
});
test('confirmation rechecks configuration after fetch without holding the read lock across the network', async t => {
  const gate = pauseFetch(), { service, store } = await setup(t, { testCheckpoint: gate.checkpoint });
  const preview = await service.commitPreview({ theme: 'dark', message: 'confirm', push: true });
  gate.arm(); const pending = service.commit({ token: preview.token, requestId: 'changed-during-fetch', theme: 'dark' });
  // Attach the rejection assertion before releasing the simulated network request.
  const rejected = assert.rejects(pending, { code: 'PREVIEW_EXPIRED' });
  await gate.reached;
  try { assert.doesNotThrow(() => saveProvider(store)); } finally { gate.release(); }
  await rejected;
  assert.equal((await service.repository.status()).head, null);
  const fresh = await service.commitPreview({ theme: 'dark', message: 'fresh', push: true });
  assert.equal((await service.commit({ token: fresh.token, requestId: 'fresh', theme: 'dark' })).pushed, true);
});
test('push allows new edits while committing only the accepted immutable snapshot', async t => {
  const gate = pauseFetch(2), { service, store } = await setup(t, { testCheckpoint: gate.checkpoint });
  const preview = await service.commitPreview({ theme: 'dark', message: 'push', push: true });
  gate.arm(); const input = { token: preview.token, requestId: 'accepted-snapshot', theme: 'dark' as const };
  const pending = service.commit(input); await gate.reached;
  try {
    assert.doesNotThrow(() => saveProvider(store));
    assert.doesNotThrow(() => service.coordinator.withActivity('new-run', () => {}));
  } finally { gate.release(); }
  const result = await pending; assert.equal(result.pushed, true);
  const committed = parseSnapshot(await service.repository.readSnapshot(result.sha!));
  assert.deepEqual(committed.providers, []); assert.ok(store.provider('pi-cli'));
  assert.deepEqual(await service.commit(input), result);
  const next = await service.commitPreview({ theme: 'dark', message: 'new edits' });
  assert.ok(next.diffs.some(diff => diff.category === 'providers'));
});

test('all cumulative pending diffs paginate and redact without raw preview fields', async t => {
  const { service, restore, publish } = await setup(t), source = snapshot(); await publish(source, true);
  for (let n = 0; n < 18; n++) source.scripts.push(script(`s${n}`, `export default () => ({ password: 'credential-marker-${n}' });`));
  await restore.apply('seed', (await restore.preview(source)).token);
  const prefs = { theme: 'dark' as const, clientId: 'browser', preferenceRevision: 1 };
  const first = await service.commitPreview({ ...prefs, message: 'pending' });
  await service.commit({ ...prefs, token: first.token, requestId: 'pending' });
  let page = await service.commitPreview({ ...prefs, message: 'push pending', push: true });
  assert.equal(page.noChanges, false); assert.ok(page.nextCursor);
  let cumulative = 0; const paths = new Set<string>();
  while (true) {
    const encoded = JSON.stringify(page); assert.ok(!encoded.includes('credential-marker-')); assert.ok(!('diff' in page)); assert.ok(!('cumulativeDiff' in page));
    for (const d of page.cumulativeDiffs) { cumulative++; assert.ok(!paths.has(d.path)); paths.add(d.path); }
    if (!page.nextCursor) break; page = service.previewPage(page.token, page.nextCursor);
  }
  assert.ok(cumulative > 50);
  await assert.rejects(async () => service.previewPage(page.token, 'NaN'), { code: 'INVALID_PAGE' });
});
test('immutable target conflicts expose identities and hashes but hide credential source', async t => {
  const { service, restore, publish } = await setup(t), source = snapshot(); source.scripts.push(script('sample', "export default () => ({ password: 'original-marker' });"));
  await restore.apply('seed', (await restore.preview(source)).token);
  source.scripts[0]!.versions[0]!.definition.files['main.ts'] = "export default () => ({ password: 'incoming-marker' });";
  const sha = await publish(source), preview = await service.restorePreview({ source: { kind: 'git', sha }, categories: ['scripts'] });
  const conflict = preview.blockerDetails.find(b => b.code === 'VERSION_ID_CONFLICT'); assert.equal(conflict?.versionId, 'sample-v'); assert.ok(conflict?.targetDigest); assert.notEqual(conflict?.incomingDigest, conflict?.targetDigest);
  assert.ok(!JSON.stringify(preview).includes('incoming-marker')); assert.ok(!JSON.stringify(preview).includes('original-marker'));
});
test('fixed SHA restore survives remote-only advancement', async t => {
  const { service, publish, remote } = await setup(t), sha = await publish(snapshot(), true);
  const p = await service.restorePreview({ source: { kind: 'git', sha }, categories: ['general'] });
  const tree = execFileSync('git', ['rev-parse', `${sha}^{tree}`], { cwd: remote, encoding: 'utf8' }).trim();
  const next = execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit-tree', tree, '-p', sha, '-m', 'advance'], { cwd: remote, encoding: 'utf8' }).trim();
  execFileSync('git', ['update-ref', 'refs/heads/main', next], { cwd: remote }); await service.repository.fetch();
  assert.equal((await service.apply({ token: p.token, requestId: 'fixed' })).phase, 'completed');
});
test('export persists claimable theme and fresh service replays durable commit and restore', async t => {
  const { service, restore, store, remote } = await setup(t);
  service.export('light'); assert.equal(restore.getGeneralTheme(), 'light');
  assert.equal(restore.claimGeneralSnapshot('browser', 0).theme, 'light');
  const preview = await service.commitPreview({ message: 'durable', theme: 'light' });
  const input = { token: preview.token, requestId: 'durable-commit', theme: 'light' as const };
  const committed = await service.commit(input);
  const plan = await service.restorePreview({ source: { kind: 'git', sha: committed.sha! }, categories: ['general'] });
  const restored = await service.apply({ token: plan.token, requestId: 'durable-restore' });
  await service.close();
  const restarted = new ConfigGitService(store, new WebBridgeConfig(store.files.root), restore, { testTransport: () => remote });
  t.after(() => restarted.close()); await restarted.repository.recover();
  restarted.export('dark');
  assert.deepEqual(await restarted.commit(input), committed);
  assert.equal(restore.getGeneralTheme(), 'dark');
  assert.deepEqual(await restarted.apply({ token: plan.token, requestId: 'durable-restore' }), restored);
  await assert.rejects(restarted.commit({ ...input, theme: 'dark' }), { code: 'REQUEST_CONFLICT' });
  await assert.rejects(restarted.apply({ token: 'different', requestId: 'durable-restore' }), { code: 'REQUEST_CONFLICT' });
});
test('run owns local lock and records only sanitized operation failures', async t => {
  const { service } = await setup(t); let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const one = service.run('one', { requestId: 'one' }, () => waiting);
  await new Promise(resolve => setImmediate(resolve));
  const two = service.run('two', { requestId: 'two' }, () => { throw new Error('must not run'); });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(service.operations.get(two.operationId).error?.code, 'CONFIG_BUSY'); release();
  await new Promise(resolve => setImmediate(resolve));
  const bad = service.run('bad', { requestId: 'bad' }, () => { throw new AppError('INVALID_SOURCE', 'password=exception-marker', 422); });
  await service.close(); assert.equal(service.operations.get(one.operationId).phase, 'completed');
  assert.ok(!JSON.stringify(service.operations.get(bad.operationId)).includes('exception-marker'));
});

test('dictionary preview exposes plain key removal, hides encrypted envelopes, and refetch invalidates fixed-source plans', async t => {
  const { service, restore, publish, store } = await setup(t);
  const { randomUUID } = await import('node:crypto');
  const { generateKeyMaterial, encryptValue } = await import('../src/secrets/aead.js');
  const { KeyringStore, resolveKeyringPath } = await import('../src/secrets/keyring.js');
  const id = randomUUID(), versionId = randomUUID(), encryptedId = randomUUID(), encryptedVersionId = randomUUID(), material = generateKeyMaterial(), keyId = randomUUID();
  new KeyringStore(resolveKeyringPath(store.root)).save({formatVersion:1,generation:1,keys:[{keyId,algorithm:'aes-256-gcm',material:material.toString('base64'),createdAt:Date.now()}],operations:[]});
  const s=snapshot();
  const envelope=encryptValue(material,{keyId,dictionaryId:encryptedId,key:'credential'},'never-emit-this-value');
  s.dictionaries=[{id,kind:'plain',currentVersionId:versionId,versions:[{id:versionId,dictionaryId:id,name:'Plain',description:'',kind:'plain',enabled:true,entries:{removeMe:{type:'number',value:42},keep:{type:'string',value:'old'}}}]},{id:encryptedId,kind:'encrypted',currentVersionId:encryptedVersionId,versions:[{id:encryptedVersionId,dictionaryId:encryptedId,name:'Credentials',description:'',enabled:true,kind:'encrypted',entries:{credential:{type:'string',encryptedValue:envelope}}}]}];
  const sha=await publish(s,true);
  const preview=await service.restorePreview({source:{kind:'git',sha},categories:['dictionaries']});
  const text=JSON.stringify(preview); for(const secret of ['never-emit-this-value',envelope.ciphertext,envelope.nonce,envelope.tag]) assert.ok(!text.includes(secret));
  assert.ok(text.includes('credential')); assert.ok(text.includes('removeMe')); assert.deepEqual(preview.blockers,[]);
  await service.remoteSyncSource(); await assert.rejects(service.apply({token:preview.token,requestId:'stale-source'}),{code:'PREVIEW_EXPIRED'});
  await service.apply({token:(await service.restorePreview({source:{kind:'git',sha},categories:['dictionaries']})).token,requestId:'apply-source'});
  const recovery=restore.operations().find(o=>o.requestId==='apply-source')!; assert.equal(recovery.result!.sourceSha,sha);
  const next=structuredClone(s); const d=next.dictionaries![0]!; d.currentVersionId=randomUUID(); d.versions=[{...d.versions[0]!,id:d.currentVersionId,entries:{keep:{type:'string',value:'new'}}}];
  const nextSha=await publish(next,true); const changes=await service.restorePreview({source:{kind:'git',sha:nextSha},categories:['dictionaries']});
  const plain=changes.diffs.find(d=>d.objectId===id)!; assert.ok(plain.before!.includes('removeMe')); assert.ok(!plain.after!.includes('removeMe')); assert.ok(plain.after!.includes('new'));
});
