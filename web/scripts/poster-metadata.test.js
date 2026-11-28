'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { posterMetadata } = require('../services/posterMetadata');
const video = { video_id: 9, course_id: 12, processing_job_id: 'Job000000001', status: 'processing', has_poster: 0, processing_progress: 100, poster_path: 'posters/12/9/Job000000001.jpg' };
test('progress and a planned key never issue a poster capability before confirmation', async () => {
 let calls=0;
 for(const status of ['queued','processing','worker_uploading','finished','error']){
  const result=await posterMetadata({...video,status},async()=>{calls++;return 'unused';});
  assert.deepEqual(result,{has_poster:false,posterPath:null,posterToken:''});
 }
 assert.equal(calls,0);
});
test('confirmed generation uses its exact path, without changing on completion',async()=>{
 const signed=[];const sign=async p=>{signed.push(p);return 'token';};
 const first=await posterMetadata({...video,has_poster:1},sign);
 const finished=await posterMetadata({...video,has_poster:1,status:'finished'},sign);
 assert.deepEqual(first,{has_poster:true,posterPath:'/posters/12/9/Job000000001.jpg',posterToken:'token'});
 assert.deepEqual(finished,first);assert.deepEqual(signed,[first.posterPath,first.posterPath]);
});
test('existing confirmed legacy posters retain their path',async()=>{
 const result=await posterMetadata({...video,has_poster:1,poster_path:null},async p=>p);
 assert.equal(result.posterPath,'/posters/12/9.jpg');assert.equal(result.posterToken,result.posterPath);
});
test('foreign video paths and stale generations cannot receive capabilities',async()=>{
 for(const poster_path of ['posters/99/9/Job000000001.jpg','posters/12/10.jpg','posters/12/9/Job000000002.jpg','https://outside.example/x.jpg','posters/12/9/../x.jpg']){
  const result=await posterMetadata({...video,has_poster:1,poster_path},async()=>assert.fail('must not sign'));
  assert.equal(result.has_poster,false);assert.equal(result.posterPath,null);
 }
});
test('unavailable signing does not fabricate an image token',async()=>{
 const result=await posterMetadata({...video,has_poster:true},async()=>null);
 assert.equal(result.has_poster,true);assert.equal(result.posterToken,'');
});
