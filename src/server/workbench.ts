export const WORKBENCH_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Orchard</title></head>
<body><main><h1>Orchard</h1><p>个人 AI 工作流工作台 · 只读预览</p>
<form id="connect"><label>本次服务访问令牌 <input id="token" type="password" autocomplete="off" required></label><button>连接</button></form>
<p id="status" role="status">输入终端显示的令牌，读取当前工作区。</p>
<ul id="workflows"></ul><button id="more" hidden>加载更多</button>
<p>创建、发布和运行功能尚未开放。</p></main><script src="/workbench.js" defer></script></body></html>`;

export const WORKBENCH_JS = `
const form = document.querySelector('#connect');
const status = document.querySelector('#status');
const list = document.querySelector('#workflows');
const more = document.querySelector('#more');
let token = '';
let offset = 0;
let busy = false;
async function load(reset) {
  if (busy) return;
  busy = true;
  more.disabled = true;
  form.querySelector('button').disabled = true;
  if (reset) { offset = 0; list.replaceChildren(); }
  try {
    const response = await fetch('/api/workflows?limit=50&offset=' + offset, { headers: { Authorization: 'Bearer ' + token } });
    const body = await response.json();
    if (!response.ok) throw new Error(body.message || '读取失败');
    for (const workflow of body.items) {
      const item = document.createElement('li');
      item.textContent = workflow.name + ' — ' + workflow.status + (workflow.description ? ' — ' + workflow.description : '');
      list.append(item);
    }
    offset += body.items.length;
    more.hidden = body.items.length < 50;
    status.textContent = offset ? '已加载 ' + offset + ' 个工作流' : '当前工作区尚无工作流';
  } catch (error) {
    status.textContent = error.message;
    more.hidden = true;
  } finally {
    busy = false;
    more.disabled = false;
    form.querySelector('button').disabled = false;
  }
}
form.addEventListener('submit', (event) => {
  event.preventDefault();
  token = document.querySelector('#token').value;
  document.querySelector('#token').value = '';
  void load(true);
});
more.addEventListener('click', () => void load(false));
`;
