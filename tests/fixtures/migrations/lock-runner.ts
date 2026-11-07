import { DirectoryLease } from '../../../src/migrations/lock.js';
try{DirectoryLease.acquire(process.argv[2]!);process.send!('acquired');}catch{process.send!('blocked');}
setInterval(()=>{},1000);
