// Run: node --import tsx tests/fixtures/config-git/https-verification.ts
// Real TLS smart HTTP, pinned temporary CA, credential helper; no testTransport.
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:https';
import { promises as fs } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { GitRepositoryService } from '../../../src/config-git/repository.js';

const root=await fs.mkdtemp(join(tmpdir(),'orchard-real-https-'));
const run=(command:string,args:string[],cwd=root)=>execFileSync(command,args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const originalXdg=process.env.XDG_CONFIG_HOME, originalPath=process.env.PATH;
const results:string[]=[];
let server:ReturnType<typeof createServer>|undefined;
let allowPush=true, authenticatedRequests=0, tlsFailures=0;
const user='fixture', password=crypto.randomUUID();
const shellQuote=(s:string)=>`'${s.replaceAll("'","'\\''")}'`;
try {
  const key=join(root,'server.key'),certificate=join(root,'server.crt'),caKey=join(root,'ca.key'),ca=join(root,'ca.crt');
  run('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',caKey,'-out',ca,'-days','1','-subj','/CN=Orchard isolated verification CA']);
  run('openssl',['req','-newkey','rsa:2048','-nodes','-keyout',key,'-out',join(root,'server.csr'),'-subj','/CN=127.0.0.1']);
  await fs.writeFile(join(root,'extensions'),'subjectAltName=IP:127.0.0.1\nextendedKeyUsage=serverAuth\n');
  run('openssl',['x509','-req','-in',join(root,'server.csr'),'-CA',ca,'-CAkey',caKey,'-CAcreateserial','-out',certificate,'-days','1','-extfile',join(root,'extensions')]);
  await fs.chmod(key,0o600);await fs.chmod(caKey,0o600);
  const remote=join(root,'remote.git');await fs.mkdir(remote);run('git',['init','--bare','--initial-branch=main'],remote);run('git',['config','http.receivepack','true'],remote);
  const gitExec=run('git',['--exec-path']);
  server=createServer({key:await fs.readFile(key),cert:await fs.readFile(certificate)},(request,response)=>{
    if(request.headers.authorization!==`Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`) {
      response.writeHead(401,{'WWW-Authenticate':'Basic realm="Orchard isolated fixture"'});response.end('Authentication required');request.resume();return;
    }
    authenticatedRequests++;
    const url=new URL(request.url!,'https://127.0.0.1');
    if(!allowPush&&(url.pathname.endsWith('/git-receive-pack')||url.searchParams.get('service')==='git-receive-pack')) {
      response.writeHead(403);response.end('Fixture denies write permission');request.resume();return;
    }
    const backend=spawn(join(gitExec,'git-http-backend'),[],{env:{...process.env,GIT_PROJECT_ROOT:root,GIT_HTTP_EXPORT_ALL:'1',PATH_INFO:url.pathname,QUERY_STRING:url.search.slice(1),REQUEST_METHOD:request.method!,CONTENT_TYPE:request.headers['content-type']??'',REMOTE_USER:user,REMOTE_ADDR:'127.0.0.1',SERVER_PROTOCOL:'HTTP/1.1'},stdio:['pipe','pipe','pipe']});
    let pending=Buffer.alloc(0),headersSent=false;
    backend.stdout.on('data',(chunk:Buffer)=>{
      if(headersSent){response.write(chunk);return;}
      pending=Buffer.concat([pending,chunk]);const boundary=pending.indexOf('\r\n\r\n');if(boundary<0)return;
      const headers:Record<string,string>={};let status=200;
      for(const line of pending.subarray(0,boundary).toString().split('\r\n')){const colon=line.indexOf(':');if(colon<0)continue;const name=line.slice(0,colon),value=line.slice(colon+1).trim();if(name.toLowerCase()==='status')status=Number(value.split(' ')[0]);else headers[name]=value;}
      response.writeHead(status,headers);headersSent=true;response.write(pending.subarray(boundary+4));pending=Buffer.alloc(0);
    });
    backend.stderr.resume();backend.stdin.on('error',()=>{});
    backend.on('error',()=>{if(!headersSent)response.writeHead(500);response.end();});
    backend.on('close',()=>response.end());request.pipe(backend.stdin);response.on('close',()=>backend.kill('SIGTERM'));
  });
  server.on('tlsClientError',()=>{tlsFailures++;});
  await new Promise<void>(r=>server!.listen(0,'127.0.0.1',r));const port=(server.address() as {port:number}).port;
  const remoteUrl=`https://127.0.0.1:${port}/remote.git`;
  const helper=join(root,'credential-helper'),credential=join(root,'credential');
  await fs.writeFile(credential,`username=${user}\npassword=${password}\n`,{mode:0o600});
  await fs.writeFile(helper,`#!/bin/sh\nif [ "$1" = get ]; then /bin/cat ${shellQuote(credential)}; fi\n`,{mode:0o700});
  const config=join(root,'gitconfig');
  const configText=(withCredentials:boolean,withCa:boolean)=>`[http]\n sslVerify = true\n${withCa?` sslCAInfo = ${ca}\n`:''}[credential]\n helper =\n${withCredentials?` helper = ${helper}\n`:''}`;
  await fs.writeFile(config,configText(true,true));
  // The service intentionally removes caller GIT_* variables. A private PATH Git
  // launcher selects only this fixture config, without editing user/global config.
  const realGit=run('which',['git']),bin=join(root,'bin');await fs.mkdir(bin);
  await fs.writeFile(join(bin,'git'),`#!/bin/sh\nGIT_CONFIG_GLOBAL=${shellQuote(config)} GIT_CONFIG_NOSYSTEM=1 exec ${shellQuote(realGit)} "$@"\n`,{mode:0o700});
  process.env.PATH=`${bin}:${originalPath}`;process.env.XDG_CONFIG_HOME=join(root,'xdg');
  const service=(name:string)=>new GitRepositoryService(join(root,name),{validateSnapshot:f=>assert.equal(JSON.parse(f['manifest.json']).formatVersion,1),timeoutMs:15000});
  const a=service('a'),b=service('b');
  const bind=(s:GitRepositoryService)=>s.bind({remoteUrl,branch:'main',identity:{name:'Orchard HTTPS Verification',email:'fixture@localhost'}});
  const commit=async(s:GitRepositoryService,text:string)=>{const p=await s.previewCommit({files:{'manifest.json':'{"formatVersion":1}\n','settings.txt':text},revision:'r',message:text,push:true});return s.confirmCommit({token:p.token,revision:'r',requestId:crypto.randomUUID()});};
  assert.equal((await a.checkRemote(remoteUrl)).branches.length,0);await bind(a);const first=await commit(a,'first TLS commit');assert.equal(first.pushed,true);
  results.push(`通过：严格校验证书的 HTTPS 连接检查、空仓库绑定、提交和推送；提交 SHA 为 ${first.sha}。`);
  await bind(b);assert.equal((await b.readSnapshot(first.sha!))['settings.txt'],'first TLS commit');const second=await commit(b,'remote HTTPS update');assert.equal(second.pushed,true);const oldHead=(await a.status()).head;await a.fetch();assert.equal((await a.status()).head,oldHead);assert.equal((await a.status()).behind,1);results.push('通过：第二个 HTTPS 副本绑定并读取固定 SHA，推送新版本；第一副本 fetch 获取远端变化而不移动本地 HEAD。');
  await fs.writeFile(credential,`username=${user}\npassword=deliberately-wrong\n`,{mode:0o600});await assert.rejects(a.checkRemote(remoteUrl),{code:'AUTH_FAILED'});await fs.writeFile(config,configText(false,true));await assert.rejects(a.checkRemote(remoteUrl),{code:'AUTH_FAILED'});await fs.writeFile(credential,`username=${user}\npassword=${password}\n`,{mode:0o600});await fs.writeFile(config,configText(true,true));results.push('通过：错误凭据和缺失凭据均返回 AUTH_FAILED；凭据仅由临时 helper 提供，URL 不含用户名或密码。');
  allowPush=false;const rejected=await commit(a,'HTTPS permission denied');assert.equal(rejected.committed,true);assert.equal(rejected.pushed,false);assert.equal(rejected.pushError,'PUSH_REJECTED');assert.equal((await a.status()).head,rejected.sha);assert.equal(run(realGit,['rev-parse','refs/heads/main'],remote),second.sha);results.push(`通过：服务端禁止 receive-pack 时，推送失败且远端保持不变，本地提交 ${rejected.sha} 被保留。复测确认 HTTP 403 错误码为 ${rejected.pushError}，符合推送被拒绝的语义。`);allowPush=true;await a.push();assert.equal(run(realGit,['rev-parse','refs/heads/main'],remote),rejected.sha);results.push('通过：恢复写权限后普通 push 成功，复用已保留的本地提交。');
  const beforeUntrusted=authenticatedRequests;await fs.writeFile(config,configText(true,false));await assert.rejects(a.checkRemote(remoteUrl),{code:'GIT_FAILED'});assert.equal(authenticatedRequests,beforeUntrusted,'Untrusted TLS must fail before authenticated HTTP');await fs.writeFile(config,configText(true,true));assert.equal((await a.checkRemote(remoteUrl)).branches.length,1);results.push('通过：移除临时 CA 信任后 TLS 连接失败；重新固定 CA 后成功。全过程 sslVerify=true，从未使用关闭证书验证的配置。');
  results.push(`实际观测：${authenticatedRequests} 次已认证 HTTPS 请求，${tlsFailures} 次服务端观测到的 TLS 握手错误。`);
  const report=`# 隔离环境 HTTPS 真实验证\n\n执行时间：${new Date().toISOString()}。\n\n环境：${process.version}；${run(realGit,['--version'])}；${run('openssl',['version'])}。\n\n复现命令：\n\n\`\`\`sh\nnode --import tsx tests/fixtures/config-git/https-verification.ts\n\`\`\`\n\n脚本使用 Node HTTPS 服务和真实 git http-backend 提供 TLS smart HTTP，监听 127.0.0.1:${port}，GitRepositoryService 连接生产校验允许的 https://127.0.0.1:${port}/remote.git 地址，未使用 testTransport。临时 CA 签发带 IP SAN 的服务端证书，Git 通过临时 sslCAInfo 固定该 CA 且明确开启 sslVerify。临时 PATH git 启动器仅为子进程指定独立 GIT_CONFIG_GLOBAL 和 GIT_CONFIG_NOSYSTEM，不修改现有全局配置；临时 credential helper 提供 Basic 凭据，报告不记录密码或私钥。\n\n关键实际命令由脚本执行：openssl req 生成临时 CA/CSR；openssl x509 -req -CA ... -extfile ... 签发证书；git init --bare --initial-branch=main；git config http.receivepack true；服务端逐请求启动 git-http-backend。\n\n${results.map(x=>'- '+x).join('\n')}\n\n发现与修复复测：首次真实验证发现 HTTP 403 拒绝写权限被误分类为 REMOTE_UNKNOWN。父代理已修复 Git 错误匹配，将 requested URL returned error: 403 分类为 PUSH_REJECTED。本次真实 HTTPS 重跑显式断言 PUSH_REJECTED 并通过，同时再次确认本地提交保留、远端未变和恢复权限后的普通推送重试。本轮仅更新验证脚本和报告，未改动 src。该用例验证真实本地 TLS HTTPS 传输、证书校验和 Basic helper 认证，不代表 GitHub/GitLab 托管凭据策略、托管平台受保护分支、代理环境或浏览器端到端验收。\n\n清理：finally 关闭隔离 HTTPS 服务、恢复进程 PATH/XDG_CONFIG_HOME，并删除临时 CA、服务端私钥、凭据、Git 配置和所有副本。无现有远端写入，无生产全局配置修改。\n`;
  const evidence=resolve('docs/features/2026-11-06-config-git-storage/https-verification.md');await fs.writeFile(evidence,report);console.log(results.join('\n'));console.log(`报告：${evidence}`);
} finally {
  process.env.PATH=originalPath;if(originalXdg===undefined)delete process.env.XDG_CONFIG_HOME;else process.env.XDG_CONFIG_HOME=originalXdg;
  if(server){server.closeAllConnections();await new Promise<void>(r=>server!.close(()=>r()));}
  await fs.rm(root,{recursive:true,force:true});
}
