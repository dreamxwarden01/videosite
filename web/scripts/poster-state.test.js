'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {legacyPosterKey,jobPosterKey,ownedPosterKey,confirmedPosterKey}=require('../services/posterPaths');
const {migratePosterState}=require('../db/posterStateMigration');
const video={video_id:7,course_id:12,processing_job_id:'Job000000007',has_poster:1,poster_path:'posters/12/7/Job000000007.jpg'};
test('poster paths bind ownership and generation without broadening file capabilities',()=>{
 assert.equal(legacyPosterKey('0012',7),'posters/12/7.jpg');assert.equal(jobPosterKey(12,7,'Job000000007'),video.poster_path);
 assert.equal(confirmedPosterKey(video),video.poster_path);assert.equal(confirmedPosterKey({...video,has_poster:0}),null);
 assert.equal(confirmedPosterKey({...video,poster_path:null}),'posters/12/7.jpg');
 assert.equal(ownedPosterKey(video,'posters/12/7/Job000000008.jpg'),'posters/12/7/Job000000008.jpg');
 assert.equal(confirmedPosterKey({...video,poster_path:'posters/12/7/Job000000008.jpg'}),null);
 for(const key of ['posters/13/7.jpg','posters/12/8.jpg','posters/12/7/../x.jpg','/posters/12/7.jpg','https://example.invalid/p.jpg'])assert.equal(ownedPosterKey(video,key),null);
 for(const id of [0,-1,'12/3',NaN])assert.throws(()=>legacyPosterKey(id,7));
 assert.throws(()=>jobPosterKey(12,7,'../anything'));
});
test('additive migration preserves existing ready legacy posters without changing the frozen baseline',async()=>{
 const calls=[];await migratePosterState({async execute(sql){calls.push(sql);return [[]]}});
 assert.match(calls[1],/^ALTER TABLE videos ADD COLUMN poster_path/);assert.match(calls.at(-1),/WHERE has_poster=1 AND poster_path IS NULL/);assert.ok(calls.some(sql=>/ADD INDEX idx_processing_job_id/.test(sql)));
 const again=[];await migratePosterState({async execute(sql){again.push(sql);return [[{COLUMN_NAME:'poster_path'}]]}});assert.equal(again.length,3);assert.ok(!again.some(sql=>sql.startsWith('ALTER')));
});
function routeFixture(){
 const routes=new Map(),calls=[];const auth=()=>{};const process={async confirmPosterReady(...args){calls.push(args);return args[0]==='Job000000007'&&args[1]==='worker-A';}};
 const deps={'../../services/workerAuthService':{},'../../middleware/workerAuth':{requireWorkerSession:auth},'../../middleware/auth':{},'../../services/ipHelpers':{},'../../services/processingService':process,express:{Router:()=>({post(route,...handlers){routes.set('POST '+route,handlers)},get(){}})}};
 const module={exports:{}};vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../routes/api/worker.js'),'utf8'),{module,exports:module.exports,console:{error(){}},require(name){assert.ok(Object.hasOwn(deps,name),name);return deps[name]}});
 const handlers=routes.get('POST /worker/tasks/poster-ready');assert.equal(handlers[0],auth);
 return {calls,async request(body,key='worker-A'){const res={code:200,status(n){this.code=n;return this},json(body){this.body=body;return this},end(){return this}};await handlers[1]({body,worker:{keyId:key}},res);return res;}};
}
test('poster acknowledgement route requires its authenticated lease owner and closed job-only payload',async()=>{
 const f=routeFixture();assert.equal((await f.request({jobId:'Job000000007'})).code,204);assert.deepEqual(f.calls,[['Job000000007','worker-A']]);
 assert.equal((await f.request({jobId:'Job000000007'},'worker-B')).code,404);
 for(const body of [null,[],{}, {jobId:7},{jobId:'wrong'},{jobId:'Job000000007',posterPath:'foreign.jpg'}])assert.equal((await f.request(body)).code,400);
 assert.equal(f.calls.length,2);
});

