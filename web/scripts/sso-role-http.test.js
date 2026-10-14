'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { eventFormParser, readEventToken } = require('../middleware/ssoEventBody');
const crypto = require('node:crypto');
test('event form parser accepts full JWT bound before global parser without raising other route limits', async () => {
    const app = express();
    app.use('/backchannel/events', eventFormParser());
    app.use(express.urlencoded({ extended: true }));
    app.post('/backchannel/events', (req,res) => res.sendStatus(readEventToken(req.body) ? 204 : 400));
    app.post('/ordinary', (_req,res) => res.sendStatus(204));
    app.use((error,_req,res,_next) => res.sendStatus(error.status || 500));
    const server = app.listen(0,'127.0.0.1');
    await new Promise((resolve,reject) => { server.once('listening',resolve);server.once('error',reject); });
    try {
        const post = (path, size) => fetch(`http://127.0.0.1:${server.address().port}${path}`, {
            method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({event_token:'a'.repeat(size)}) });
        assert.equal((await post('/backchannel/events',200000)).status,204);
        assert.equal((await post('/backchannel/events',262144)).status,204);
        assert.equal((await post('/backchannel/events',262145)).status,400);
        assert.equal((await post('/backchannel/events',264000)).status,413);
        assert.equal((await post('/ordinary',200000)).status,413);
    } finally { await new Promise((resolve,reject) => server.close(error => error ? reject(error) : resolve())); }
});
test('the real backchannel route validates every role payload before mixed-batch effects',async()=>{
    const oidc=require('../lib/oidc'),sessions=require('../config/session'),redis=require('../services/redis'),authority=require('../services/ssoRoleAuthority');
    const original={verify:oidc.verifyEventToken,logout:sessions.deleteSessionsBySsoSid,redis:redis.getClient,authority:authority.service};
    const sub=crypto.randomUUID();let roles=0,logouts=0;
    const events=[{id:crypto.randomUUID(),type:'logout',payload:{sub,sid:'synthetic-session'}},
        {id:crypto.randomUUID(),type:'account.roles_change',payload:{sub,role_id:0}},
        {id:crypto.randomUUID(),type:'account.roles_change',payload:{sub,role_id:'0'}}];
    oidc.verifyEventToken=async()=>({events});sessions.deleteSessionsBySsoSid=async()=>{logouts++;};
    redis.getClient=()=>({set:async()=> 'OK',del:async()=>1});authority.service=()=>({processEvent:async()=>{roles++;}});
    const routePath=require.resolve('../routes/backchannel');delete require.cache[routePath];
    const app=express();app.use('/backchannel/events',eventFormParser());app.use(require('../routes/backchannel'));
    const server=app.listen(0,'127.0.0.1');await new Promise((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject);});
    try{
        const post=()=>fetch(`http://127.0.0.1:${server.address().port}/backchannel/events`,{method:'POST',
            headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({event_token:'synthetic-token'})});
        assert.equal((await post()).status,400);assert.equal(roles,0);assert.equal(logouts,0);
        events[2].payload.role_id=null;assert.equal((await post()).status,204);assert.equal(roles,2);assert.equal(logouts,1);
    }finally{
        await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
        oidc.verifyEventToken=original.verify;sessions.deleteSessionsBySsoSid=original.logout;redis.getClient=original.redis;authority.service=original.authority;
        delete require.cache[routePath];
    }
});
test('installer publishes the persisted catalog event identity on every retry',async()=>{
    const oidc=require('../lib/oidc'),events=require('../services/ssoEvents'),transport=require('../services/s2sFetch');
    const original={sign:oidc.signEventToken,url:oidc.ssoEventsUrl,report:events.reportRoles,fetch:transport.s2sFetch};
    const event={id:crypto.randomUUID(),type:'roles.sync',payload:{catalog_epoch:crypto.randomUUID(),catalog_revision:'1',roles:[],default_role:null}};
    const sent=[];oidc.signEventToken=async batch=>{sent.push(batch);return 'synthetic';};oidc.ssoEventsUrl=()=> 'https://sso.example.invalid/backchannel/events';
    events.reportRoles=async()=>event;transport.s2sFetch=async()=>({status:204});
    const path=require.resolve('../services/installVerify');delete require.cache[path];
    try{
        const verifier=require('../services/installVerify');assert.equal((await verifier.verifyAndPublish()).ok,true);assert.equal((await verifier.verifyAndPublish()).ok,true);
        assert.deepEqual(sent,[[event],[event]]);
    }finally{oidc.signEventToken=original.sign;oidc.ssoEventsUrl=original.url;events.reportRoles=original.report;transport.s2sFetch=original.fetch;delete require.cache[path];}
});
