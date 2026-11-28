'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
test('actual server token alphabet is URL-safe and passes through the poster loader unchanged',async()=>{
 const module={exports:{}};const secret='synthetic-review-key-not-production';
 const deps={crypto,'../config/database':{getPool(){throw Error('Unexpected database call')}},'./cache/settingsCache':{async getSetting(key){return key==='video_hmac_enabled'?'true':null}},'./settingsEncryption':{async getSecretSetting(){return secret}}};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../services/tokenService.js'),'utf8'),{module,exports:module.exports,Date:{now:()=>1800000000000},require(name){assert.ok(Object.hasOwn(deps,name),name);return deps[name];}});
 const posterPath='/posters/12/34/Job000000034.jpg';const token=await module.exports.generateFileToken(posterPath);
 assert.match(token,/^1800000000-[A-Za-z0-9_-]{43}$/);assert.equal(encodeURIComponent(token),token);
 const {createPosterLoader}=await import('../client/src/services/posterLoader.js');const states=[];let retry;
 const loader=createPosterLoader({onChange:s=>states.push(s),schedule:fn=>{retry=fn;return 1},cancel:()=>{}});
 loader.update({courseId:12,videoId:34,domain:'video.example.invalid',ready:true,path:posterPath,status:'finished',token,revision:1});
 const expected='https://video.example.invalid'+posterPath+'?verify='+token;
 assert.equal(states.at(-1).src,expected);const first=states.at(-1).id;
 loader.failed(first);retry();assert.equal(states.at(-1).src,expected);assert.notEqual(states.at(-1).id,first);loader.dispose();
});