async function uploadHttpFixture(options={}) {
 const express=require('express'),app=express(),calls=[];
 const state={upload_id:'Upload000008',video_id:options.newUpload?null:7,course_id:12,created_by:'actor-A',status:'active',object_key:options.objectKey||'source/Upload000008/source.mp4',original_filename:'replacement.mp4'};
 let replacements=0,cacheFailure=!options.noCacheFailure;
 const auth=(req,res,next)=>{if(!req.get('x-actor'))return res.status(401).end();res.locals.user={user_id:req.get('x-actor')};next()};
 const permission=()=> (req,res,next)=>{if(req.get('x-allow')!=='yes')return res.status(403).end();next()};
 const deps={express,path:require('node:path'),'../../middleware/auth':{requireAuth:auth},'../../middleware/permissions':{checkPermission:permission},
  '../../config/database':{getPool:()=>({}),idBuf:x=>x},'../../services/videoService':{},'../../services/deletionService':{},'../../services/courseService':{},
  '../../services/processingService':{async replaceVideoSource(session,size,receiptOnly=false){calls.push(['replace',receiptOnly]);assert.equal(session.upload_id,state.upload_id);if(state.status==='completed'){assert.equal(receiptOnly,true);assert.equal(size,null);return true}assert.equal(receiptOnly,false);assert.equal(size,1024);replacements++;state.status='completed';state.completed_at=123;if(cacheFailure){cacheFailure=false;throw Error('synthetic_cache_failure_after_commit')}return true}},
  '../../services/uploadService':{async completeMultipartUpload(){calls.push(['r2-complete']);if(options.completeError)throw options.completeError},async getObjectSize(_key,opts={}){calls.push(['r2-head',opts.strict===true]);if(options.headError)throw options.headError;return options.missing?null:1024}},
  '../../services/uploadSessionService':{async getSession(id){calls.push(['session']);return id===state.upload_id?{...state}:null},async markCompleting(){state.status='completing'},async markAborted(){state.status='aborted';calls.push(['aborted'])},async markCompleted(){calls.push(['receipt-effects']);state.status='completed';state.completed_at??=123}},
 };
 const module={exports:{}};vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../routes/api/upload.js'),'utf8'),{module,exports:module.exports,Buffer,console:{log(){},error(){}},require(name){assert.ok(Object.hasOwn(deps,name),name);return deps[name]}});
 app.use(express.json());app.use('/api',module.exports);const server=require('node:http').createServer(app);
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)});
 const url='http://127.0.0.1:'+server.address().port+'/api/upload/Upload000008/complete';
 return{calls,state,get replacements(){return replacements},request:async(actor='actor-A',allow=true)=>fetch(url,{method:'POST',headers:{'content-type':'application/json',...(actor?{'x-actor':actor}:{}),'x-allow':allow?'yes':'no'},body:JSON.stringify({parts:[{PartNumber:1,ETag:'synthetic'}]})}),close:()=>new Promise(resolve=>server.close(resolve))};
}

test('replacement HTTP retry uses its same-owner committed receipt without repeating storage or attempt reset',async()=>{
 const f=await uploadHttpFixture();try{
  let r=await f.request();assert.equal(r.status,500);await r.text();assert.equal(f.state.status,'completed');assert.equal(f.replacements,1);
  r=await f.request();assert.equal(r.status,204);await r.text();assert.equal(f.replacements,1);assert.equal(f.state.completed_at,123);
  assert.equal(f.calls.filter(x=>x[0]==='r2-complete').length,1);assert.equal(f.calls.filter(x=>x[0]==='r2-head').length,1);assert.deepEqual(f.calls.filter(x=>x[0]==='replace').map(x=>x[1]),[false,true]);
  const before=f.calls.length;r=await f.request('actor-B');assert.equal(r.status,403);await r.text();assert.deepEqual(f.calls.slice(before),[['session']]);
  const denied=f.calls.length;r=await f.request(null);assert.equal(r.status,401);await r.text();r=await f.request('actor-A',false);assert.equal(r.status,403);await r.text();assert.equal(f.calls.length,denied);
 }finally{await f.close()}
});

