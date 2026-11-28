'use strict';
// Only this runner's explicitly named disposable local MariaDB is allowed.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const enabled=process.env.VS_DELETION_ISOLATED_TEST==='1',hash='V'.repeat(64);
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r});return{promise,resolve}};
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));

test('video deletion keeps early poster cleanup atomic in native MariaDB',{skip:!enabled},async t=>{
 const url=new URL(process.env.VS_TEST_DB_URI||'invalid:');
 if(url.protocol!=='mysql:'||url.hostname!=='127.0.0.1'||!/^\/vs_delete_test_[a-z0-9]+$/.test(url.pathname))throw Error('disposable_fixture_required');
 const mysql=require('mysql2/promise'),pool=mysql.createPool({host:url.hostname,port:Number(url.port||3306),user:decodeURIComponent(url.username),password:decodeURIComponent(url.password),database:url.pathname.slice(1),connectionLimit:8});
 const dbModule=require('../config/database'),previousGetPool=dbModule.getPool;dbModule.getPool=()=>pool;
 delete require.cache[require.resolve('../services/deletionService')];const deletion=require('../services/deletionService');
 const source=fs.readFileSync(path.join(__dirname,'../services/videoService.js'),'utf8');
 const drop=async()=>{for(const table of ['upload_sessions','processing_queue','videos','courses','pending_deletes'])await pool.execute('DROP TABLE IF EXISTS '+table)};
 const seed=async(status='queued',queue='queued')=>{
  await pool.execute('DELETE FROM courses');await pool.execute('DELETE FROM pending_deletes');
  await pool.execute('INSERT INTO courses(course_id) VALUES(12)');
  await pool.execute('INSERT INTO videos(video_id,course_id,hashed_video_id,r2_source_key,status,has_poster) VALUES(7,12,?,?,?,0)',[hash,'source/Upload000007/source.mp4',status]);
  await pool.execute('INSERT INTO processing_queue(video_id,job_id,status) VALUES(7,?,?)',[queue==='queued'?null:'Job000000007',queue]);
  await pool.execute("INSERT INTO upload_sessions(upload_id,course_id,video_id,type,object_key,r2_upload_id,status) VALUES('Upload000007',12,7,'video','source/Upload000007/source.mp4','synthetic-parts','active')");
 };
 const counts=async()=>{const [[row]]=await pool.query('SELECT (SELECT COUNT(*) FROM courses) courses,(SELECT COUNT(*) FROM videos) videos,(SELECT COUNT(*) FROM processing_queue) jobs,(SELECT COUNT(*) FROM upload_sessions) uploads,(SELECT COUNT(*) FROM pending_deletes) pending');return row};
 function service(options={}){
  const effects=[],errors=[];let inserts=0;
  const wrapped={getConnection:async()=>{
   const real=await pool.getConnection();return new Proxy(real,{get(target,key){
    if(key==='execute')return async(sql,args)=>{
     if(/INSERT INTO pending_deletes/.test(sql)&&++inserts===options.failInsert)throw Error('synthetic_insert_failure');
     if(/^DELETE FROM videos/.test(sql)&&options.failDelete)throw Error('synthetic_delete_failure');
     const result=await target.execute(sql,args);
     if(/SELECT video_id, course_id/.test(sql))await options.afterVideoLock?.();
     if(/SELECT job_id, status/.test(sql))await options.afterJobLock?.();
     if(/SELECT upload_id/.test(sql))await options.afterUploadLock?.();
     if(/^DELETE FROM videos/.test(sql))await options.beforeCommit?.();
     return result;
    };
    if(key==='commit'&&options.lostCommitReply)return async()=>{await target.commit();throw Error('synthetic_lost_commit_reply')};
    const value=target[key];return typeof value==='function'?value.bind(target):value;
   }});
  }};
  const effect=name=>async()=>{const [[row]]=await pool.execute('SELECT COUNT(*) n FROM videos WHERE video_id=7');if(!['video','list'].includes(name))assert.equal(row.n,0,'writer side effect before confirmed commit');effects.push(name);if(options.failEffects?.includes(name))throw Object.assign(Error('private-fixture-detail'),{code:'FIXTURE_EFFECT'})};
  const deps={crypto:require('node:crypto'),'../config/database':{getPool:()=>wrapped,idBuf:x=>x},'./deletionService':deletion,'./cache/videoCache':{invalidate:effect('video')},'./cache/courseListCache':{invalidate:effect('list')},'./cache/watchProgressCache':{clearForVideo:effect('watch')},'./cache/transcodeProgressCache':{clearJobs:effect('transcode')},'./cache/uploadHeartbeatCache':{clearHeartbeat:effect('heartbeat')},'./processingService':{clearStaleTimer:effect('timer')},'./uploadService':{abortMultipartUpload:effect('abort')}};
  const module={exports:{}};vm.runInNewContext(source,{module,exports:module.exports,Date,console:{error:(...args)=>errors.push(args)},require(name){assert.ok(Object.hasOwn(deps,name),name);return deps[name]}},{filename:'videoService.js'});return{remove:module.exports.deleteVideo,effects,errors};
 }
 try{
  // The runner executes files serially. Replace only the previous disposable
  // fixture's tables; never attach to an application DB or load its .env.
  await drop();
  await pool.execute('CREATE TABLE courses(course_id INT UNSIGNED PRIMARY KEY) ENGINE=InnoDB');
  await pool.execute(`CREATE TABLE videos(video_id INT UNSIGNED PRIMARY KEY,course_id INT UNSIGNED NOT NULL,hashed_video_id VARCHAR(64) NOT NULL,r2_source_key VARCHAR(500),status VARCHAR(32),has_poster TINYINT NOT NULL DEFAULT 0,KEY(course_id),FOREIGN KEY(course_id) REFERENCES courses(course_id) ON DELETE CASCADE) ENGINE=InnoDB`);
  await pool.execute(`CREATE TABLE processing_queue(task_id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,video_id INT UNSIGNED NOT NULL,job_id VARCHAR(64),status VARCHAR(32),FOREIGN KEY(video_id) REFERENCES videos(video_id) ON DELETE CASCADE) ENGINE=InnoDB`);
  await pool.execute(`CREATE TABLE upload_sessions(upload_id VARCHAR(12) PRIMARY KEY,course_id INT UNSIGNED NOT NULL,video_id INT UNSIGNED,type VARCHAR(16),object_key VARCHAR(500),r2_upload_id VARCHAR(1024),status VARCHAR(16),KEY(course_id),FOREIGN KEY(course_id) REFERENCES courses(course_id) ON DELETE CASCADE,FOREIGN KEY(video_id) REFERENCES videos(video_id) ON DELETE CASCADE) ENGINE=InnoDB`);
  const schema=fs.readFileSync(path.join(__dirname,'../db/schema.sql'),'utf8'),start=schema.indexOf('CREATE TABLE IF NOT EXISTS `pending_deletes`'),end=schema.indexOf('CREATE TABLE IF NOT EXISTS `processing_queue`',start);assert.ok(start>=0&&end>start);await pool.query(schema.slice(start,end));
  for(const status of ['queued','error','finished','processing'])await t.test('has_poster=0 still gets delayed cleanup for '+status,async()=>{
   await seed(status);const api=service();await api.remove('0007');
   assert.deepEqual(await counts(),{courses:1,videos:0,jobs:0,uploads:0,pending:4});
   const [rows]=await pool.query('SELECT mode,target,hashed_video_id,TIMESTAMPDIFF(SECOND,(SELECT MIN(execute_at) FROM pending_deletes),execute_at) delay FROM pending_deletes');
   assert.equal(rows.find(r=>r.target==='posters/12/7.jpg').delay,120);
   assert.equal(rows.find(r=>r.target===hash+'/').delay,status==='processing'?120:0);
   assert.equal(rows.find(r=>r.target===hash+'/').hashed_video_id,hash);
   assert.ok(api.effects.includes('abort'));
  });
  await t.test('leased queue gives output grace even before the video status advances',async()=>{
   await seed('queued','leased');await service().remove(7);
   const [rows]=await pool.query('SELECT target,TIMESTAMPDIFF(SECOND,(SELECT MIN(execute_at) FROM pending_deletes),execute_at) delay FROM pending_deletes');assert.equal(rows.find(r=>r.target===hash+'/').delay,120);assert.equal(rows.find(r=>r.target==='posters/12/7.jpg').delay,120);
  });
  await t.test('poster intent insertion failure rolls back video and earlier source/output intents',async()=>{
   await seed();const api=service({failInsert:3});await assert.rejects(api.remove(7),/synthetic_insert_failure/);assert.deepEqual(await counts(),{courses:1,videos:1,jobs:1,uploads:1,pending:0});assert.deepEqual(api.effects,[]);
  });
  await t.test('video cascade failure rolls back every cleanup intent',async()=>{
   await seed();const api=service({failDelete:true});await assert.rejects(api.remove(7),/synthetic_delete_failure/);assert.deepEqual(await counts(),{courses:1,videos:1,jobs:1,uploads:1,pending:0});assert.deepEqual(api.effects,[]);
  });
  await t.test('other connections cannot observe partial cleanup or video deletion before commit',async()=>{
   await seed();const entered=deferred(),release=deferred(),api=service({beforeCommit:async()=>{entered.resolve();await release.promise}});const removing=api.remove(7);await entered.promise;
   try{assert.deepEqual(await counts(),{courses:1,videos:1,jobs:1,uploads:1,pending:0})}finally{release.resolve()}
   await removing;assert.deepEqual(await counts(),{courses:1,videos:0,jobs:0,uploads:0,pending:4});
  });
  await t.test('video lock fences new queue and upload children',async()=>{
   await seed();const entered=deferred(),release=deferred(),api=service({afterVideoLock:async()=>{entered.resolve();await release.promise}});const removing=api.remove(7);await entered.promise;
   const writers=await Promise.all([pool.getConnection(),pool.getConnection()]);let settled=0;
   try{
    for(const w of writers)await w.execute('SET SESSION innodb_lock_wait_timeout=5');
    const inserts=[writers[0].execute("INSERT INTO processing_queue(video_id,job_id,status) VALUES(7,'LateJob00007','queued')"),writers[1].execute("INSERT INTO upload_sessions VALUES('Upload000099',12,7,'video','source/Upload000099/source.mp4','late-parts','active')")].map(p=>p.then(()=>{settled++;return null},e=>{settled++;return e}));
    await delay(70);assert.equal(settled,0);release.resolve();await removing;for(const err of await Promise.all(inserts))assert.equal(err?.code,'ER_NO_REFERENCED_ROW_2');
   }finally{release.resolve();for(const w of writers)w.release()}
  });
  await t.test('all queued rows are locked against a late worker lease',async()=>{
   await seed();const entered=deferred(),release=deferred(),api=service({afterJobLock:async()=>{entered.resolve();await release.promise}});const removing=api.remove(7);await entered.promise;const writer=await pool.getConnection();let settled=false;
   try{await writer.execute('SET SESSION innodb_lock_wait_timeout=5');const lease=writer.execute("UPDATE processing_queue SET status='leased',job_id='LateJob00007' WHERE video_id=7").then(r=>{settled=true;return r});await delay(70);assert.equal(settled,false);release.resolve();await removing;assert.equal((await lease)[0].affectedRows,0)}finally{release.resolve();writer.release()}
  });
  await t.test('upload snapshot fences an active session transition',async()=>{
   await seed();const entered=deferred(),release=deferred(),api=service({afterUploadLock:async()=>{entered.resolve();await release.promise}});const removing=api.remove(7);await entered.promise;const writer=await pool.getConnection();let settled=false;
   try{await writer.execute('SET SESSION innodb_lock_wait_timeout=5');const completing=writer.execute("UPDATE upload_sessions SET status='completing' WHERE video_id=7").then(r=>{settled=true;return r});await delay(70);assert.equal(settled,false);release.resolve();await removing;assert.equal((await completing)[0].affectedRows,0)}finally{release.resolve();writer.release()}
  });
  await t.test('uncertain successful commit invalidates metadata only and retry adds no cleanup',async()=>{
   await seed();const api=service({lostCommitReply:true});await assert.rejects(api.remove(7),/synthetic_lost_commit_reply/);assert.deepEqual(await counts(),{courses:1,videos:0,jobs:0,uploads:0,pending:4});assert.deepEqual(api.effects.sort(),['list','video']);const retry=service();await retry.remove(7);assert.deepEqual(retry.effects.sort(),['list','video']);assert.equal((await counts()).pending,4);
  });
  await t.test('postcommit cache and abort failures preserve success and fixed diagnostics',async()=>{
   await seed();const api=service({failEffects:['video','abort','watch']});await api.remove(7);assert.equal((await counts()).pending,4);assert.equal(api.errors.length,3);assert.doesNotMatch(JSON.stringify(api.errors),/private-fixture-detail/);
  });
 }finally{dbModule.getPool=previousGetPool;await drop();await pool.end()}
});
