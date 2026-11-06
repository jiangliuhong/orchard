import {test,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {JSDOM} from 'jsdom';
import type {Plan,Status} from '../src/migrations/types.js';
const dom=new JSDOM('<!doctype html><html><body></body></html>',{url:'http://localhost:7443/workflows/deep-link',pretendToBeVisual:true});
for(const key of ['window','document','HTMLElement','HTMLInputElement','HTMLFormElement','Element','Node','MutationObserver','Event','MouseEvent','CustomEvent','getComputedStyle'] as const)Object.defineProperty(globalThis,key,{value:(dom.window as unknown as Record<string,unknown>)[key],configurable:true});
Object.defineProperty(globalThis,'navigator',{value:dom.window.navigator,configurable:true});
const {render,screen,fireEvent,cleanup,waitFor,act}=await import('@testing-library/react');
const {BootstrapGate}=await import('../src/web/Bootstrap.js');
const originalFetch=globalThis.fetch;
afterEach(()=>{cleanup();globalThis.fetch=originalFetch;});
function mount(){return render(createElement(BootstrapGate,null,createElement('p',null,'已打开工作台业务')));}
async function wake(){await act(async()=>{document.dispatchEvent(new dom.window.Event('visibilitychange'));await Promise.resolve();});}
function server(initial:Status['state']='migration_required'){
 let session='session-'+Math.random(),revision=1,state=initial,hadMigration=initial==='migrating';
 const plan:Plan={status:'ready',planHash:'original-plan',sourceFingerprint:'source',sourceVersions:{database:1,webBridge:0},targetVersions:{database:6,webBridge:1},steps:[{id:'db.v1-v2',checksum:'frozen',summary:'保留原数据并升级',affectedResources:['workbench.db']}],resources:['workbench.db'],questions:[],estimates:{bytes:1024,requiredBytes:2048},blockers:[]};
 const requests:{url:string;body:any;token:string|null}[]=[];
 let handler:((url:string,body:any)=>Response|Promise<Response>|undefined)|undefined;
 globalThis.fetch=async(input,options)=>{
  const url=String(input),headers=new Headers(options?.headers),body=options?.body?JSON.parse(String(options.body)):undefined;
  requests.push({url,body,token:headers.get('X-Orchard-Bootstrap-Token')});
  if(url==='/api/bootstrap/session'){assert.equal(headers.get('X-Orchard-Bootstrap'),'1');return Response.json({token:session,sessionId:session});}
  if(headers.get('X-Orchard-Bootstrap-Token')!==session)return Response.json({code:'UNAUTHORIZED',message:'启动会话已失效'},{status:401});
  const custom=await handler?.(url,body);if(custom)return custom;
  if(url==='/api/bootstrap/status')return Response.json({state,ready:state==='ready',revision,dataDir:'/temporary/workbench',...(hadMigration&&['migrating','verifying','restoring','recovery_required','initialization_failed','ready'].includes(state)?{activeJobId:'job'}:{})});
  if(url==='/api/migrations/plan')return Response.json(plan);
  if(url==='/api/migrations/validate')return Response.json({planHash:plan.planHash,confirmationHash:'confirmation',expiresAt:new Date(Date.now()+60000).toISOString(),summary:plan.steps,fieldErrors:{}});
  if(url==='/api/migrations/jobs'){state='migrating';hadMigration=true;revision++;return Response.json({jobId:'job',state:'accepted',statusUrl:'/api/migrations/jobs/job'},{status:202});}
  if(url==='/api/migrations/jobs/job')return Response.json({jobId:'job',phase:state==='ready'?'committed':'transforming',revision,processed:7,steps:[{id:'db.v1-v2',state:'complete'}],result:state==='ready'?{committed:true,ready:true,backup:'backups/migrations/job',bytes:1024}:undefined});
  throw new Error('Unexpected request '+url);
 };
 return {plan,requests,handle(value:typeof handler){handler=value;},state(value:Status['state']){state=value;if(value==='migrating')hadMigration=true;revision++;},restart(){session='replacement-'+Math.random();revision=0;},get session(){return session;}};
}
async function confirmation(){fireEvent.click(await screen.findByRole('button',{name:'继续填写参数'}));fireEvent.click(screen.getByRole('button',{name:'验证并查看确认摘要'}));await screen.findByRole('heading',{name:'确认升级'});fireEvent.click(screen.getByRole('checkbox',{name:'我已确认升级范围和备份位置'}));}
test('deep links remain gated until readiness and registered business failures return to the gate',async()=>{
 const mock=server('checking');mount();await screen.findByRole('heading',{name:'正在检查数据'});assert.equal(screen.queryByText('已打开工作台业务'),null);
 mock.state('ready');await wake();await screen.findByText('已打开工作台业务');
 mock.state('installing');await act(async()=>{window.dispatchEvent(new dom.window.CustomEvent('orchard:not-ready'));});await screen.findByRole('heading',{name:'正在安装升级结果'});assert.equal(screen.queryByText('已打开工作台业务'),null);
});
test('a new page opened after commitment enters the workspace without displaying the upgrade wizard again',async()=>{
 const mock=server('migrating');mock.state('ready');mount();await screen.findByText('已打开工作台业务');await wake();assert.equal(screen.queryByRole('heading',{name:'数据升级完成'}),null);assert.equal(screen.queryByRole('button',{name:'进入工作台'}),null);
});
test('lost acceptance responses reuse the same request; refreshing follows progress and success opens the same workspace',async()=>{
 const mock=server();let submissions=0;
 mock.handle((url)=>{if(url==='/api/migrations/jobs'&&++submissions===1)throw new TypeError('网络暂时断开');return undefined;});
 let view=mount();await confirmation();fireEvent.click(screen.getByRole('button',{name:'备份并开始升级'}));await screen.findByText('网络暂时断开');
 fireEvent.click(screen.getByRole('button',{name:'备份并开始升级'}));await screen.findByText(/阶段：transforming/);
 const accepted=mock.requests.filter(r=>r.url==='/api/migrations/jobs');assert.equal(accepted.length,2);assert.deepEqual(accepted[0].body,accepted[1].body);
 fireEvent.click(screen.getByRole('button',{name:'收起进度，任务继续'}));assert.ok(screen.getByRole('button',{name:'展开进度'}));
 view.unmount();view=mount();await screen.findByText(/阶段：transforming/);assert.equal(screen.queryByText('已打开工作台业务'),null);
 mock.state('ready');await wake();await screen.findByRole('heading',{name:'数据升级完成'});assert.ok(screen.getByText(/实际占用 1024 字节/));fireEvent.click(screen.getByRole('button',{name:'进入工作台'}));assert.ok(screen.getByText('已打开工作台业务'));
});
test('conditional fields clear hidden answers, secrets clear after validation errors and revised plan hashes are submitted',async()=>{
 const mock=server();mock.plan.questions=[{key:'test/use',type:'boolean',label:'使用凭据',description:'',default:false},{key:'test/secret',type:'secret',label:'秘密',description:'仅用于测试',required:true,when:{key:'test/use',equals:true}},{key:'test/count',type:'integer',label:'数量',description:'',default:2,min:1,max:10}];
 let validations=0;mock.handle((url)=>{if(url==='/api/migrations/validate'){validations++;return validations===1?Response.json({code:'INVALID_ANSWERS',message:'检查字段',fieldErrors:{'test/secret':'凭据无效'}},{status:422}):Response.json({planHash:'answered-plan',confirmationHash:'final-confirmation',expiresAt:new Date(Date.now()+60000).toISOString(),summary:mock.plan.steps,fieldErrors:{}});}return undefined;});
 mount();fireEvent.click(await screen.findByRole('button',{name:'继续填写参数'}));assert.equal(screen.queryByLabelText('秘密（必填）'),null);
 fireEvent.click(screen.getByLabelText('使用凭据'));let secret=screen.getByLabelText('秘密（必填）') as HTMLInputElement;fireEvent.change(secret,{target:{value:'secret-answer'}});
 fireEvent.click(screen.getByLabelText('使用凭据'));fireEvent.click(screen.getByLabelText('使用凭据'));secret=screen.getByLabelText('秘密（必填）') as HTMLInputElement;assert.equal(secret.value,'');
 fireEvent.change(secret,{target:{value:'secret-answer'}});fireEvent.click(screen.getByRole('button',{name:'验证并查看确认摘要'}));await screen.findByText('凭据无效');assert.equal(secret.value,'');
 fireEvent.change(secret,{target:{value:'replacement-secret'}});fireEvent.click(screen.getByRole('button',{name:'验证并查看确认摘要'}));await screen.findByRole('heading',{name:'确认升级'});assert.equal(document.body.textContent?.includes('replacement-secret'),false);
 fireEvent.click(screen.getByRole('checkbox',{name:'我已确认升级范围和备份位置'}));fireEvent.click(screen.getByRole('button',{name:'备份并开始升级'}));await screen.findByText(/阶段：transforming/);
 const submission=mock.requests.find(r=>r.url==='/api/migrations/jobs')!.body;assert.equal(submission.planHash,'answered-plan');assert.equal(submission.answers['test/secret'],'replacement-secret');assert.equal(document.querySelector('input[type=password]'),null);
});
test('recovery response loss reuses its request, while a completed failed recovery permits a new attempt',async()=>{
 const mock=server('migrating');mock.state('recovery_required');let attempts=0,phase='recovery_required';
 mock.handle((url)=>{
  if(url==='/api/migrations/jobs/job')return Response.json({jobId:'job',phase,revision:attempts,processed:0,steps:[]});
  if(url==='/api/migrations/jobs/job/recover'){
   if(++attempts===1)throw new TypeError('恢复回执暂时丢失');phase='restoring';mock.state('restoring');return Response.json({operationId:'operation'},{status:202});
  }
  return undefined;
 });
 mount();fireEvent.click(await screen.findByRole('button',{name:'重新尝试恢复'}));await screen.findByText('恢复回执暂时丢失');
 fireEvent.click(screen.getByRole('button',{name:'重新尝试恢复'}));await screen.findByRole('heading',{name:'正在恢复升级前数据'});
 phase='recovery_required';mock.state('recovery_required');await wake();fireEvent.click(await screen.findByRole('button',{name:'重新尝试恢复'}));await screen.findByRole('heading',{name:'正在恢复升级前数据'});
 const requests=mock.requests.filter(request=>request.url.endsWith('/recover'));assert.equal(requests.length,3);assert.equal(requests[0].body.requestId,requests[1].body.requestId);assert.notEqual(requests[1].body.requestId,requests[2].body.requestId);
});
test('expired process sessions handshake again while preserving the write request identity',async()=>{
 const mock=server();mount();await confirmation();mock.restart();fireEvent.click(screen.getByRole('button',{name:'备份并开始升级'}));await screen.findByText(/阶段：transforming/);
 const attempts=mock.requests.filter(r=>r.url==='/api/migrations/jobs');assert.equal(attempts.length,2);assert.deepEqual(attempts[0].body,attempts[1].body);assert.notEqual(attempts[0].token,attempts[1].token);assert.equal(attempts[1].token,mock.session);
 await waitFor(()=>assert.equal(screen.queryByText('已打开工作台业务'),null));
});
