import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer as createHttpServer} from 'node:http';
import {once} from 'node:events';
import {createServer} from 'vite';
import config from '../vite.config.js';

test('development proxy canonicalizes its own loopback origin and preserves origins the backend must reject',async()=>{
 const backend=createHttpServer((request,response)=>{response.setHeader('Content-Type','application/json');response.end(JSON.stringify({host:request.headers.host,origin:request.headers.origin}));});
 backend.listen(0,'127.0.0.1');await once(backend,'listening');const target=`http://127.0.0.1:${(backend.address() as {port:number}).port}`;
 const proxy=config.server!.proxy!['/api'];assert.equal(typeof proxy,'object');
 const frontend=await createServer({...config,configFile:false,logLevel:'silent',optimizeDeps:{noDiscovery:true,include:[],entries:[]},server:{...config.server,port:0,watch:null,hmr:false,proxy:{'/api':{...(proxy as object),target}}}});
 try{
  await frontend.listen();const origin=`http://127.0.0.1:${(frontend.httpServer!.address() as {port:number}).port}`;
  const own=await fetch(origin+'/api/session',{method:'POST',headers:{Origin:origin}}).then(response=>response.json());assert.deepEqual(own,{host:new URL(target).host,origin:target});
  const get=await fetch(origin+'/api/session').then(response=>response.json());assert.deepEqual(get,{host:new URL(target).host});
  for(const other of ['http://example.invalid','http://localhost:9999','null']){const result=await fetch(origin+'/api/session',{method:'POST',headers:{Origin:other}}).then(response=>response.json());assert.equal(result.origin,other);assert.equal(result.host,new URL(target).host);}
 }finally{await frontend.close();backend.closeAllConnections();await new Promise<void>(resolve=>backend.close(()=>resolve()));}
});
