'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), crypto = require('node:crypto');
const { ClientSigningKeyStore, generate, legacyState, seal, unseal, publicJwks, PREPUBLICATION_MS } = require('../services/clientSigningKeys');
const kek = crypto.randomBytes(32), codec = { seal: (s,v) => seal(s,v,kek), unseal: (s,v) => unseal(s,v,kek) };
const legacy = () => JSON.stringify(generate());

test('client-key envelope binds ciphertext to purpose/revision and rejects key-pair mismatch', () => {
    const state = legacyState(legacy(), Date.now()), encoded = codec.seal(state,'1');
    assert.deepEqual(codec.unseal(encoded,'1'),state);
    assert.throws(() => codec.unseal(encoded,'2'));
    assert.throws(() => unseal(encoded,'1',crypto.randomBytes(32)));
    const broken = JSON.parse(JSON.stringify(state));broken.current.d = generate().d;
    assert.throws(() => codec.unseal(codec.seal(broken,'1'),'1'));
    const pub=publicJwks(state,Date.now());assert.ok(pub.keys.every(k=>!('d' in k)));
    const named={...state.current,kid:'existing-custom-id'};assert.equal(legacyState(JSON.stringify(named),Date.now()).current.kid,named.kid);
    assert.throws(()=>legacyState(JSON.stringify({...state.current,kid:undefined}),Date.now()),'missing kid must not be silently renamed before propagation');
    assert.throws(()=>legacyState(JSON.stringify({...state.current,x:[state.current.x]}),Date.now()));
});

test('MariaDB durable staged client keys and UTC clocks', { skip: process.env.VS_SSO_ISOLATED_TEST !== '1' }, async t => {
    const url = new URL(process.env.VS_TEST_DB_URI || 'invalid:');
    assert.equal(url.protocol,'mysql:');assert.equal(url.hostname,'127.0.0.1');assert.match(url.pathname,/^\/vs_sso_test_[a-z0-9_]+$/);
    const mysql = require('mysql2/promise'), pool = mysql.createPool({host:url.hostname,port:Number(url.port),
        user:decodeURIComponent(url.username),password:decodeURIComponent(url.password),database:url.pathname.slice(1),connectionLimit:8,
        timezone:'+09:00',supportBigNumbers:true,bigNumberStrings:true});
    let legacyReads=0, generated=0, raw=legacy();
    const make = (p=pool) => new ClientSigningKeyStore(p,()=>{legacyReads++;return raw;},codec,()=>{generated++;return generate();});
    const reset = async()=>{await pool.query('DELETE FROM oidc_client_signing_state');await pool.query('INSERT INTO oidc_client_signing_state(singleton) VALUES(1)');raw=legacy();legacyReads=generated=0;};
    const stored = async()=>{const [[row]]=await pool.query('SELECT CAST(version AS CHAR) AS version,encrypted_state FROM oidc_client_signing_state WHERE singleton=1');return{...row,state:row.encrypted_state&&codec.unseal(row.encrypted_state,row.version)};};
    const change = async modify=>{const row=await stored();modify(row.state);const v=String(BigInt(row.version)+1n);await pool.execute('UPDATE oidc_client_signing_state SET encrypted_state=?,version=? WHERE singleton=1',[codec.seal(row.state,v),v]);};
    const makeDue = ()=>change(state=>{state.pending.published_at=new Date(Date.now()-PREPUBLICATION_MS-1000).toISOString();state.pending.activate_after=new Date(Date.now()-1000).toISOString();});
    try {
        await require('../db/clientSigningKeyMigration').migrateClientSigningKeys(pool);
        await require('../db/clientSigningKeyMigration').migrateClientSigningKeys(pool);
        await t.test('fresh row keeps legacy authoritative without writes; public projection is safe',async()=>{
            await reset();const store=make();assert.equal(await store.authoritative(),false);
            assert.equal((await store.signingKey()).kid,JSON.parse(raw).kid);assert.equal((await stored()).encrypted_state,null);
            assert.equal((await store.jwks()).keys.length,1);
        });
        await t.test('concurrent schedules serialize one operation and keep old signer',async()=>{
            await reset();const store=make(), old=JSON.parse(raw).kid, results=await Promise.all(Array.from({length:5},()=>store.schedule()));
            assert.equal(generated,1);assert.equal(new Set(results.map(r=>r.rotation.id)).size,1);
            assert.ok(results.every(r=>r.kid===old&&r.state==='pending'));
            const row=await stored();assert.equal(row.version,'2');assert.equal(row.state.current.kid,old);
            assert.equal(Date.parse(row.state.pending.activate_after)-Date.parse(row.state.pending.published_at),PREPUBLICATION_MS);
            assert.ok(Math.abs(Date.parse(row.state.pending.published_at)-Date.now())<3000,'UTC independent of mysql2 timezone');
            assert.deepEqual((await store.jwks()).keys.map(k=>k.kid),[old,row.state.pending.key.kid]);
            raw='invalid legacy after import';assert.equal((await store.signingKey()).kid,old);
            assert.equal(legacyReads,1,'legacy file is never re-read after import');
        });
        await t.test('activation is atomic across processes and retirement starts at actual switch',async()=>{
            const store=make(), before=await stored(), old=before.state.current.kid, next=before.state.pending.key.kid;
            await makeDue();const now=Date.now();const values=await Promise.all(Array.from({length:5},()=>make().signingKey()));
            assert.ok(values.every(v=>v.kid===next));const state=(await stored()).state;
            assert.equal(state.pending,null);assert.equal(state.retired.length,1);assert.equal(state.retired[0].key.kid,old);
            assert.ok(Date.parse(state.retired[0].retired_at)>=now-1000);
            assert.deepEqual(new Set((await store.jwks()).keys.map(k=>k.kid)),new Set([old,next]));
        });
        await t.test('lost first COMMIT acknowledgement leaves public unarmed key; restart arms same key',async()=>{
            await reset();let commits=0;
            const faultPool={query:pool.query.bind(pool),getConnection:async()=>{
                const db=await pool.getConnection();return new Proxy(db,{get(target,name){
                    if(name==='commit')return async()=>{await target.commit();if(++commits===1)throw Error('synthetic_lost_ack');};
                    const value=Reflect.get(target,name);return typeof value==='function'?value.bind(target):value;
                }});
            }};
            await assert.rejects(make(faultPool).schedule(),/synthetic_lost_ack/);
            const before=await stored();assert.equal(before.state.pending.published_at,null);assert.equal(before.state.current.kid,JSON.parse(raw).kid);
            assert.equal((await make().jwks()).keys.length,2,'unarmed key is already public');
            await new Promise(r=>setTimeout(r,60));const earliest=Date.now(), recovered=await make().info();
            assert.equal(recovered.rotation.id,before.state.pending.id);assert.equal(generated,1);
            assert.ok(Date.parse(recovered.rotation.activate_after)>=earliest+PREPUBLICATION_MS-1);
        });
        await t.test('failed activation rereads durable current for signing; status still reports maintenance failure',async()=>{
            await makeDue();const previous=(await stored()).state.current.kid;
            const failing={query:pool.query.bind(pool),getConnection:async()=>{throw Error('synthetic_busy');}};
            assert.equal((await make(failing).signingKey()).kid,previous);
            await assert.rejects(make(failing).info(),/synthetic_busy/);
        });
        await t.test('expired previous keys are omitted and pruned before scheduling',async()=>{
            await makeDue();await make().info();await change(state=>{state.retired[0].retired_at='2020-01-01T00:00:00.000Z';});
            assert.equal((await make().jwks()).keys.length,1);await make().schedule();assert.equal((await stored()).state.retired.length,0);
        });
        await t.test('decrypt or database failure never falls back to legacy key',async()=>{
            const reads=legacyReads;
            await pool.query('UPDATE oidc_client_signing_state SET encrypted_state=NULL');
            await assert.rejects(make().signingKey());assert.equal(legacyReads,reads,'null at a nonzero revision must not downgrade authority');
            await pool.query("UPDATE oidc_client_signing_state SET encrypted_state='broken'");
            await assert.rejects(make().signingKey());assert.equal(legacyReads,reads);
            const failing=make({query:async()=>{throw Error('synthetic_db_error');}});
            await assert.rejects(failing.jwks(),/synthetic_db_error/);assert.equal(legacyReads,reads);
        });
    } finally {await pool.query('DROP TABLE IF EXISTS oidc_client_signing_state');await pool.end();}
});