function workerSessionFixture({cached,rows=[],expireAfterRead=false}={}){
 let hash=cached?{...cached}:{},expire=expireAfterRead;const sql=[],commands=[],logs=[];
 const redis={async hgetall(){const result={...hash};if(expire){hash={};expire=false;}return result},multi(){const operations=[];const tx={hset(key,a,b){operations.push(['hset',key,a,b]);return tx},expire(...a){operations.push(['expire',...a]);return tx},sadd(...a){operations.push(['sadd',...a]);return tx},srem(...a){operations.push(['srem',...a]);return tx},del(...a){operations.push(['del',...a]);return tx},async exec(){commands.push(...operations);for(const op of operations){if(op[0]==='del')hash={};if(op[0]==='hset'){if(typeof op[2]==='object')Object.assign(hash,op[2]);else hash[op[2]]=op[3]}}return operations.map(()=>[null,1])}};return tx}};
 const deps={'../config/database':{getPool:()=>({async execute(query,args){sql.push({query,args});return query.startsWith('SELECT')?[rows]:[{affectedRows:1}]}})},'../services/redis':{getClient:()=>redis},'../services/workerAuthService':{workerSessionKey:t=>'session:worker:'+t,WORKER_TTL_SECONDS:3600,DIRTY_WORKER_SESSIONS:'dirty:worker'},'./auth':{getClientIp:req=>req.ip},'../services/ipHelpers':require('../services/ipHelpers'),'../lib/workerIdentity':require('../lib/workerIdentity')};
 const module={exports:{}};vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../middleware/workerAuth.js'),'utf8'),{module,exports:module.exports,Date,console:{warn:(...x)=>logs.push(x),error:(...x)=>logs.push(x)},require(name){assert.ok(Object.hasOwn(deps,name),name);return deps[name]}});
 return{sql,commands,logs,get hash(){return hash},async request(ip='192.0.2.10'){let next=false;const req={headers:{authorization:'Bearer synthetic-token'},ip},res={code:200,status(c){this.code=c;return this},json(body){this.body=body;return this}};await module.exports.requireWorkerSession(req,res,()=>{next=true});return{req,res,next}}};
}
const fullWorkerCache={session_id:'session-A',worker_key_id:'worker-A',ip_address:'192.0.2.10',last_seen:String(Date.now())};
test('partial worker cache cannot provide a nullable owner or delete an unknown SQL session',async()=>{
 for(const cached of [{ip_address:'192.0.2.99',last_seen:String(Date.now())},{...fullWorkerCache,session_id:''},{...fullWorkerCache,worker_key_id:undefined},{...fullWorkerCache,worker_key_id:null},{...fullWorkerCache,ip_address:''}]){
  const f=workerSessionFixture({cached});const result=await f.request('192.0.2.100');assert.equal(result.res.code,401);assert.equal(result.next,false);assert.equal(result.req.worker,undefined);assert.equal(f.sql.length,0);assert.ok(f.commands.some(x=>x[0]==='del'));assert.ok(!f.commands.some(x=>x[0]==='hset'));
 }
});
test('a refresh racing Redis expiry cannot authenticate the next request from a partial IP-only hash',async()=>{
 const f=workerSessionFixture({cached:{...fullWorkerCache,ip_address:'2001:db8:1:2::1'},expireAfterRead:true});let result=await f.request('2001:db8:1:2::2');assert.equal(result.next,true);assert.equal(result.req.worker.keyId,'worker-A');assert.equal(f.hash.worker_key_id,undefined);assert.ok(f.hash.ip_address);
 result=await f.request('2001:db8:1:2::2');assert.equal(result.res.code,401);assert.equal(result.next,false);assert.equal(result.req.worker,undefined);assert.equal(f.sql.length,0);
});
test('cold malformed identities fail before warming or SQL deletion while complete identities retain binding',async()=>{
 for(const row of [{...fullWorkerCache,worker_key_id:null,last_seen:new Date()},{...fullWorkerCache,last_seen:'not-a-date'}]){const f=workerSessionFixture({rows:[row]});const r=await f.request();assert.equal(r.res.code,401);assert.equal(r.next,false);assert.equal(f.sql.length,1);assert.match(f.sql[0].query,/^SELECT/);assert.ok(!f.commands.some(x=>x[0]==='hset'));}
 const valid=workerSessionFixture({cached:fullWorkerCache});const r=await valid.request();assert.equal(r.next,true);assert.equal(r.req.worker.sessionId,'session-A');assert.equal(r.req.worker.keyId,'worker-A');assert.equal(valid.sql.length,0);
 const changed=workerSessionFixture({cached:fullWorkerCache});const denied=await changed.request('192.0.2.11');assert.equal(denied.res.code,401);assert.equal(changed.sql.length,1);assert.deepEqual(Array.from(changed.sql[0].args),['session-A']);
});
test('strict size recovery distinguishes missing objects from forbidden or unavailable storage',async()=>{
 let failure=null;const Cmd=class{constructor(input){this.input=input}};const deps={'@aws-sdk/client-s3':{CreateMultipartUploadCommand:Cmd,UploadPartCommand:Cmd,CompleteMultipartUploadCommand:Cmd,AbortMultipartUploadCommand:Cmd,HeadObjectCommand:Cmd},'@aws-sdk/s3-request-presigner':{},'../config/r2':{getR2Client:()=>({async send(cmd){assert.equal(cmd.input.Key,'source/Upload000008/source.mp4');if(failure)throw failure;return{ContentLength:1024}}}),getR2BucketName:()=> 'synthetic'}};
 const module={exports:{}};vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../services/uploadService.js'),'utf8'),{module,exports:module.exports,require(name){assert.ok(Object.hasOwn(deps,name),name);return deps[name]}});
 const size=module.exports.getObjectSize,key='source/Upload000008/source.mp4';assert.equal(await size(key,{strict:true}),1024);
 failure={name:'NotFound',$metadata:{httpStatusCode:404}};assert.equal(await size(key,{strict:true}),null);
 for(const error of [{name:'AccessDenied',$metadata:{httpStatusCode:403}},{name:'InternalError',$metadata:{httpStatusCode:500}},{name:'NotFound',$metadata:{httpStatusCode:403}},Error('network failed')]){failure=error;await assert.rejects(size(key,{strict:true}),e=>e===error);}
});


