'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const crypto = require('node:crypto');
const { UUID } = require('../lib/ssoRoleProtocol');
function gate() { let resolve, reject; return { promise: new Promise((a,b) => { resolve=a; reject=b; }), resolve: () => resolve(), reject: () => reject(Error('synthetic_effect_failure')) }; }
function fixture() {
    const events = [{ id: crypto.randomUUID(), type: 'logout', payload: { sub: crypto.randomUUID(), sid: crypto.randomUUID() } }];
    const completed = new Map(), calls = [], pending = [];
    let failReceipt = false;
    const redis = { get: async key => completed.get(key) || null, set: async (key,value) => {
        if (failReceipt) { failReceipt=false; throw Error('synthetic_receipt_failure'); }
        completed.set(key,value); return 'OK';
    } };
    function reload() {
        let handler;
        const dependencies = {
            express: { Router: () => ({ post: (_path,_parser,fn) => { handler=fn; } }) },
            '../lib/oidc': { verifyEventToken: async () => ({events}) },
            '../config/session': { revokeSessionsBySsoSid: async (...args) => { calls.push(args); const work=pending.shift(); if(work)await work; } },
            '../services/redis': { getClient: () => redis }, '../services/ssoEvents': {},
            '../lib/ssoRoleProtocol': { UUID }, '../middleware/ssoEventBody': { eventFormParser: () => ()=>{}, readEventToken: () => 'verified-fixture' },
        };
        const module={exports:{}};
        vm.runInNewContext('(function(require,module,exports){'+fs.readFileSync(path.join(__dirname,'../routes/backchannel.js'),'utf8')+'\n})',
            { console:{log(){},error(){}} })(id => { assert.ok(Object.hasOwn(dependencies,id),id);return dependencies[id]; },module,module.exports);
        return async () => { const res={statusCode:200,ended:false,set(){return this;},status(code){this.statusCode=code;return this;},json(){this.ended=true;return this;},end(){this.ended=true;return this;}}; await handler({body:{}},res); return res; };
    }
    return {events,completed,calls,pending,reload,failReceipt(){failReceipt=true;}};
}
test('duplicate logout cannot acknowledge while both effects are unfinished; failure remains retryable', async () => {
    const f=fixture(), a=gate(), b=gate(); f.pending.push(a.promise,b.promise);
    let settled=0; const first=f.reload()().then(x=>{settled++;return x;}); const second=f.reload()().then(x=>{settled++;return x;});
    await new Promise(resolve=>setImmediate(resolve)); assert.equal(f.calls.length,2); assert.equal(settled,0);
    a.reject(); b.reject(); assert.equal((await first).statusCode,500); assert.equal((await second).statusCode,500);
    assert.equal(f.completed.size,0); assert.equal((await f.reload()()).statusCode,204); assert.equal(f.calls.length,3);
    assert.equal((await f.reload()()).statusCode,204); assert.equal(f.calls.length,3);
});
test('legacy pre-effect seen state is ignored, and crash after effect before receipt safely repeats it', async () => {
    const f=fixture(); f.completed.set('sso:evt:seen:'+f.events[0].id,'1'); f.failReceipt();
    assert.equal((await f.reload()()).statusCode,500); assert.equal(f.calls.length,1);
    assert.equal((await f.reload()()).statusCode,204); assert.equal(f.calls.length,2);
    assert.equal((await f.reload()()).statusCode,204); assert.equal(f.calls.length,2);
});
test('the entire logout batch is validated before any member runs', async () => {
    const f=fixture(); f.events.push({...f.events[0],id:crypto.randomUUID(),payload:{sub:f.events[0].payload.sub,sid:'invalid'}});
    assert.equal((await f.reload()()).statusCode,400); assert.equal(f.calls.length,0); assert.equal(f.completed.size,0);
});
test('signed invalid-session activity verdict uses the originally authorized owner even after its SQL row is gone',async()=>{
    const sid=crypto.randomUUID(),user='00000000000000000000000000000001',calls=[];
    const dependencies={'./redis':{getClient:()=>({set:async()=> 'OK',del:async()=>1})},
        './s2sFetch':{s2sFetch:async()=>({status:410,json:async()=>({verdict:'verified-fixture'})})},
        '../lib/oidc':{signClientAssertion:async route=>{assert.equal(route,'/internal/session-activity');return 'fixture';},ssoActivityUrl:()=> 'https://sso.invalid/internal/session-activity',
            verifySsoToken:async(_token,typ)=>{assert.equal(typ,'verdict+jwt');return{status:'invalid',sid};}},
        '../lib/backgroundTasks':{track:p=>p},'../config/session':{revokeSessionsBySsoSid:async(...args)=>calls.push(args)}};
    const module={exports:{}};vm.runInNewContext('(function(require,module,exports){'+fs.readFileSync(path.join(__dirname,'../services/ssoActivity.js'),'utf8')+'\n})',
        {Date,AbortSignal,console:{warn(){}}})(id=>{assert.ok(Object.hasOwn(dependencies,id),id);return dependencies[id];},module,module.exports);
    await module.exports.reportActivity('old-local',sid,Date.now(),user);
    assert.deepEqual(calls,[[sid,'00000000-0000-0000-0000-000000000001']]);
});