test('VideoSite config remains readable when key status fails; partial DB configuration refuses legacy fallback',async()=>{
    const express=require('express'),auth=require('../middleware/auth'),permissions=require('../middleware/permissions'),stepup=require('../middleware/stepup');
    const settings=require('../services/cache/settingsCache');settings.getSetting=async(key,fallback)=>fallback;
    auth.requireAuth=(_req,_res,next)=>next();permissions.checkPermission=()=>auth.requireAuth;stepup.requireStepup=()=>auth.requireAuth;
    const oidc=require('../lib/oidc'),original=oidc.clientKeyInfo;
    const env={DB_HOST:process.env.DB_HOST,DB_NAME:process.env.DB_NAME};
    delete process.env.DB_HOST;process.env.DB_NAME='synthetic-configured';
    try{await assert.rejects(oidc.publicJwks(),e=>e.code==='client_key_unavailable');}
    finally{for(const [key,value]of Object.entries(env))if(value===undefined)delete process.env[key];else process.env[key]=value;}
    oidc.clientKeyInfo=async()=>{throw Error('synthetic_private_detail');};
    const app=express();app.use('/api',require('../routes/api/sso'));
    const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
    const base='http://127.0.0.1:'+server.address().port;
    try{
        const response=await fetch(base+'/api/sso/config');assert.equal(response.status,200);const body=await response.json();
        assert.equal(body.client_key,null);assert.equal(typeof body.issuer,'string');assert.ok(!JSON.stringify(body).includes('synthetic_private'));
        const status=await fetch(base+'/api/sso/client-key');assert.equal(status.status,503);assert.deepEqual(await status.json(),{error:'client_key_unavailable'});
    }finally{oidc.clientKeyInfo=original;server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});

test('timed-out MariaDB transaction destroys only its owned connection without queued rollback or reuse',async()=>{
    let destroyed=0,rollback=0,released=0;
    const db={query:async sql=>{if(typeof sql==='string'&&sql.startsWith('SELECT @@session'))return[[{row_timeout:50,metadata_timeout:99}]];return[];},
      beginTransaction:async()=>{},rollback:async()=>{rollback++;},destroy:()=>{destroyed++;},release:()=>{released++;}};
    const store=new ClientSigningKeyStore({getConnection:async()=>db},()=>legacy(),codec);
    await assert.rejects(store.transaction(async()=>{throw Object.assign(Error('synthetic_timeout'),{code:'PROTOCOL_SEQUENCE_TIMEOUT'});}),/synthetic_timeout/);
    assert.equal(destroyed,1);assert.equal(rollback,0);assert.equal(released,0);
});