test('NoSuchUpload recovery is restricted to its replacement object and never masks other storage failures',async()=>{
 const gone={name:'NoSuchUpload',$metadata:{httpStatusCode:404}};
 for(const options of [
  {completeError:gone,missing:true,expected:422,aborted:true,head:true},
  {completeError:gone,headError:{name:'AccessDenied',$metadata:{httpStatusCode:403}},expected:500,head:true},
  {completeError:gone,headError:{name:'InternalError',$metadata:{httpStatusCode:500}},expected:500,head:true},
  {completeError:{name:'AccessDenied',$metadata:{httpStatusCode:403}},expected:500},
  {completeError:{name:'InternalError',$metadata:{httpStatusCode:500}},expected:500},
  {completeError:{name:'NoSuchUpload',$metadata:{httpStatusCode:503}},expected:500},
  {completeError:gone,objectKey:'source/Other0000001/source.mp4',expected:500},
  {completeError:gone,newUpload:true,expected:500},
 ]){const f=await uploadHttpFixture(options);try{const response=await f.request();assert.equal(response.status,options.expected);await response.text();assert.equal(f.replacements,0);assert.equal(f.calls.filter(x=>x[0]==='r2-head').length,options.head?1:0);if(options.head)assert.equal(f.calls.find(x=>x[0]==='r2-head')[1],true);assert.equal(f.state.status,options.aborted?'aborted':'completing');}finally{await f.close()}}
});
