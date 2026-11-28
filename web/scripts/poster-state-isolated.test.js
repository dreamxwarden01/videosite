'use strict';
// Uses only the disposable MariaDB URI supplied by run-deletion-tests.mjs.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const enabled=process.env.VS_DELETION_ISOLATED_TEST==='1';
const paths=require('../services/posterPaths'),{migratePosterState}=require('../db/posterStateMigration');
const JOB='Job000000007',NEXT='Job000000008',KEY='worker-A',hash='P'.repeat(64);
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r});return{promise,resolve}};
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function load(file,deps){const module={exports:{}};vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../'+file),'utf8'),{module,exports:module.exports,Date,Set,Map,Number,setTimeout,clearTimeout,console:{log(){},warn(){},error(){}},require(name){if(!Object.hasOwn(deps,name))throw Error('Unexpected dependency '+name);return deps[name]}},{filename:file});return module.exports;}

test('confirmed poster state follows current lease, storage generation and terminal transactions',{skip:!enabled},async t=>{
 const url=new URL(process.env.VS_TEST_DB_URI||'invalid:');if(url.protocol!=='mysql:'||url.hostname!=='127.0.0.1'||!/^\/vs_delete_test_[a-z0-9]+$/.test(url.pathname))throw Error('disposable_fixture_required');
 const pool=require('mysql2/promise').createPool({host:url.hostname,port:Number(url.port),user:decodeURIComponent(url.username),password:decodeURIComponent(url.password),database:url.pathname.slice(1),connectionLimit:10});
 const dbModule=require('../config/database'),prior=dbModule.getPool;dbModule.getPool=()=>pool;delete require.cache[require.resolve('../services/deletionService')];const deletion=require('../services/deletionService');
 const cacheRows=new Map(),videoRows=new Map();
 const drop=async()=>{for(const n of ['watch_progress','upload_sessions','processing_queue','videos','courses','pending_deletes'])await pool.query('DROP TABLE IF EXISTS '+n)};
 const seed=async({status='processing',queue='processing',ready=0,poster=null,job=JOB,owner=KEY}={})=>{
  cacheRows.clear();videoRows.clear();await pool.query('DELETE FROM courses');await pool.query('DELETE FROM pending_deletes');
  await pool.execute('INSERT INTO courses(course_id,audio_normalization) VALUES(12,1)');
  await pool.execute(`INSERT INTO videos(video_id,course_id,title,hashed_video_id,status,processing_job_id,r2_source_key,has_poster,poster_path)
   VALUES(7,12,'Synthetic',?,?,?,?,?,?)`,[hash,status,job,'source/Upload000007/source.mp4',ready,poster]);
  await pool.execute('INSERT INTO processing_queue(video_id,status,job_id,worker_key_id) VALUES(7,?,?,?)',[queue,job,owner]);
  if(job)cacheRows.set(job,{video_id:7,course_id:12,hashed_video_id:hash,last_heartbeat:Date.now()-130000});
 };
 const snapshot=async()=>{const [[v]]=await pool.query('SELECT * FROM videos WHERE video_id=7');const [[q]]=await pool.query('SELECT * FROM processing_queue WHERE video_id=7');const [pending]=await pool.query('SELECT mode,target,execute_at FROM pending_deletes ORDER BY id');return{v,q,pending}};
 function service(options={}){
  const effects=[],timers=[],queries=[];let invalidations=0,cacheReads=0;
  const cache={async invalidate(id){effects.push(['invalidate',id]);if(++invalidations===options.failInvalidate)throw Error('synthetic_cache_failure');videoRows.delete(String(id))}};
  const transcode={async getProgress(id){cacheReads++;if(options.getProgress)return options.getProgress(id,cacheReads);return cacheRows.get(id)||null},async clearJob(id){effects.push(['clearJob',id]);cacheRows.delete(id)},async initOnLease(id,vid,h,cid){effects.push(['init',id]);cacheRows.set(id,{video_id:vid,course_id:cid,hashed_video_id:h,last_heartbeat:Date.now()});await options.afterInit?.(id)},async recordHeartbeat(id){effects.push(['heartbeat',id]);const row=cacheRows.get(id);if(row)row.last_heartbeat=Date.now();return !!row}};
  const wrapped={execute:async(sql,args)=>{queries.push(sql);const r=await pool.execute(sql,args);if(/^SELECT video_id FROM processing_queue WHERE job_id/.test(sql))await options.afterLookup?.();return r},getConnection:async()=>{
   const db=await pool.getConnection();return new Proxy(db,{get(target,key){
    if(key==='execute')return async(sql,args)=>{if(options.failEnqueue&&/INSERT INTO pending_deletes/.test(sql))throw Error('synthetic_enqueue_failure');const r=await target.execute(sql,args);if(sql==='UPDATE videos SET has_poster=1 WHERE video_id=?')await options.afterReady?.();if(/UPDATE videos SET status='queued'/.test(sql))await options.afterReset?.();return r};
    if(key==='commit'&&options.lostCommitReply)return async()=>{await target.commit();throw Error('synthetic_lost_commit_reply')};
    const value=target[key];return typeof value==='function'?value.bind(target):value;
   }});
  }};
  const lifecycle=load('services/posterLifecycle.js',{'../config/database':{getPool:()=>wrapped},'./cache/videoCache':cache,'./posterPaths':paths,'./deletionService':deletion,'../lib/workerIdentity':require('../lib/workerIdentity')});
  const background={timeout(fn){const h={unref(){}};timers.push({fn,h});return h},cancel(){}};
  const proc=load('services/processingService.js',{
   '../lib/backgroundTasks':background,crypto:require('node:crypto'),'../config/database':{getPool:()=>wrapped},
   './cache/videoCache':cache,'./cache/transcodeProgressCache':transcode,'./cache/queueCache':{async markHasWork(){effects.push(['work'])}},
   './posterLifecycle':lifecycle,'./posterPaths':paths,'./deletionService':deletion,'../lib/workerIdentity':require('../lib/workerIdentity'),
   '@aws-sdk/client-s3':{PutObjectCommand:class{constructor(input){this.input=input}},GetObjectCommand:class{constructor(input){this.input=input}}},
   '@aws-sdk/s3-request-presigner':{async getSignedUrl(_client,command){const [[visible]]=await pool.query('SELECT poster_path FROM videos WHERE video_id=7');if(command.input.Key.startsWith('posters/'))assert.equal(visible.poster_path,command.input.Key,'path must commit before URL issuance');return 'https://storage.example.invalid/'+command.input.Key}},
   '../config/r2':{getR2Client:()=>({}),getR2BucketName:()=> 'synthetic'},
   './transcodingProfileService':{async getEffectiveProfiles(){return[]},async getAudioNormalizationSettings(){return{enabled:false,target:-16,peak:-1,maxGain:10}},async getAudioBitrateDefault(){return 128}},
   './cache/watchProgressCache':{async clearForVideo(id){effects.push(['watch',id])}},
  });return{proc,lifecycle,effects,timers,cache,queries};
 }
 try{
  await drop();await pool.query('CREATE TABLE courses(course_id INT UNSIGNED PRIMARY KEY,audio_normalization TINYINT DEFAULT 1) ENGINE=InnoDB');
  await pool.query(`CREATE TABLE videos(video_id INT UNSIGNED PRIMARY KEY,course_id INT UNSIGNED NOT NULL,title VARCHAR(255) NOT NULL,description TEXT,module_number VARCHAR(50),lecture_date DATE,hashed_video_id VARCHAR(64) NOT NULL,status VARCHAR(32),processing_job_id VARCHAR(64),processing_progress INT DEFAULT 0,processing_error TEXT,r2_source_key VARCHAR(500),has_poster TINYINT DEFAULT 0,encryption_key VARBINARY(16),duration_seconds INT,original_filename VARCHAR(255),file_size_bytes BIGINT,video_type VARCHAR(16) DEFAULT 'cmaf',FOREIGN KEY(course_id) REFERENCES courses(course_id) ON DELETE CASCADE) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await pool.query(`CREATE TABLE processing_queue(task_id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,video_id INT UNSIGNED NOT NULL UNIQUE,status VARCHAR(32) DEFAULT 'queued',job_id VARCHAR(64),worker_key_id VARCHAR(64),leased_at DATETIME,last_heartbeat DATETIME,pending_until DATETIME,progress INT DEFAULT 0,error_message TEXT,error_at DATETIME,cleared TINYINT DEFAULT 0,created_at DATETIME DEFAULT CURRENT_TIMESTAMP,FOREIGN KEY(video_id) REFERENCES videos(video_id) ON DELETE CASCADE) ENGINE=InnoDB`);
  await pool.query(`CREATE TABLE upload_sessions(upload_id VARCHAR(12) PRIMARY KEY,course_id INT UNSIGNED,video_id INT UNSIGNED,object_key VARCHAR(500),original_filename VARCHAR(255),status VARCHAR(16),completed_at DATETIME,FOREIGN KEY(video_id) REFERENCES videos(video_id) ON DELETE CASCADE) ENGINE=InnoDB`);
  await pool.query('CREATE TABLE watch_progress(video_id INT UNSIGNED PRIMARY KEY,position INT,FOREIGN KEY(video_id) REFERENCES videos(video_id) ON DELETE CASCADE) ENGINE=InnoDB');
  const schema=fs.readFileSync(path.join(__dirname,'../db/schema.sql'),'utf8'),start=schema.indexOf('CREATE TABLE IF NOT EXISTS `pending_deletes`'),end=schema.indexOf('CREATE TABLE IF NOT EXISTS `processing_queue`',start);await pool.query(schema.slice(start,end));
  await t.test('migration backfills legacy ready paths, keeps modern paths and is restart-idempotent',async()=>{
   await pool.execute('INSERT INTO courses(course_id) VALUES(12)');await pool.execute("INSERT INTO videos(video_id,course_id,title,hashed_video_id,status,has_poster) VALUES(7,12,'Legacy',?,'finished',1)",[hash]);await migratePosterState(pool);let {v}=await snapshot();assert.equal(v.poster_path,'posters/12/7.jpg');await pool.execute('UPDATE videos SET poster_path=? WHERE video_id=7',[paths.jobPosterKey(12,7,JOB)]);await migratePosterState(pool);({v}=await snapshot());assert.equal(v.poster_path,paths.jobPosterKey(12,7,JOB));
  });
  await t.test('planned poster stays unavailable until current-owner PUT acknowledgement; duplicate is harmless',async()=>{
   await seed();const f=service();const urls=await f.proc.generateUploadUrls(JOB,['poster.jpg'],KEY);assert.match(urls.urls['poster.jpg'],/posters\/12\/7\/Job000000007.jpg$/);let a=await snapshot();assert.equal(a.v.has_poster,0);assert.equal(a.v.poster_path,paths.jobPosterKey(12,7,JOB));assert.equal(await f.lifecycle.confirmPosterReady(JOB,'other-worker'),false);assert.equal((await snapshot()).v.has_poster,0);assert.equal(await f.lifecycle.confirmPosterReady(JOB,KEY),true);const n=(await snapshot()).pending.length;assert.equal(await f.lifecycle.confirmPosterReady(JOB,KEY),true);a=await snapshot();assert.equal(a.v.has_poster,1);assert.equal(a.pending.length,n);assert.ok(f.effects.filter(x=>x[0]==='invalidate').length>=3);
  });
  await t.test('missing upload intent, stale id, wrong owner and generation mismatch never activate',async()=>{
   await seed();const f=service();assert.equal(await f.lifecycle.confirmPosterReady(JOB,KEY),false);assert.equal(await f.proc.generateUploadUrls(JOB,['poster.jpg'],'other-worker'),null);assert.equal(await f.lifecycle.confirmPosterReady(NEXT,KEY),false);await pool.execute('UPDATE videos SET poster_path=? WHERE video_id=7',[paths.jobPosterKey(12,7,NEXT)]);assert.equal(await f.lifecycle.confirmPosterReady(JOB,KEY),false);assert.equal((await snapshot()).v.has_poster,0);
  });
  await t.test('cache invalidation failure is retried after SQL readiness committed',async()=>{
   await seed({poster:paths.jobPosterKey(12,7,JOB)});const f=service({failInvalidate:1});videoRows.set('7',{has_poster:0});await assert.rejects(f.lifecycle.confirmPosterReady(JOB,KEY),/synthetic_cache_failure/);assert.equal((await snapshot()).v.has_poster,1);assert.ok(videoRows.has('7'));assert.equal(await f.lifecycle.confirmPosterReady(JOB,KEY),true);assert.ok(!videoRows.has('7'));
  });
  await t.test('lost acknowledgement commit response is resolved by idempotent retry',async()=>{
   await seed({poster:paths.jobPosterKey(12,7,JOB)});await assert.rejects(service({lostCommitReply:true}).lifecycle.confirmPosterReady(JOB,KEY),/synthetic_lost_commit_reply/);assert.equal((await snapshot()).v.has_poster,1);assert.equal(await service().lifecycle.confirmPosterReady(JOB,KEY),true);
  });
  await t.test('failure retires only its poster generation and cannot be resurrected by completion or a late acknowledgement',async()=>{
   await seed({ready:1,poster:paths.jobPosterKey(12,7,JOB)});const f=service();assert.equal((await f.proc.reportError(JOB,'Synthetic encoding failure',KEY)).found,true);let a=await snapshot();assert.equal(a.v.status,'error');assert.equal(a.v.has_poster,0);assert.equal(a.v.poster_path,null);assert.equal(a.pending[0].target,paths.jobPosterKey(12,7,JOB));assert.ok(a.pending[0].execute_at.getTime()-Date.now()>115000);assert.equal(await f.lifecycle.confirmPosterReady(JOB,KEY),false);assert.equal(await f.proc.completeTask(JOB,10,true,KEY),false);a=await snapshot();assert.equal(a.v.status,'error');
  });
  await t.test('worker-facing helpers reject missing owners before any authority query or mutation',async()=>{
   await seed({ready:1,poster:paths.jobPosterKey(12,7,JOB)});const f=service();for(const owner of [undefined,null,'',' ',12]){assert.equal(await f.lifecycle.preparePosterUpload(JOB,owner),null);assert.equal(await f.lifecycle.confirmPosterReady(JOB,owner),false);assert.equal(await f.proc.completeTask(JOB,1,true,owner),false);assert.equal(await f.proc.generateUploadUrls(JOB,['poster.jpg'],owner),null);assert.equal(await f.proc.generateUploadUrls(JOB,['video/720p/init.mp4'],owner),null);assert.equal((await f.proc.reportJobStatuses([{jobId:JOB,status:'running'}],owner))[0].ack,false);assert.equal(await f.proc.abortAndRequeue(JOB,owner),false);assert.equal((await f.proc.reportError(JOB,'x',owner)).found,false);assert.equal((await f.proc.leaseTask(7,owner)).status,'notfound');}assert.equal(f.queries.length,0);assert.deepEqual(f.effects,[]);assert.equal((await snapshot()).v.has_poster,1);
  });
  await t.test('foreign terminal reports leave another worker poster, task and heartbeat untouched',async()=>{
   await seed({ready:1,poster:paths.jobPosterKey(12,7,JOB)});const f=service();assert.equal((await f.proc.reportError(JOB,'foreign','worker-B')).found,false);assert.equal(await f.proc.abortAndRequeue(JOB,'worker-B'),false);assert.equal(await f.proc.completeTask(JOB,3,true,'worker-B'),false);assert.equal((await snapshot()).v.has_poster,1);assert.ok(cacheRows.has(JOB));assert.deepEqual(f.effects,[]);
  });
  await t.test('abort clears readiness and path atomically; new attempt uses a different immutable key',async()=>{
   await seed({ready:1,poster:paths.jobPosterKey(12,7,JOB)});const f=service();assert.equal(await f.proc.abortAndRequeue(JOB,KEY),true);let a=await snapshot();assert.equal(a.v.has_poster,0);assert.equal(a.v.poster_path,null);assert.equal(a.v.processing_job_id,null);assert.equal(a.q.job_id,null);await pool.execute("UPDATE processing_queue SET status='pending' WHERE video_id=7");const leased=await f.proc.leaseTask(7,KEY);assert.equal(leased.isLeaseSuccess,true);assert.notEqual(leased.jobId,JOB);const result=await f.proc.generateUploadUrls(leased.jobId,['poster.jpg'],KEY);assert.ok(result.urls['poster.jpg'].includes('/'+leased.jobId+'.jpg'));a=await snapshot();assert.ok(a.pending.some(x=>x.target===paths.jobPosterKey(12,7,JOB)));assert.ok(!a.pending.some(x=>x.target===a.v.poster_path));assert.equal(await f.lifecycle.confirmPosterReady(JOB,KEY),false);
  });
  await t.test('lease metadata-cache failure retains a recovery timer and a missing-cache dead lease requeues',async()=>{
   await seed({status:'queued',queue:'pending',job:null});const f=service({failInvalidate:1});await assert.rejects(f.proc.leaseTask(7,KEY),/synthetic_cache_failure/);assert.equal((await snapshot()).q.status,'leased');assert.equal(cacheRows.size,0);assert.equal(f.timers.length,1);await f.timers[0].fn();assert.equal((await snapshot()).q.status,'queued');assert.equal((await snapshot()).v.has_poster,0);
  });
  await t.test('a retired lease cannot leave a late live Redis marker or return its old work',async()=>{
   await seed({status:'queued',queue:'pending',job:null});const f=service({afterInit:async id=>{assert.equal(await service().proc.abortAndRequeue(id,KEY),true)}});const result=await f.proc.leaseTask(7,KEY);assert.equal(result.status,'notfound');assert.equal(cacheRows.size,0);assert.equal((await snapshot()).q.status,'queued');
  });
  await t.test('cleanup insertion failure rolls task/readiness back together',async()=>{
   await seed({ready:1,poster:paths.jobPosterKey(12,7,JOB)});await assert.rejects(service({failEnqueue:true}).proc.abortAndRequeue(JOB,KEY),/synthetic_enqueue_failure/);const a=await snapshot();assert.equal(a.v.has_poster,1);assert.equal(a.v.poster_path,paths.jobPosterKey(12,7,JOB));assert.equal(a.q.job_id,JOB);assert.equal(a.pending.length,0);
  });
  await t.test('acknowledgement before abort is cleared by the later transaction',async()=>{
   await seed({poster:paths.jobPosterKey(12,7,JOB)});const entered=deferred(),release=deferred();const first=service({afterReady:async()=>{entered.resolve();await release.promise}}).lifecycle.confirmPosterReady(JOB,KEY);await entered.promise;let settled=false;const second=service().proc.abortAndRequeue(JOB,KEY).then(x=>{settled=true;return x});await delay(60);assert.equal(settled,false);release.resolve();assert.equal(await first,true);assert.equal(await second,true);const a=await snapshot();assert.equal(a.v.has_poster,0);assert.equal(a.v.poster_path,null);
  });
  await t.test('abort before delayed acknowledgement fences its stale read',async()=>{
   await seed({poster:paths.jobPosterKey(12,7,JOB)});const read=deferred(),release=deferred();const ack=service({afterLookup:async()=>{read.resolve();await release.promise}}).lifecycle.confirmPosterReady(JOB,KEY);await read.promise;await service().proc.abortAndRequeue(JOB,KEY);release.resolve();assert.equal(await ack,false);assert.equal((await snapshot()).v.has_poster,0);
  });
  await t.test('completion accepts legacy workers and generation-aware workers; duplicate cannot invent a missing poster',async()=>{
   for(const planned of [null,paths.jobPosterKey(12,7,JOB)]){await seed({poster:planned});const f=service();assert.equal(await f.proc.completeTask(JOB,55,true,KEY),true);let a=await snapshot();assert.equal(a.v.status,'finished');assert.equal(a.v.has_poster,1);assert.equal(a.v.poster_path,planned||'posters/12/7.jpg');assert.equal(a.v.r2_source_key,null);assert.ok(a.pending.some(x=>x.target==='source/Upload000007/'));const n=a.pending.length;assert.equal(await f.proc.completeTask(JOB,55,true,KEY),true);assert.equal((await snapshot()).pending.length,n);assert.equal(await f.lifecycle.confirmPosterReady(JOB,KEY),true);}
   await seed();const f=service();assert.equal(await f.proc.completeTask(JOB,10,false,KEY),true);assert.equal(await f.proc.completeTask(JOB,10,true,KEY),true);assert.equal((await snapshot()).v.has_poster,0);assert.equal(await f.lifecycle.confirmPosterReady(JOB,KEY),false);
  });
  await t.test('retry and stale resets clear poster status while retaining source for reprocessing',async()=>{
   await seed({status:'error',queue:'error',ready:1,poster:paths.jobPosterKey(12,7,JOB)});const f=service();assert.equal(await f.proc.retryFailedVideo(7),true);let a=await snapshot();assert.equal(a.v.has_poster,0);assert.equal(a.v.r2_source_key,'source/Upload000007/source.mp4');
   await seed({ready:1,poster:paths.jobPosterKey(12,7,JOB)});assert.equal(await f.proc.resetStaleTasks(),1);a=await snapshot();assert.equal(a.q.status,'queued');assert.equal(a.v.has_poster,0);assert.equal(a.v.poster_path,null);
  });
  await t.test('replacement atomically retires old poster and records receipt; late acknowledgement and replay cannot touch the new generation',async()=>{
   await seed({ready:1,poster:paths.jobPosterKey(12,7,JOB)});await pool.execute("INSERT INTO upload_sessions VALUES('Upload000008',12,7,'source/Upload000008/source.mp4','replacement.mp4','completing',NULL)");await pool.execute('INSERT INTO watch_progress VALUES(7,20)');const session={upload_id:'Upload000008',video_id:7,object_key:'source/Upload000008/source.mp4'},f=service();assert.equal(await f.proc.replaceVideoSource(session,1234),true);let a=await snapshot();assert.equal(a.v.has_poster,0);assert.equal(a.v.poster_path,null);assert.equal(a.v.r2_source_key,session.object_key);assert.equal(a.q.status,'queued');assert.ok(a.pending.some(x=>x.target===paths.jobPosterKey(12,7,JOB)));assert.ok(!a.pending.some(x=>x.target==='source/Upload000008/'));assert.equal(await f.lifecycle.confirmPosterReady(JOB,KEY),false);const n=a.pending.length;assert.equal(await f.proc.replaceVideoSource(session,1234),true);assert.equal((await snapshot()).pending.length,n);const [[receipt]]=await pool.query("SELECT status FROM upload_sessions WHERE upload_id='Upload000008'");assert.equal(receipt.status,'completed');const [[watch]]=await pool.query('SELECT COUNT(*) n FROM watch_progress');assert.equal(watch.n,0);
  });
  await t.test('replacement retains cleanup compatibility with older safe output-job segments',async()=>{
   await seed({status:'finished',queue:'completed',job:'Legacy-Output_1',ready:1,poster:'posters/12/7.jpg'});await pool.execute("INSERT INTO upload_sessions VALUES('Upload000008',12,7,'source/Upload000008/source.mp4','replacement.mp4','completing',NULL)");const f=service();assert.equal(await f.proc.replaceVideoSource({upload_id:'Upload000008',video_id:7,object_key:'source/Upload000008/source.mp4'},1234),true);const a=await snapshot();assert.ok(a.pending.some(x=>x.target===hash+'/Legacy-Output_1/'));assert.ok(a.pending.some(x=>x.target==='posters/12/7.jpg'));assert.equal(a.v.has_poster,0);
  });
  await t.test('actual HTTP replacement recovers NoSuchUpload after storage succeeded but SQL rolled back',async()=>{
   await seed({ready:1,poster:paths.jobPosterKey(12,7,JOB)});await pool.execute("INSERT INTO upload_sessions VALUES('Upload000008',12,7,'source/Upload000008/source.mp4','replacement.mp4','completing',NULL)");const options={failEnqueue:true},f=service(options),calls=[];let stored=false;
   const express=require('express'),app=express(),auth=(req,res,next)=>{res.locals.user={user_id:req.get('x-actor')||'actor-A'};next()};
   const deps={express,path:require('node:path'),'../../middleware/auth':{requireAuth:auth},'../../middleware/permissions':{checkPermission:()=> (_req,_res,next)=>next()},'../../config/database':{getPool:()=>pool,idBuf:x=>x},'../../services/videoService':{},'../../services/deletionService':deletion,'../../services/courseService':{},'../../services/processingService':f.proc,
    '../../services/uploadService':{async completeMultipartUpload(key){calls.push(['complete',key]);if(stored)throw Object.assign(Error('already assembled'),{name:'NoSuchUpload',$metadata:{httpStatusCode:404}});stored=true;},async getObjectSize(key,opts={}){calls.push(['head',key,opts.strict===true]);return stored?1024:null;}},
    '../../services/uploadSessionService':{async getSession(id){const [[row]]=await pool.execute('SELECT * FROM upload_sessions WHERE upload_id=?',[id]);return row?{...row,created_by:'actor-A'}:null},async markCompleting(id){await pool.execute("UPDATE upload_sessions SET status='completing' WHERE upload_id=? AND status='active'",[id])},async markCompleted(id){await pool.execute("UPDATE upload_sessions SET status='completed',completed_at=COALESCE(completed_at,NOW()) WHERE upload_id=?",[id])}},
   };
   const router=load('routes/api/upload.js',deps);app.use(express.json());app.use('/api',router);const server=require('node:http').createServer(app);await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)});
   const request=()=>fetch('http://127.0.0.1:'+server.address().port+'/api/upload/Upload000008/complete',{method:'POST',headers:{'content-type':'application/json','x-actor':'actor-A'},body:JSON.stringify({parts:[{partNumber:1,etag:'synthetic'}]})});
   try{let response=await request();assert.equal(response.status,500);await response.text();let a=await snapshot();assert.equal(a.v.r2_source_key,'source/Upload000007/source.mp4');assert.equal(a.v.has_poster,1);assert.equal(a.pending.length,0);options.failEnqueue=false;
    response=await request();assert.equal(response.status,204);await response.text();a=await snapshot();assert.equal(a.v.r2_source_key,'source/Upload000008/source.mp4');assert.equal(a.v.has_poster,0);const count=a.pending.length;assert.ok(count>0);assert.ok(!a.pending.some(row=>row.target==='source/Upload000008/'));assert.equal(calls.filter(x=>x[0]==='complete').length,2);assert.deepEqual(calls.filter(x=>x[0]==='head').map(x=>x[2]),[false,true]);
    response=await request();assert.equal(response.status,204);await response.text();assert.equal((await snapshot()).pending.length,count);assert.equal(calls.filter(x=>x[0]==='complete').length,2);assert.equal((await snapshot()).v.r2_source_key,'source/Upload000008/source.mp4');
   }finally{await new Promise(resolve=>server.close(resolve));}
  });
  await t.test('replacement cache failure still clears old writer/watch state and receipt retry repairs metadata',async()=>{
   await seed({ready:1,poster:paths.jobPosterKey(12,7,JOB)});await pool.execute("INSERT INTO upload_sessions VALUES('Upload000008',12,7,'source/Upload000008/source.mp4','replacement.mp4','completing',NULL)");const f=service({failInvalidate:1}),session={upload_id:'Upload000008',video_id:7,object_key:'source/Upload000008/source.mp4'};await assert.rejects(f.proc.replaceVideoSource(session,1234),/synthetic_cache_failure/);assert.ok(!cacheRows.has(JOB));assert.ok(f.effects.some(x=>x[0]==='watch'));let a=await snapshot();assert.equal(a.v.has_poster,0);assert.equal(a.q.status,'queued');const n=a.pending.length;assert.equal(await f.proc.replaceVideoSource(session,null,true),true);a=await snapshot();assert.equal(a.pending.length,n);assert.equal(a.v.r2_source_key,session.object_key);
  });
  await t.test('terminal video state cannot be revived by an inconsistent active queue row',async()=>{
   await seed({status:'error',queue:'processing',poster:paths.jobPosterKey(12,7,JOB)});const f=service();assert.equal(await f.lifecycle.confirmPosterReady(JOB,KEY),false);assert.equal(await f.proc.completeTask(JOB,12,true,KEY),false);assert.equal(await f.proc.generateUploadUrls(JOB,['poster.jpg'],KEY),null);assert.equal((await snapshot()).v.has_poster,0);
  });
  await t.test('replacement cleanup failure keeps old readiness and completing session',async()=>{
   await seed({ready:1,poster:paths.jobPosterKey(12,7,JOB)});await pool.execute("INSERT INTO upload_sessions VALUES('Upload000008',12,7,'source/Upload000008/source.mp4','replacement.mp4','completing',NULL)");await assert.rejects(service({failEnqueue:true}).proc.replaceVideoSource({upload_id:'Upload000008',video_id:7,object_key:'source/Upload000008/source.mp4'},1234),/synthetic_enqueue_failure/);const a=await snapshot();assert.equal(a.v.has_poster,1);assert.equal(a.v.r2_source_key,'source/Upload000007/source.mp4');assert.equal(a.pending.length,0);const [[receipt]]=await pool.query("SELECT status FROM upload_sessions WHERE upload_id='Upload000008'");assert.equal(receipt.status,'completing');
  });
  await t.test('media-only URL batches cannot trust a stale cache or a different lease owner',async()=>{
   await seed();const f=service();assert.equal(await f.proc.generateUploadUrls(JOB,['video/720p/init.mp4'],'worker-B'),null);const valid=await f.proc.generateUploadUrls(JOB,['video/720p/init.mp4'],KEY);assert.ok(valid.urls['video/720p/init.mp4'].includes(hash+'/'+JOB+'/video/720p/init.mp4'));await f.proc.abortAndRequeue(JOB,KEY);cacheRows.set(JOB,{hashed_video_id:hash,course_id:12,video_id:7});assert.equal(await f.proc.generateUploadUrls(JOB,['video/720p/init.mp4'],KEY),null);
  });
  await t.test('one batched status authority read fences old and wrong-owner caches without SQL progress writes',async()=>{
   await seed({ready:1,poster:paths.jobPosterKey(12,7,JOB)});const f=service();let result=await f.proc.reportJobStatuses([{jobId:JOB,status:'running',stage:'transcoding',progress:50},{jobId:JOB,status:'running',stage:'transcoding',progress:51}],KEY);assert.ok(result.every(x=>x.ack));assert.equal(f.queries.length,1);assert.match(f.queries[0],/^SELECT pq.job_id/);assert.equal((await snapshot()).q.progress,0);assert.equal(f.effects.filter(x=>x[0]==='heartbeat').length,2);
   f.queries.length=0;assert.equal((await f.proc.reportJobStatuses([{jobId:JOB,status:'running'}],'worker-B'))[0].ack,false);assert.equal(f.queries.length,1);
   await f.proc.abortAndRequeue(JOB,KEY);cacheRows.set(JOB,{hashed_video_id:hash,course_id:12,video_id:7,last_heartbeat:Date.now()});f.queries.length=0;assert.equal((await f.proc.reportJobStatuses([{jobId:JOB,status:'running',progress:70}],KEY))[0].ack,false);assert.equal(f.queries.length,1);assert.equal((await snapshot()).v.has_poster,0);
  });
  await t.test('a fresh heartbeat during stale-reset SQL lock wait preserves the healthy poster',async()=>{
   await seed({ready:1,poster:paths.jobPosterKey(12,7,JOB)});const blocker=await pool.getConnection();await blocker.beginTransaction();await blocker.query('SELECT video_id FROM videos WHERE video_id=7 FOR UPDATE');const f=service();let done=false;const reset=f.proc.resetStaleTasks().then(x=>{done=true;return x});try{await delay(60);assert.equal(done,false);cacheRows.get(JOB).last_heartbeat=Date.now();await blocker.commit();assert.equal(await reset,0);const a=await snapshot();assert.equal(a.v.has_poster,1);assert.equal(a.pending.length,0);}finally{await blocker.rollback();blocker.release();}
  });
  await t.test('current stale timer recovers a dead job after cache loss while polling skips the miss',async()=>{
   await seed({ready:1,poster:paths.jobPosterKey(12,7,JOB)});const f=service();await f.proc.reportJobStatuses([{jobId:JOB,status:'running',stage:'transcoding',progress:50}],KEY);const timer=f.timers.at(-1);cacheRows.delete(JOB);assert.equal(await f.proc.resetStaleTasks(),0);await timer.fn();assert.equal((await snapshot()).v.has_poster,0);assert.equal((await snapshot()).q.status,'queued');
  });
  await t.test('new heartbeat timer supersedes a firing timer while its SQL lock waits',async()=>{
   await seed({ready:1,poster:paths.jobPosterKey(12,7,JOB)});const f=service();await f.proc.reportJobStatuses([{jobId:JOB,status:'running'}],KEY);const old=f.timers.at(-1);cacheRows.get(JOB).last_heartbeat=Date.now()-130000;const blocker=await pool.getConnection();await blocker.beginTransaction();await blocker.query('SELECT video_id FROM videos WHERE video_id=7 FOR UPDATE');let done=false;const reset=old.fn().then(()=>{done=true});try{await delay(60);assert.equal(done,false);await f.proc.reportJobStatuses([{jobId:JOB,status:'running'}],KEY);await blocker.commit();await reset;assert.equal((await snapshot()).v.has_poster,1);assert.equal((await snapshot()).pending.length,0);assert.equal(f.timers.length,2);}finally{await blocker.rollback();blocker.release();}
  });
  await t.test('unknown timer freshness schedules another recovery check without resetting the poster',async()=>{
   await seed({ready:1,poster:paths.jobPosterKey(12,7,JOB)});const f=service({getProgress:()=>Promise.reject(Error('synthetic_redis_outage'))});await f.proc.updateTaskStatus(JOB,'processing',null,null,KEY);assert.equal(f.timers.length,1);await f.timers[0].fn();assert.equal(f.timers.length,2);assert.equal((await snapshot()).v.has_poster,1);assert.equal((await snapshot()).pending.length,0);
  });
  await t.test('periodic cache-miss detection arms recovery after process or Redis restart',async()=>{
   await seed({ready:1,poster:paths.jobPosterKey(12,7,JOB)});cacheRows.clear();const f=service();assert.equal(await f.proc.resetStaleTasks(),0);assert.equal(f.timers.length,1);await f.timers[0].fn();assert.equal((await snapshot()).q.status,'queued');assert.equal((await snapshot()).v.has_poster,0);
  });
  await t.test('unavailable locked freshness check is bounded and never retires a poster',async()=>{
   await seed({ready:1,poster:paths.jobPosterKey(12,7,JOB)});const f=service({getProgress:(_id,n)=>n===1?{last_heartbeat:Date.now()-130000}:new Promise(()=>{})});const start=Date.now();assert.equal(await f.proc.resetStaleTasks(),0);assert.ok(Date.now()-start<2000);assert.equal((await snapshot()).v.has_poster,1);assert.equal((await snapshot()).pending.length,0);
  });
  await t.test('stale Redis routing cannot redirect the generation-specific poster key',async()=>{
   await seed();cacheRows.set(JOB,{hashed_video_id:hash,course_id:null,video_id:null});const f=service();const result=await f.proc.generateUploadUrls(JOB,['poster.jpg'],KEY);assert.match(result.urls['poster.jpg'],/posters\/12\/7\/Job000000007.jpg$/);await f.proc.abortAndRequeue(JOB,KEY);cacheRows.set(JOB,{hashed_video_id:hash,course_id:12,video_id:7});assert.equal(await f.proc.generateUploadUrls(JOB,['poster.jpg'],KEY),null);
  });
 }finally{dbModule.getPool=prior;await drop();await pool.end();}
});
