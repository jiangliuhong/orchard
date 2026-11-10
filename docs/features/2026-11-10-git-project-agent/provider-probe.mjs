// Manual native-protocol feasibility probe. Uses only generated, non-sensitive fixtures.
// Run: node docs/features/2026-11-10-git-project-agent/provider-probe.mjs <data-dir>
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomInt } from 'node:crypto';

if (!process.argv[2]) throw new Error('Pass the Orchard data directory explicitly');
const root = resolve(process.argv[2], 'project-git', 'verification');
await mkdir(root, { recursive: true, mode: 0o700 });

async function probe(kind) {
  const cwd = await mkdtemp(join(root, `${kind}-`));
  const left = randomInt(100, 1000), right = randomInt(100, 1000);
  await writeFile(join(cwd, 'left.json'), JSON.stringify({ value: left }));
  await writeFile(join(cwd, 'right.json'), JSON.stringify({ value: right }));
  const prompt = 'This is a generated feasibility fixture, not a real project. Use tools to run pwd and read both left.json and right.json in your current directory. Do not inspect any other directories, credentials, or network. Do not modify files. Return ONLY JSON with keys sum (sum of the two values, number) and cwd (actual pwd, string).';
  const args = kind === 'pi'
    ? ['--mode', 'rpc', '--no-session', '--no-extensions', '--no-mcp', '--thinking', 'off', ...(process.env.PROBE_PI_MODEL ? ['--model', process.env.PROBE_PI_MODEL] : [])]
    : ['app-server', '-c', 'mcp_servers={}', '-c', 'notify=[]'];
  const child = spawn(kind, args, { cwd, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let buffer = '', sequence = 0, toolEvents = 0, finalText = '', settled = false;
  const pending = new Map();
  const startedAt = Date.now();
  let resolveDone, rejectDone;
  const done = new Promise((yes, no) => { resolveDone = yes; rejectDone = no; });
  const finish = (error) => {
    if (settled) return;
    settled = true;
    error ? rejectDone(error) : resolveDone();
  };
  const send = value => child.stdin.write(`${JSON.stringify(value)}\n`);
  const request = (name, params = {}) => new Promise((yes, no) => {
    const id = String(++sequence);
    pending.set(id, { yes, no });
    send(kind === 'pi' ? { id, type: name, ...params } : { id, method: name, params });
  });
  child.stdin.on('error', () => {});
  // Never print raw diagnostics: provider stderr can contain local configuration.
  child.stderr.on('data', () => {});
  child.on('error', () => finish(new Error('PROCESS_START_FAILED')));
  child.on('exit', code => finish(new Error(`PROCESS_EXITED_${code}`)));
  child.stdout.on('data', chunk => {
    buffer += chunk.toString();
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      if (!line.trim()) continue;
      let event;
      try { event = JSON.parse(line); } catch { finish(new Error('INVALID_PROTOCOL_JSON')); continue; }
      const response = pending.get(String(event.id));
      if (response && (event.type === 'response' || 'result' in event || 'error' in event)) {
        pending.delete(String(event.id));
        if (event.error || event.success === false) response.no(new Error('REQUEST_REJECTED'));
        else response.yes(event);
      } else if (kind === 'codex' && event.id !== undefined && event.method) {
        // No generic approval implementation in this probe; report the needed integration.
        send({ id: event.id, error: { code: -32601, message: 'Probe does not implement interactive requests' } });
        finish(new Error(`INTERACTIVE_REQUEST_${event.method}`));
      }
      if (kind === 'pi') {
        if (event.type === 'tool_execution_end') toolEvents++;
        if (event.type === 'agent_end') {
          const last = (event.messages ?? []).filter(m => m.role === 'assistant').at(-1);
          finalText = (last?.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('');
          finish();
        }
      } else {
        const item = event.params?.item;
        if (event.method === 'item/completed' && item?.type === 'commandExecution') toolEvents++;
        if (event.method === 'item/completed' && item?.type === 'agentMessage') finalText = item.text ?? '';
        if (event.method === 'turn/completed') {
          finish(event.params?.turn?.status === 'completed' ? undefined : new Error('TURN_NOT_COMPLETED'));
        }
      }
    }
  });
  const timer = setTimeout(() => finish(new Error('PROBE_TIMEOUT')), 90000);
  // Attach rejection handling immediately, including while handshake is pending.
  const result = done.then(() => {
    const parsed = JSON.parse(finalText);
    if (parsed.sum !== left + right || resolve(parsed.cwd) !== cwd || toolEvents < 1) throw new Error('FIXTURE_ASSERTION_FAILED');
    return { provider: kind, status: 'passed', toolEvents, durationMs: Date.now() - startedAt };
  });
  result.catch(() => {});
  const setup = (async () => {
    if (kind === 'pi') {
      await request('get_state');
      await request('prompt', { message: prompt });
    } else {
      await request('initialize', { clientInfo: { name: 'orchard-project-probe', version: '0.1.0' } });
      send({ method: 'initialized', params: {} });
      const opened = await request('thread/start', { cwd, ephemeral: true, sandbox: 'workspace-write', approvalPolicy: 'never' });
      await request('turn/start', { threadId: opened.result.thread.id, input: [{ type: 'text', text: prompt, text_elements: [] }], outputSchema: { type: 'object', properties: { sum: { type: 'number' }, cwd: { type: 'string' } }, required: ['sum', 'cwd'], additionalProperties: false } });
    }
  })();
  setup.catch(error => finish(error));
  try { return await result; }
  catch (error) { return { provider: kind, status: 'failed', reason: error.message, toolEvents, durationMs: Date.now() - startedAt }; }
  finally {
    clearTimeout(timer);
    try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    await new Promise(yes => child.exitCode !== null || child.signalCode !== null ? yes() : child.once('close', yes));
    for (const entry of pending.values()) entry.no(new Error('PROBE_CLOSED'));
    await setup.catch(() => {});
    await rm(cwd, { recursive: true, force: true });
  }
}

const results = await Promise.all([probe('pi'), probe('codex')]);
console.log(JSON.stringify({ results }, null, 2));
if (results.some(result => result.status !== 'passed')) process.exitCode = 1;
