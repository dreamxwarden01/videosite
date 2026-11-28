'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const hash='A'.repeat(64);
function fixture(options={}){
 const events=[],effects=[],errors=[];
 let state={exists:options.exists!==false,pending:[]},staged=null,inserts=0;
 const video={video_id:7,course_id:12,hashed_video_id:hash,r2_source_key:'source/Upload000001/source.mp4',status:'queued',has_poster:0,...options.video};
 const jobs=options.jobs??[{job_id:'Job000000001',status:'leased'},{job_id:'Job000000002',status:'processing'},{job_id:null,status:'queued'}];
 const sessions=options.sessions??[{upload_id:'Upload000001',object_key:'source/Upload000001/source.mp4',r2_upload_id:'synthetic-multipart'}];
 const connection={
  async beginTransaction(){events.push('begin');staged=structuredClone(state)},
  async execute(sql,args){
   assert.ok(staged,'SQL outside transaction');
   if(/SELECT video_id, course_id/.test(sql)){events.push('video-lock');assert.match(sql,/FOR UPDATE/);return[staged.exists?[video]:[]]}
   if(/SELECT job_id, status/.test(sql)){events.push('queue-lock');assert.match(sql,/FOR UPDATE/);assert.doesNotMatch(sql,/status\s+IN|job_id IS NOT NULL/);return[jobs]}
   if(/SELECT upload_id/.test(sql)){events.push('upload-lock');assert.match(sql,/FOR UPDATE/);return[sessions]}
   if(/INSERT INTO pending_deletes/.test(sql)){events.push('enqueue');if(++inserts===options.failInsert)throw Object.assign(Error('synthetic insert failure'),{code:'FIXTURE_INSERT'});staged.pending.push(args[0]);return[{affectedRows:1}]}
   if(/^DELETE FROM videos/.test(sql)){events.push('delete');assert.equal(args[0],7);if(options.failDelete)throw Error('synthetic delete failure');staged.exists=false;return[{affectedRows:1}]}
   throw Error('unexpected SQL '+sql)
  },
  async commit(){events.push('commit');if(options.failCommit==='before')throw Error('synthetic commit failure');state=staged;staged=null;if(options.failCommit==='after')throw Error('synthetic lost reply')},
  async rollback(){events.push('rollback');staged=null;if(options.failRollback)throw Error('synthetic rollback failure')},
  release(){events.push('release')},destroy(){events.push('destroy')},
 };
 const effect=name=>async(...args)=>{assert.equal(staged,null);if(!['video','list'].includes(name))assert.equal(state.exists,false,'effect before confirmed delete');effects.push([name,args]);events.push('effect:'+name);if((options.failEffects||[]).includes(name))throw Object.assign(Error('sensitive fixture contents'),{code:'FIXTURE_EFFECT'})};
 const enqueue=mode=>async(target,opts)=>{assert.equal(opts.connection,connection);assert.equal(opts.source,'video_delete');await connection.execute('INSERT INTO pending_deletes fixture',[{mode,target,at:opts.execute_at.getTime(),hash:opts.hashed_video_id??null}])};
 const deps={crypto:require('node:crypto'),'../config/database':{getPool:()=>({getConnection:async()=>connection,execute(){throw Error('unbound SQL')}}),idBuf:x=>x},'./cache/videoCache':{invalidate:effect('video')},'./cache/courseListCache':{invalidate:effect('list')},'./deletionService':{enqueuePrefix:enqueue('prefix'),enqueueKey:enqueue('key')},'./cache/watchProgressCache':{clearForVideo:effect('watch')},'./cache/transcodeProgressCache':{clearJobs:effect('transcode')},'./cache/uploadHeartbeatCache':{clearHeartbeat:effect('heartbeat')},'./processingService':{clearStaleTimer:effect('timer')},'./uploadService':{abortMultipartUpload:effect('abort')}};
 const module={exports:{}};vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../services/videoService.js'),'utf8'),{module,exports:module.exports,Date,console:{error:(...args)=>errors.push(args)},require(name){assert.ok(Object.hasOwn(deps,name),name);return deps[name]}},{filename:'videoService.js'});
 return{service:module.exports,events,effects,errors,get state(){return state}};
}

