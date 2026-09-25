export const WORKBENCH_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Orchard</title></head>
<body><main><h1>Orchard</h1><p>个人 AI 工作流工作台</p>
<form id="connect"><label>本次服务访问令牌 <input id="token" type="password" autocomplete="off" required></label><button>连接</button></form>
<form id="create"><input id="name" placeholder="新工作流名称" maxlength="200" required><input id="description" placeholder="描述（可选）" maxlength="2000"><button>创建工作流</button></form>
<p id="status" role="status">输入终端显示的令牌，读取当前工作区。</p>
<ul id="workflows"></ul><button id="more" hidden>加载更多</button>
<h2>最近运行</h2><ul id="runs"></ul></main><script src="/workbench.js" defer></script></body></html>`;

export const WORKBENCH_JS = `
const form = document.querySelector('#connect');
const create = document.querySelector('#create');
const status = document.querySelector('#status');
const list = document.querySelector('#workflows');
const runs = document.querySelector('#runs');
const more = document.querySelector('#more');
let token = '';
let offset = 0;
let busy = false;
const headers = () => ({ Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' });
create.addEventListener('submit', async (event) => { event.preventDefault(); if (!token) { status.textContent = '请先连接'; return; } const response = await fetch('/api/workflows', { method: 'POST', headers: headers(), body: JSON.stringify({ name: document.querySelector('#name').value, description: document.querySelector('#description').value || undefined }) }); const body = await response.json(); status.textContent = response.ok ? '已创建 ' + body.name : (body.message || '创建失败'); if (response.ok) { create.reset(); await load(true); } });
async function load(reset) {
  if (busy) return;
  busy = true; more.disabled = true; form.querySelector('button').disabled = true;
  if (reset) { offset = 0; list.replaceChildren(); runs.replaceChildren(); }
  try {
    const response = await fetch('/api/workflows?limit=50&offset=' + offset, { headers: headers() });
    const body = await response.json(); if (!response.ok) throw new Error(body.message || '读取失败');
    for (const workflow of body.items) {
      const item = document.createElement('li');
      item.textContent = workflow.name + ' — ' + workflow.status + (workflow.description ? ' — ' + workflow.description : '');
      const run = document.createElement('button'); run.textContent = '运行'; run.disabled = workflow.status !== 'active';
      run.onclick = async () => {
        const value = prompt('输入 JSON（留空为 null）', '{}'); if (value === null) return;
        let input; try { input = value.trim() ? JSON.parse(value) : null; } catch { status.textContent = '输入不是有效 JSON'; return; }
        const result = await fetch('/api/workflows/' + encodeURIComponent(workflow.id) + '/runs', { method: 'POST', headers: headers(), body: JSON.stringify({ input }) });
        const data = await result.json(); status.textContent = result.ok ? '已排队运行 ' + data.id : (data.message || '运行失败'); if (result.ok) await loadRuns();
      }; item.append(' ', run); list.append(item);
    }
    offset += body.items.length; more.hidden = body.items.length < 50;
    status.textContent = offset ? '已加载 ' + offset + ' 个工作流' : '当前工作区尚无工作流'; await loadRuns();
  } catch (error) { status.textContent = error.message; more.hidden = true; }
  finally { busy = false; more.disabled = false; form.querySelector('button').disabled = false; }
}
async function loadRuns() {
  const response = await fetch('/api/runs?limit=20&offset=0', { headers: headers() }); if (!response.ok) return;
  const body = await response.json(); runs.replaceChildren();
  for (const run of body.items) { const item = document.createElement('li'); item.textContent = run.id + ' — ' + run.status; runs.append(item); }
}
form.addEventListener('submit', (event) => { event.preventDefault(); token = document.querySelector('#token').value; document.querySelector('#token').value = ''; void load(true); });
more.addEventListener('click', () => void load(false));
`;
