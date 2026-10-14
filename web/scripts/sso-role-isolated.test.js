'use strict';
// Run only against disposable fixtures created by the operator/test runner.
// No .env loading or fallback to the application's DB/Redis settings.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const enabled = process.env.VS_SSO_ISOLATED_TEST === '1';
test('VideoSite SQL outbox and authority/cache/session integration', { skip: !enabled }, async t => {
    const dbUrl = new URL(process.env.VS_TEST_DB_URI || 'invalid:');
    const redisUrl = new URL(process.env.VS_TEST_REDIS_URI || 'invalid:');
    if (dbUrl.protocol !== 'mysql:' || dbUrl.hostname !== '127.0.0.1' || redisUrl.hostname !== '127.0.0.1'
        || !/^\/vs_sso_test_[a-z0-9_]+$/.test(dbUrl.pathname)
        || !['redis:','rediss:'].includes(redisUrl.protocol)) throw new Error('disposable_fixture_required');
    const mysql = require('mysql2/promise'), Redis = require('ioredis');
    const pool = mysql.createPool({ host: dbUrl.hostname, port: Number(dbUrl.port || 3306),
        user: decodeURIComponent(dbUrl.username), password: decodeURIComponent(dbUrl.password), database: dbUrl.pathname.slice(1),
        connectionLimit: 8, supportBigNumbers: true, bigNumberStrings: true });
    const redis = new Redis(redisUrl.toString(), { keyPrefix: 'vs-sso-test:' + crypto.randomUUID() + ':', maxRetriesPerRequest: 1 });
    try {
        await redis.ping();
        await pool.execute(`CREATE TABLE roles(role_id INT PRIMARY KEY,role_name VARCHAR(100),permission_level INT,is_system TINYINT)`);
        await pool.execute(`CREATE TABLE site_settings(setting_key VARCHAR(50) PRIMARY KEY,setting_value TEXT)`);
        await pool.execute(`CREATE TABLE users(user_id BINARY(16) PRIMARY KEY,role_id INT)`);
        await pool.execute(`CREATE TABLE sessions(session_id VARCHAR(128) PRIMARY KEY,user_id BINARY(16),
            last_sign_in DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),sso_expires_at DATETIME(6) NULL)`);
        await require('../db/ssoRoleMigration').migrateSsoRoles(pool);
        await require('../db/ssoRoleMigration').migrateSsoRoles(pool);
        await pool.execute("INSERT INTO roles VALUES(0,'Root',0,1),(2,'Member',10,1)");
        await pool.execute("INSERT INTO site_settings VALUES('registration_default_role','0'),('site_name','Fixture')");
        const dbModule = require('../config/database'); dbModule.getPool = () => pool;
        const redisModule = require('../services/redis'); redisModule.getClient = () => redis;
        const users = require('../services/userService');
        const sessions = require('../config/session');
        const { createCatalogStore } = require('../services/ssoCatalogStore');
        const { createAuthorityService } = require('../services/ssoRoleAuthority');
        const store = createCatalogStore(pool);
        const epoch = crypto.randomUUID(), sub = crypto.randomUUID(), hex = sub.replace(/-/g, '');
        await pool.execute('INSERT INTO users VALUES(?,2)', [Buffer.from(hex, 'hex')]);
        let failEffects = false;
        const authority = createAuthorityService({ pool, updateUser: users.updateUser,
            invalidateUser: async uid => { if (failEffects) throw new Error('synthetic_redis_failure'); await users.invalidateUserCaches(uid); },
            deleteUserSessions: sessions.deleteUserSessions,
            fetchAccessState: async () => ({ roleId: 2, version: { epoch, revision: '8' }, allowed: true }) });
        const event = (role, revision, authorityEpoch = epoch, id = crypto.randomUUID()) => ({ id, type: 'account.roles_change',
            payload: { sub, role_id: role, authority_epoch: authorityEpoch, authority_revision: revision } });
        await t.test('concurrent catalog snapshots allocate one immutable first version', async () => {
            const [a,b] = await Promise.all([store.snapshot(),store.snapshot()]);
            assert.equal(a.id,b.id); assert.equal(a.payload.catalog_revision,'1'); assert.equal(a.payload.default_role,0);
            await pool.execute("UPDATE site_settings SET setting_value='null' WHERE setting_key='registration_default_role'");
            const c = await store.snapshot(); assert.equal(c.payload.catalog_revision,'2'); assert.equal(c.payload.default_role,null);
            const [[old]] = await pool.execute('SELECT payload FROM sso_pending_events WHERE id=?',[a.id]);
            assert.equal(JSON.parse(old.payload).default_role,0);
        });
        await t.test('exclusive durable lease and stale completion CAS', async () => {
            const jobs = await Promise.all([store.claim(),store.claim()]); assert.equal(jobs.filter(Boolean).length,1);
            const first = jobs.find(Boolean);
            await pool.execute('UPDATE sso_catalog_state SET lease_until=DATE_SUB(NOW(6),INTERVAL 1 SECOND)');
            const replacement = await store.claim(); assert.equal(replacement.event.id,first.event.id);
            assert.equal(await store.finish(first,true),false); assert.equal(await store.finish(replacement,true),true);
        });
        await t.test('new role updates SQL and purges actual user caches', async () => {
            await redis.set('user:meta:'+hex,'stale'); await redis.set('user:perms:'+hex,'stale');
            await authority.processEvent(event(0,'7'));
            const [[user]] = await pool.execute('SELECT role_id FROM users WHERE user_id=?',[Buffer.from(hex,'hex')]);
            assert.equal(user.role_id,0); assert.equal(await redis.get('user:meta:'+hex),null); assert.equal(await redis.get('user:perms:'+hex),null);
        });
        await t.test('stale and unversioned events cannot undo pinned authority', async () => {
            await authority.processEvent(event(null,'6'));
            await authority.processEvent({ id:crypto.randomUUID(),payload:{sub,role_id:null} });
            const state = await authority.read(sub); assert.equal(state.role_id,0); assert.equal(state.blocked,0);
            const loginReader=createAuthorityService({pool,updateUser:users.updateUser,invalidateUser:users.invalidateUserCaches,
                deleteUserSessions:sessions.deleteUserSessions,
                fetchAccessState:async()=>({roleId:0,version:{epoch,revision:'7'},allowed:true})});
            const login=await loginReader.applyLogin({sub,app_role:2,app_role_epoch:epoch,app_role_revision:'6'});
            assert.equal(login.role_id,0);assert.equal(login.authority_revision,'7');
        });
        await t.test('same-version conflict denies and same-version events cannot reopen it', async () => {
            await authority.processEvent(event(2,'7')); assert.equal((await authority.read(sub)).blocked,1);
            const generation = (await authority.read(sub)).session_generation;
            await authority.processEvent(event(0,'7')); assert.equal((await authority.read(sub)).blocked,1);
            assert.equal((await authority.read(sub)).session_generation,generation);
            await authority.refresh(sub); assert.equal((await authority.read(sub)).authority_revision,'8'); assert.equal((await authority.read(sub)).blocked,0);
            assert.equal((await authority.read(sub)).session_generation,generation);
            const cache=require('../services/cache/sessionCache');
            await cache.createSession('late-old-cache',{userId:hex,lastSignIn:Date.now(),lastSeen:Date.now(),roleGeneration:'0'},60);
            const staleSession=await cache.getSession('late-old-cache');
            assert.equal(require('../lib/ssoRoleProtocol').sessionPermitted(await authority.read(sub),staleSession.sso_role_generation),false);
        });
        await t.test('cache failure keeps a durable gate; duplicate retry completes it and removes sessions', async () => {
            await pool.execute('INSERT INTO sessions(session_id,user_id) VALUES(?,?)',['fixture-session',Buffer.from(hex,'hex')]);
            await redis.sadd('user:sessions:'+hex,'fixture-session'); await redis.hset('session:user:fixture-session','user_id',hex);
            const deny = event(null,'9'); failEffects = true;
            await assert.rejects(authority.processEvent(deny),/synthetic_redis_failure/);
            assert.equal((await authority.read(sub)).effects_pending,1); failEffects=false;
            const generation=(await authority.read(sub)).session_generation;
            await authority.processEvent(deny); assert.equal((await authority.read(sub)).effects_pending,0);
            assert.equal((await authority.read(sub)).session_generation,generation);
            assert.equal(await redis.exists('session:user:fixture-session'),0);
            const [[count]] = await pool.execute('SELECT COUNT(*) AS n FROM sessions'); assert.equal(Number(count.n),0);
        });
        await t.test('unknown subjects persist their own watermark without creating users or wedging', async () => {
            const unknown = crypto.randomUUID();
            await authority.processEvent({ id:crypto.randomUUID(),payload:{sub:unknown,role_id:0,authority_epoch:epoch,authority_revision:'1'} });
            assert.equal((await authority.read(unknown)).authority_revision,'1');
            const [[count]] = await pool.execute('SELECT COUNT(*) AS n FROM users'); assert.equal(Number(count.n),1);
            await pool.execute('INSERT INTO users VALUES(?,2)',[Buffer.from(unknown.replace(/-/g,''),'hex')]);
            await authority.applyLogin({sub:unknown,app_role:0,app_role_epoch:epoch,app_role_revision:'1'});
            const [[created]]=await pool.execute('SELECT role_id FROM users WHERE user_id=?',[Buffer.from(unknown.replace(/-/g,''),'hex')]);
            assert.equal(created.role_id,0);
        });
        await t.test('stale body reuse cannot revoke a newer grant or advance its session generation',async()=>{
            const uid=crypto.randomUUID(),id=crypto.randomUUID();
            const payload={sub:uid,role_id:0,authority_epoch:epoch,authority_revision:'1'};
            await authority.processEvent({id,payload});
            await authority.processEvent({id:crypto.randomUUID(),payload:{...payload,authority_revision:'2'}});
            const before=await authority.read(uid);
            await authority.processEvent({id,payload:{...payload,role_id:null}});
            const after=await authority.read(uid);assert.equal(after.blocked,0);assert.equal(after.authority_revision,'2');
            assert.equal(after.session_generation,before.session_generation);assert.equal(after.generation,before.generation);
        });
        await t.test('foreign epoch remains pinned and denied', async () => {
            await authority.processEvent(event(0,'100',crypto.randomUUID()));
            const state = await authority.read(sub); assert.equal(state.authority_epoch,epoch); assert.equal(state.authority_revision,'9'); assert.equal(state.blocked,1);
        });
        await t.test('role SQL error rolls back the user change, watermark, and inbox receipt together', async () => {
            const broken = createAuthorityService({ pool,
                updateUser: async (...args) => { await users.updateUser(...args); throw new Error('synthetic_sql_failure'); },
                invalidateUser: users.invalidateUserCaches, deleteUserSessions: sessions.deleteUserSessions, fetchAccessState: async () => null });
            const attempt = event(0,'10');
            await assert.rejects(broken.processEvent(attempt),/synthetic_sql_failure/);
            assert.equal((await authority.read(sub)).authority_revision,'9');
            const [[row]] = await pool.execute('SELECT COUNT(*) AS n FROM sso_role_inbox WHERE event_id=?',[attempt.id]); assert.equal(Number(row.n),0);
        });
        await t.test('old cleanup cannot clear a newer pending denial', async () => {
            let release, arrived;
            const barrier = new Promise(resolve => { release=resolve; });
            const entered = new Promise(resolve => { arrived=resolve; });
            const slow = createAuthorityService({ pool, updateUser:users.updateUser,
                invalidateUser:async uid => { arrived();await barrier;await users.invalidateUserCaches(uid); },
                deleteUserSessions:sessions.deleteUserSessions,fetchAccessState:async()=>null });
            const old = slow.processEvent(event(0,'10')); await entered;
            failEffects=true; await assert.rejects(authority.processEvent(event(null,'11')),/synthetic_redis_failure/);
            release();await old;
            const state = await authority.read(sub);assert.equal(state.authority_revision,'11');assert.equal(state.blocked,1);assert.equal(state.effects_pending,1);
            failEffects=false;await authority.completeEffects(sub);
        });
        await t.test('catalog role rows and settings come from one consistent snapshot', async () => {
            let release, arrived;
            const barrier = new Promise(resolve=>{release=resolve;});const entered=new Promise(resolve=>{arrived=resolve;});
            const wrappedPool={getConnection:async()=>{
                const db=await pool.getConnection();
                return new Proxy(db,{get(target,key){
                    if(key==='execute')return async(sql,args)=>{
                        const result=await target.execute(sql,args);
                        if(sql.startsWith('SELECT role_id,role_name')){arrived();await barrier;}
                        return result;
                    };
                    const value=target[key];return typeof value==='function'?value.bind(target):value;
                }});
            }};
            const pending=createCatalogStore(wrappedPool).snapshot({force:true});await entered;
            const writer=await pool.getConnection();
            try {await writer.beginTransaction();await writer.execute("UPDATE roles SET role_name='Renamed' WHERE role_id=0");
                await writer.execute("UPDATE site_settings SET setting_value='2' WHERE setting_key='registration_default_role'");await writer.commit();}
            finally {writer.release();release();}
            const old=await pending;assert.equal(old.payload.roles[0].name,'Root');assert.equal(old.payload.default_role,null);
            const current=await store.snapshot();assert.equal(current.payload.roles[0].name,'Renamed');assert.equal(current.payload.default_role,2);
        });
        await t.test('same-version login rechecks disabled state and restores only after an allowed current pull',async()=>{
            const uid=crypto.randomUUID();await pool.execute('INSERT INTO users VALUES(?,2)',[Buffer.from(uid.replace(/-/g,''),'hex')]);
            let allowed=false,pulls=0;
            const reader=createAuthorityService({pool,updateUser:users.updateUser,invalidateUser:users.invalidateUserCaches,
                deleteUserSessions:sessions.deleteUserSessions,
                fetchAccessState:async()=>{pulls++;return {roleId:2,version:{epoch,revision:'3'},allowed};}});
            const claims={sub:uid,app_role:2,app_role_epoch:epoch,app_role_revision:'3'};
            await reader.applyLogin(claims);await reader.refresh(uid);
            const denied=await reader.read(uid);assert.equal(denied.blocked,1);assert.equal(denied.role_id,2);
            await assert.rejects(reader.applyLogin(claims),/role_out_of_sync/);assert.equal(pulls,2);
            assert.equal((await reader.read(uid)).session_generation,denied.session_generation);
            allowed=true;
            const restored=await reader.applyLogin(claims);assert.equal(pulls,3);assert.equal(restored.blocked,0);
            assert.equal(restored.authority_revision,'3');assert.equal(restored.session_generation,denied.session_generation);
            assert.equal(require('../lib/ssoRoleProtocol').sessionPermitted(restored,'0'),false);
        });
        await t.test('an old disabled pull cannot overwrite an unchanged newer pull or accepted login',async()=>{
            const uid=crypto.randomUUID();await pool.execute('INSERT INTO users VALUES(?,2)',[Buffer.from(uid.replace(/-/g,''),'hex')]);
            const claims={sub:uid,app_role:2,app_role_epoch:epoch,app_role_revision:'5'};
            await authority.applyLogin(claims);
            for(const newer of ['pull','login']){
                let release,arrived,calls=0;
                const barrier=new Promise(resolve=>{release=resolve;});const entered=new Promise(resolve=>{arrived=resolve;});
                const reader=createAuthorityService({pool,updateUser:users.updateUser,invalidateUser:users.invalidateUserCaches,
                    deleteUserSessions:sessions.deleteUserSessions,
                    fetchAccessState:async()=>{if(++calls===1){arrived();await barrier;return {roleId:2,version:{epoch,revision:'5'},allowed:false};}
                        return {roleId:2,version:{epoch,revision:'5'},allowed:true};}});
                const old=reader.refresh(uid);await entered;
                if(newer==='pull')await reader.refresh(uid);else await reader.applyLogin(claims);
                release();const obsolete=await old;assert.equal(obsolete.outcome,'stale');
                const current=await reader.read(uid);assert.equal(current.blocked,0);assert.equal(current.session_generation,'0');
                if(newer==='login'){
                    const [[retry]]=await pool.execute('SELECT TIMESTAMPDIFF(SECOND,NOW(6),refresh_after) AS delay FROM sso_role_authority WHERE subject_id=?',[uid]);
                    assert.ok(retry.delay<=60 && retry.delay>=0);
                }
            }
        });
        await t.test('login refresh cannot cross a pinned foreign authority epoch',async()=>{
            const uid=crypto.randomUUID();await pool.execute('INSERT INTO users VALUES(?,2)',[Buffer.from(uid.replace(/-/g,''),'hex')]);
            await authority.applyLogin({sub:uid,app_role:2,app_role_epoch:epoch,app_role_revision:'4'});
            const foreign=crypto.randomUUID();
            const reader=createAuthorityService({pool,updateUser:users.updateUser,invalidateUser:users.invalidateUserCaches,
                deleteUserSessions:sessions.deleteUserSessions,
                fetchAccessState:async()=>({roleId:2,version:{epoch:foreign,revision:'100'},allowed:true})});
            await assert.rejects(reader.applyLogin({sub:uid,app_role:2,app_role_epoch:foreign,app_role_revision:'100'}),/role_out_of_sync/);
            const state=await reader.read(uid);assert.equal(state.authority_epoch,epoch);assert.equal(state.authority_revision,'4');assert.equal(state.blocked,1);
        });
        await t.test('same-version login rechecks that its local role still exists',async()=>{
            const uid=crypto.randomUUID();await pool.execute("INSERT INTO roles VALUES(99,'Temporary',20,0)");
            await pool.execute('INSERT INTO users VALUES(?,2)',[Buffer.from(uid.replace(/-/g,''),'hex')]);
            const reader=createAuthorityService({pool,updateUser:users.updateUser,invalidateUser:users.invalidateUserCaches,
                deleteUserSessions:sessions.deleteUserSessions,
                fetchAccessState:async()=>({roleId:99,version:{epoch,revision:'1'},allowed:true})});
            const claims={sub:uid,app_role:99,app_role_epoch:epoch,app_role_revision:'1'};
            await reader.applyLogin(claims);
            await pool.execute('UPDATE users SET role_id=2 WHERE user_id=?',[Buffer.from(uid.replace(/-/g,''),'hex')]);
            await pool.execute('DELETE FROM roles WHERE role_id=99');
            await assert.rejects(reader.applyLogin(claims),/role_out_of_sync/);
            assert.equal((await reader.read(uid)).blocked,1);
        });
        await t.test('catalog retries preserve current ID, cap backoff, and revive only due latest dead work',async()=>{
            await pool.execute("UPDATE sso_pending_events SET status='delivered' WHERE status='pending'");
            await pool.execute('UPDATE sso_catalog_state SET lease_token=NULL,lease_until=NULL,next_attempt_at=NOW(6)');
            const first=await store.snapshot({force:true}),again=await store.snapshot({force:true});assert.equal(first.id,again.id);
            await pool.execute('UPDATE sso_pending_events SET attempts=49,next_attempt_at=NOW(6) WHERE id=?',[first.id]);
            const job=await store.claim();assert.equal(job.event.id,first.id);await store.finish(job,false);
            const [[failed]]=await pool.execute('SELECT status,attempts,TIMESTAMPDIFF(SECOND,NOW(6),next_attempt_at) AS delay FROM sso_pending_events WHERE id=?',[first.id]);
            assert.equal(failed.status,'pending');assert.equal(failed.attempts,50);assert.ok(failed.delay>=3598);
            await store.snapshot();await store.snapshot();assert.equal(await store.claim(),null);
            await pool.execute("UPDATE sso_pending_events SET status='dead' WHERE id=?",[first.id]);
            await store.snapshot();assert.equal((await pool.execute('SELECT status FROM sso_pending_events WHERE id=?',[first.id]))[0][0].status,'dead');
            await pool.execute('UPDATE sso_pending_events SET next_attempt_at=DATE_SUB(NOW(6),INTERVAL 1 SECOND) WHERE id=?',[first.id]);
            await pool.execute('UPDATE sso_catalog_state SET next_attempt_at=NOW(6)');
            const revived=await store.snapshot();assert.equal(revived.id,first.id);
            const retry=await store.claim();assert.equal(retry.event.id,first.id);assert.deepEqual(retry.event.payload,first.payload);assert.equal(retry.attempts,50);
            await store.finish(retry,true);
            const forced=await store.snapshot({force:true});assert.equal(forced.id,first.id);
            const permanent=await store.claim();await store.finish(permanent,false,{permanent:true});
            await pool.execute('UPDATE sso_pending_events SET next_attempt_at=NOW(6) WHERE id=?',[first.id]);
            await store.snapshot();assert.equal((await pool.execute('SELECT status FROM sso_pending_events WHERE id=?',[first.id]))[0][0].status,'dead');
            await pool.execute("UPDATE site_settings SET setting_value='After outage' WHERE setting_key='site_name'");
            const latest=await store.snapshot();assert.notEqual(latest.id,first.id);
            await store.snapshot();assert.equal((await pool.execute('SELECT status FROM sso_pending_events WHERE id=?',[first.id]))[0][0].status,'superseded');
        });
        await t.test('a stale first login repairs a placeholder through an authoritative same pull',async()=>{
            const uid=crypto.randomUUID(),local=Buffer.from(uid.replace(/-/g,''),'hex');
            const reader=createAuthorityService({pool,updateUser:users.updateUser,invalidateUser:users.invalidateUserCaches,
                deleteUserSessions:sessions.deleteUserSessions,
                fetchAccessState:async()=>({roleId:0,version:{epoch,revision:'5'},allowed:true})});
            await reader.processEvent({id:crypto.randomUUID(),payload:{sub:uid,role_id:0,authority_epoch:epoch,authority_revision:'5'}});
            await pool.execute('INSERT INTO users VALUES(?,2)',[local]);
            const accepted=await reader.applyLogin({sub:uid,app_role:2,app_role_epoch:epoch,app_role_revision:'4'});
            assert.equal(accepted.role_id,0);assert.equal(accepted.effects_pending,0);
            assert.equal((await pool.execute('SELECT role_id FROM users WHERE user_id=?',[local]))[0][0].role_id,0);
        });
        await t.test('unmanaged login fails without mutating authority or revoking sessions',async()=>{
            const uid=crypto.randomUUID();
            await assert.rejects(authority.applyLogin({sub:uid}),/role_out_of_sync/);assert.equal(await authority.read(uid),null);
            await authority.processEvent({id:crypto.randomUUID(),payload:{sub:uid,role_id:2}});
            const before=await authority.read(uid);await assert.rejects(authority.applyLogin({sub:uid}),/role_out_of_sync/);
            assert.deepEqual(await authority.read(uid),before);
        });
        await t.test('harmless concurrent observations preserve both login session generations',async()=>{
            const uid=crypto.randomUUID();await pool.execute('INSERT INTO users VALUES(?,2)',[Buffer.from(uid.replace(/-/g,''),'hex')]);
            const claims={sub:uid,app_role:2,app_role_epoch:epoch,app_role_revision:'1'};
            const [first,second]=await Promise.all([authority.applyLogin(claims),authority.applyLogin(claims)]);
            const current=await authority.read(uid),gate=require('../lib/ssoRoleProtocol').sessionPermitted;
            assert.equal(gate(current,first.session_generation),true);assert.equal(gate(current,second.session_generation),true);
            assert.equal(current.session_generation,'0');
        });
        await t.test('sweep prioritizes conflicts fairly, polls active local sessions, and skips watermark-only subjects',async()=>{
            await pool.execute('UPDATE sso_role_authority SET refresh_after=DATE_ADD(NOW(6),INTERVAL 1 DAY)');
            const routine=[];
            for(let i=0;i<105;i++){
                const uid=crypto.randomUUID();routine.push(uid);const local=Buffer.from(uid.replace(/-/g,''),'hex');
                await pool.execute('INSERT INTO users VALUES(?,2)',[local]);
                await pool.execute('INSERT INTO sessions(session_id,user_id) VALUES(?,?)',['routine-'+uid,local]);
                await pool.execute(`INSERT INTO sso_role_authority(subject_id,authority_epoch,authority_revision,role_id,refresh_after)
                    VALUES(?,?,1,2,DATE_SUB(NOW(6),INTERVAL 1 HOUR))`,[uid,epoch]);
            }
            const urgent=crypto.randomUUID(),unknown=crypto.randomUUID();
            await pool.execute(`INSERT INTO sso_role_authority(subject_id,authority_epoch,authority_revision,role_id,blocked,refresh_pending)
                VALUES(?,?,1,2,1,1),(?,?,1,2,0,0)`,[urgent,epoch,unknown,epoch]);
            const seen=[];
            const reader=createAuthorityService({pool,updateUser:users.updateUser,invalidateUser:users.invalidateUserCaches,
                deleteUserSessions:sessions.deleteUserSessions,
                fetchAccessState:async uid=>{seen.push(uid);return {roleId:2,version:{epoch,revision:'1'},allowed:true};}});
            await reader.sweep();assert.equal(seen[0],urgent);assert.equal(seen.length,100);assert.equal(seen.includes(unknown),false);
            assert.equal(seen.filter(uid=>routine.includes(uid)).length,99);
            for(let i=0;i<100;i++)await pool.execute(`INSERT INTO sso_role_authority(subject_id,authority_epoch,authority_revision,role_id,blocked,refresh_pending)
                VALUES(?,?,1,2,1,1)`,[crypto.randomUUID(),epoch]);
            for(const uid of routine)await pool.execute('UPDATE sso_role_authority SET refresh_after=DATE_SUB(NOW(6),INTERVAL 1 HOUR) WHERE subject_id=?',[uid]);
            seen.length=0;await reader.sweep();assert.equal(seen.length,100);assert.equal(seen.filter(uid=>routine.includes(uid)).length,25);
            assert.equal(seen.includes(unknown),false);
        });
        await t.test('first same-revision contradictory pull denies; a later fresh pull resolves the quarantine',async()=>{
            const uid=crypto.randomUUID(),local=Buffer.from(uid.replace(/-/g,''),'hex');await pool.execute('INSERT INTO users VALUES(?,2)',[local]);
            const reader=createAuthorityService({pool,updateUser:users.updateUser,invalidateUser:users.invalidateUserCaches,
                deleteUserSessions:sessions.deleteUserSessions,
                fetchAccessState:async()=>({roleId:0,version:{epoch,revision:'1'},allowed:true})});
            await reader.applyLogin({sub:uid,app_role:2,app_role_epoch:epoch,app_role_revision:'1'});
            const first=await reader.refresh(uid);assert.equal(first.outcome,'conflict');assert.equal(first.state.blocked,1);assert.equal(first.state.role_id,2);
            assert.equal((await pool.execute('SELECT role_id FROM users WHERE user_id=?',[local]))[0][0].role_id,2);
            const next=await reader.refresh(uid);assert.equal(next.state.blocked,0);assert.equal(next.state.role_id,0);
            assert.equal(next.state.session_generation,first.state.session_generation);assert.equal(next.state.authority_revision,'1');
        });
        await t.test('a persistently rejected catalog is superseded and its late lease cannot delay the new head',async()=>{
            await pool.execute("UPDATE sso_pending_events SET status='delivered' WHERE status='pending'");
            await pool.execute('UPDATE sso_catalog_state SET lease_token=NULL,lease_event_id=NULL,lease_until=NULL,next_attempt_at=NOW(6)');
            const first=await store.snapshot({force:true});
            const oidc=require('../lib/oidc'),transport=require('../services/s2sFetch');
            const original={sign:oidc.signEventToken,fetch:transport.s2sFetch,url:oidc.ssoEventsUrl};
            const sent=[];let status=400;
            oidc.signEventToken=async batch=>{sent.push(JSON.parse(JSON.stringify(batch[0])));return 'synthetic-token';};
            oidc.ssoEventsUrl=()=> 'https://sso.example.invalid/backchannel/events';transport.s2sFetch=async()=>({status});
            const modulePath=require.resolve('../services/ssoEvents');delete require.cache[modulePath];
            try{
                const sender=require('../services/ssoEvents');await sender.drain();assert.equal(sent[0].id,first.id);
                await pool.execute("UPDATE site_settings SET setting_value='After rejection' WHERE setting_key='site_name'");
                status=204;await sender.drain();assert.equal(sent.length,2);assert.notEqual(sent[1].id,first.id);
                const [[retired]]=await pool.execute('SELECT status,payload FROM sso_pending_events WHERE id=?',[first.id]);
                assert.equal(retired.status,'superseded');assert.deepEqual(JSON.parse(retired.payload),first.payload);
            }finally{oidc.signEventToken=original.sign;oidc.ssoEventsUrl=original.url;transport.s2sFetch=original.fetch;delete require.cache[modulePath];}
            await store.snapshot({force:true});const oldLease=await store.claim();assert.ok(oldLease);
            await pool.execute("UPDATE site_settings SET setting_value='After in-flight' WHERE setting_key='site_name'");
            const current=await store.snapshot();assert.equal(await store.finish(oldLease,false),false);
            const newest=await store.claim();assert.equal(newest.event.id,current.id);await store.finish(newest,true);
            const generic=await store.enqueue('fixture.notice',{value:1}),genericLease=await store.claim();assert.equal(genericLease.event.id,generic.id);
            await store.snapshot({force:true});
            await pool.execute("UPDATE site_settings SET setting_value='Preserve generic lease' WHERE setting_key='site_name'");
            const final=await store.snapshot();assert.equal(await store.finish(genericLease,true),true);
            const finalLease=await store.claim();assert.equal(finalLease.event.id,final.id);await store.finish(finalLease,true);
        });
        await t.test('fresh headerless non-active account denial preserves the pinned role and is idempotent',async()=>{
            const uid=crypto.randomUUID(),local=Buffer.from(uid.replace(/-/g,''),'hex');await pool.execute('INSERT INTO users VALUES(?,2)',[local]);
            await authority.applyLogin({sub:uid,app_role:2,app_role_epoch:epoch,app_role_revision:'7'});
            await pool.execute('INSERT INTO sessions(session_id,user_id) VALUES(?,?)',['headerless-session',local]);
            await redis.sadd('user:sessions:'+uid.replace(/-/g,''),'headerless-session');await redis.hset('session:user:headerless-session','user_id',uid.replace(/-/g,''));
            let accountStatus='disabled';
            const reader=createAuthorityService({pool,updateUser:users.updateUser,invalidateUser:users.invalidateUserCaches,
                deleteUserSessions:sessions.deleteUserSessions,
                fetchAccessState:async()=>({roleId:null,version:null,accountStatus,allowed:false})});
            await reader.refresh(uid);const denied=await reader.read(uid);
            assert.equal(denied.blocked,1);assert.equal(denied.authority_epoch,epoch);assert.equal(denied.authority_revision,'7');assert.equal(denied.role_id,2);
            assert.equal(denied.refresh_pending,0);assert.equal(await redis.exists('session:user:headerless-session'),0);
            await reader.refresh(uid);assert.equal((await reader.read(uid)).session_generation,denied.session_generation);
            accountStatus='active';const before=await reader.read(uid);const ignored=await reader.refresh(uid);
            assert.equal(ignored.outcome,'legacy');assert.equal((await reader.read(uid)).generation,before.generation);assert.equal((await reader.read(uid)).blocked,1);
            const active=crypto.randomUUID();await authority.processEvent({id:crypto.randomUUID(),payload:{sub:active,role_id:2,authority_epoch:epoch,authority_revision:'8'}});
            await reader.refresh(active);assert.equal((await reader.read(active)).blocked,0);
            await authority.processEvent({id:crypto.randomUUID(),payload:{sub:active,role_id:null,denied:true,account_status:'disabled'}});
            assert.equal((await authority.read(active)).blocked,0);
            await authority.processEvent({id:crypto.randomUUID(),payload:{sub:active,role_id:0,authority_epoch:epoch,authority_revision:'8'}});
            const conflict=await authority.read(active);accountStatus='disabled';await reader.refresh(active);
            const preserved=await reader.read(active);assert.equal(preserved.refresh_pending,conflict.refresh_pending);
            assert.equal(preserved.role_id,conflict.role_id);assert.equal(preserved.authority_revision,conflict.authority_revision);assert.equal(preserved.session_generation,conflict.session_generation);
        });
        await t.test('late headerless denial and failed queries cannot revoke a newer accepted login',async()=>{
            const uid=crypto.randomUUID();await pool.execute('INSERT INTO users VALUES(?,2)',[Buffer.from(uid.replace(/-/g,''),'hex')]);
            const claims={sub:uid,app_role:2,app_role_epoch:epoch,app_role_revision:'10'};await authority.applyLogin(claims);
            let release,arrived;const barrier=new Promise(resolve=>{release=resolve;});const entered=new Promise(resolve=>{arrived=resolve;});
            const reader=createAuthorityService({pool,updateUser:users.updateUser,invalidateUser:users.invalidateUserCaches,
                deleteUserSessions:sessions.deleteUserSessions,
                fetchAccessState:async()=>{arrived();await barrier;return {roleId:null,version:null,accountStatus:'disabled',allowed:false};}});
            const old=reader.refresh(uid);await entered;await authority.applyLogin(claims);release();assert.equal((await old).outcome,'stale');
            const before=await authority.read(uid);assert.equal(before.blocked,0);assert.equal(before.session_generation,'0');
            const offline=createAuthorityService({pool,updateUser:users.updateUser,invalidateUser:users.invalidateUserCaches,
                deleteUserSessions:sessions.deleteUserSessions,fetchAccessState:async()=>{throw new Error('synthetic_network_failure');}});
            await assert.rejects(offline.refresh(uid),/synthetic_network_failure/);assert.deepEqual(await authority.read(uid),before);
        });
        await t.test('a delayed newer role grant and pre-denial token cannot clear a confirmed account block',async()=>{
            const uid=crypto.randomUUID();await pool.execute('INSERT INTO users VALUES(?,2)',[Buffer.from(uid.replace(/-/g,''),'hex')]);
            await authority.applyLogin({sub:uid,app_role:2,app_role_epoch:epoch,app_role_revision:'7'});
            let response={roleId:null,version:null,accountStatus:'disabled',allowed:false};
            const reader=createAuthorityService({pool,updateUser:users.updateUser,invalidateUser:users.invalidateUserCaches,
                deleteUserSessions:sessions.deleteUserSessions,fetchAccessState:async()=>response});
            await reader.refresh(uid);const denied=await reader.read(uid);
            await reader.processEvent({id:crypto.randomUUID(),payload:{sub:uid,role_id:0,authority_epoch:epoch,authority_revision:'8'}});
            const grant=await reader.read(uid);assert.equal(grant.role_id,0);assert.equal(grant.authority_revision,'8');assert.equal(grant.blocked,1);assert.equal(grant.refresh_pending,1);
            response={roleId:0,version:{epoch,revision:'8'},accountStatus:'disabled',allowed:false};
            const token={sub:uid,app_role:0,app_role_epoch:epoch,app_role_revision:'8'};
            await assert.rejects(reader.applyLogin(token),/role_out_of_sync/);assert.equal((await reader.read(uid)).session_generation,denied.session_generation);
            response={...response,accountStatus:'active',allowed:true};const restored=await reader.applyLogin(token);
            assert.equal(restored.blocked,0);assert.equal(restored.session_generation,denied.session_generation);
            assert.equal(require('../lib/ssoRoleProtocol').sessionPermitted(restored,'0'),false);
        });
    } finally { await pool.end(); await redis.quit(); }
});
