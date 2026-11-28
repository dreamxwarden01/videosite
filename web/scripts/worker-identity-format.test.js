'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const {isWorkerKeyId,isWorkerSessionId}=require('../lib/workerIdentity');
test('actual worker key and session generators satisfy the authenticated identity validators',async()=>{
 let sessionIdentity,cacheIdentity;
 const pool={async execute(sql,args){if(sql.startsWith('SELECT bearer_token'))return[[]];if(sql.includes('INSERT INTO worker_sessions'))sessionIdentity={sessionId:args[0],keyId:args[1]};return[{affectedRows:1}]}};
 const chain={hset(_key,data){cacheIdentity={sessionId:data.session_id,keyId:data.worker_key_id};return this},expire(){return this},async exec(){return[]}};
 const deps={crypto,argon2:{async hash(){return'synthetic-hash'}},'../config/database':{getPool:()=>pool,idBuf:x=>x},'./redis':{getClient:()=>({multi:()=>chain})},'./ipHelpers':require('../services/ipHelpers')};
 const module={exports:{}};vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../services/workerAuthService.js'),'utf8'),{module,exports:module.exports,Date,console,require(name){assert.ok(Object.hasOwn(deps,name),name);return deps[name]}});
 const generated=await module.exports.generateWorkerKeyPair('synthetic', 'synthetic-user');
 assert.equal(isWorkerKeyId(generated.keyId),true);assert.equal(generated.keyId.length,35);
 await module.exports.createWorkerSession(generated.keyId,'127.0.0.1');
 assert.equal(isWorkerSessionId(sessionIdentity.sessionId),true);assert.equal(sessionIdentity.sessionId.length,16);
 assert.equal(isWorkerKeyId(sessionIdentity.keyId),true);assert.deepEqual(cacheIdentity,sessionIdentity);
});