test('video deletion atomically plans source/output and unconfirmed poster before cascading',async()=>{
 const f=fixture();await f.service.deleteVideo('0007');assert.equal(f.state.exists,false);assert.equal(f.state.pending.length,4);
 const rows=f.state.pending;assert.deepEqual(rows.map(r=>r.target),['source/Upload000001/',hash+'/','posters/12/7.jpg','posters/12/7/']);
 assert.equal(rows[1].at-rows[0].at,120000);assert.equal(rows[2].at-rows[0].at,120000);assert.equal(rows[3].at-rows[0].at,120000);assert.equal(rows[1].hash,hash);
 assert.ok(f.events.lastIndexOf('enqueue')<f.events.indexOf('delete'));assert.ok(f.events.indexOf('release')<f.events.findIndex(e=>e.startsWith('effect:')));
 assert.deepEqual(f.effects.filter(([n])=>n==='timer').map(([,args])=>args[0]),['Job000000001','Job000000002']);
 assert.deepEqual(Array.from(f.effects.find(([n])=>n==='transcode')[1][0]),['Job000000001','Job000000002']);
});
for(const status of ['queued','error','finished'])test('poster grace applies without has_poster or active job: '+status,async()=>{
 const f=fixture({video:{status,has_poster:0},jobs:[],sessions:[]});await f.service.deleteVideo(7);
 const rows=f.state.pending;assert.equal(rows[1].at,rows[0].at,'existing idle output timing changed');assert.equal(rows[2].at-rows[0].at,120000);assert.equal(rows[3].at-rows[0].at,120000);
});
for(const failInsert of [1,2,3,4])test('cleanup failure rolls back video and all intents: '+failInsert,async()=>{
 const f=fixture({failInsert});await assert.rejects(f.service.deleteVideo(7),/synthetic insert failure/);assert.deepEqual(f.state,{exists:true,pending:[]});assert.deepEqual(f.effects,[]);assert.ok(!f.events.includes('delete'));
});
test('video DELETE failure rolls back its already prepared cleanup plan',async()=>{
 const f=fixture({failDelete:true});await assert.rejects(f.service.deleteVideo(7),/synthetic delete failure/);assert.deepEqual(f.state,{exists:true,pending:[]});assert.deepEqual(f.effects,[]);
});
for(const outcome of ['before','after'])test('uncertain commit evicts read metadata only: '+outcome,async()=>{
 const f=fixture({failCommit:outcome});await assert.rejects(f.service.deleteVideo(7),/synthetic/);assert.equal(f.state.exists,outcome==='before');assert.equal(f.state.pending.length,outcome==='before'?0:4);assert.deepEqual(f.effects.map(([n])=>n).sort(),['list','video']);
});
test('rollback failure destroys the connection and preserves the original error',async()=>{
 const f=fixture({failInsert:2,failRollback:true});await assert.rejects(f.service.deleteVideo(7),/synthetic insert failure/);assert.ok(f.events.includes('destroy'));assert.ok(!f.events.includes('release'));assert.deepEqual(f.effects,[]);
});
test('postcommit cache/abort errors do not undo deletion or leak private error text',async()=>{
 const f=fixture({failEffects:['video','watch','abort']});await f.service.deleteVideo(7);assert.equal(f.state.exists,false);assert.equal(f.state.pending.length,4);assert.equal(f.errors.length,3);assert.doesNotMatch(JSON.stringify(f.errors),/sensitive fixture/);
});
test('absent-video retry invalidates refillable metadata without new cleanup or writer effects',async()=>{
 const f=fixture({exists:false});await f.service.deleteVideo(7);assert.deepEqual(f.state,{exists:false,pending:[]});assert.deepEqual(f.effects.map(([n])=>n).sort(),['list','video']);
});
for(const video of [{hashed_video_id:'../'},{r2_source_key:'source/../source.mp4'},{r2_source_key:'source.mp4'},{course_id:null}])test('invalid captured cleanup target fails before deletion',async()=>{
 const f=fixture({video});await assert.rejects(f.service.deleteVideo(7),{code:'invalid_cleanup_target'});assert.deepEqual(f.state,{exists:true,pending:[]});assert.deepEqual(f.effects,[]);assert.ok(!f.events.includes('enqueue'));
});
