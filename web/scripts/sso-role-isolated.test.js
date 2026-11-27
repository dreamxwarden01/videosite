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
        await pool.execute(`CREATE TABLE users(user_id BINARY(16) PRIMARY KEY,role_id INT,
            username VARCHAR(50) NULL UNIQUE,display_name VARCHAR(100),email VARCHAR(255) NULL UNIQUE,
            sso_avatar VARCHAR(80),created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP)`);
        await pool.execute(`CREATE TABLE sessions(session_id VARCHAR(128) PRIMARY KEY,user_id BINARY(16),
            last_sign_in DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),sso_expires_at DATETIME(6) NULL)`);
        await require('../db/ssoRoleMigration').migrateSsoRoles(pool);
        await require('../db/ssoRoleMigration').migrateSsoRoles(pool);
        await require('../db/ssoAccountStatusMigration').migrateSsoAccountStatus(pool);
        await require('../db/ssoAccountStatusMigration').migrateSsoAccountStatus(pool);
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
        await pool.execute('INSERT INTO users(user_id,role_id) VALUES(?,2)', [Buffer.from(hex, 'hex')]);
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
            await pool.execute('INSERT INTO users(user_id,role_id) VALUES(?,2)',[Buffer.from(unknown.replace(/-/g,''),'hex')]);
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
            const uid=crypto.randomUUID();await pool.execute('INSERT INTO users(user_id,role_id) VALUES(?,2)',[Buffer.from(uid.replace(/-/g,''),'hex')]);
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
            const uid=crypto.randomUUID();await pool.execute('INSERT INTO users(user_id,role_id) VALUES(?,2)',[Buffer.from(uid.replace(/-/g,''),'hex')]);
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
            const uid=crypto.randomUUID();await pool.execute('INSERT INTO users(user_id,role_id) VALUES(?,2)',[Buffer.from(uid.replace(/-/g,''),'hex')]);
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
            await pool.execute('INSERT INTO users(user_id,role_id) VALUES(?,2)',[Buffer.from(uid.replace(/-/g,''),'hex')]);
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
            await pool.execute('INSERT INTO users(user_id,role_id) VALUES(?,2)',[local]);
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
            const uid=crypto.randomUUID();await pool.execute('INSERT INTO users(user_id,role_id) VALUES(?,2)',[Buffer.from(uid.replace(/-/g,''),'hex')]);
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
                await pool.execute('INSERT INTO users(user_id,role_id) VALUES(?,2)',[local]);
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
            const uid=crypto.randomUUID(),local=Buffer.from(uid.replace(/-/g,''),'hex');await pool.execute('INSERT INTO users(user_id,role_id) VALUES(?,2)',[local]);
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
            const uid=crypto.randomUUID(),local=Buffer.from(uid.replace(/-/g,''),'hex');await pool.execute('INSERT INTO users(user_id,role_id) VALUES(?,2)',[local]);
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
            const uid=crypto.randomUUID();await pool.execute('INSERT INTO users(user_id,role_id) VALUES(?,2)',[Buffer.from(uid.replace(/-/g,''),'hex')]);
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
            const uid=crypto.randomUUID();await pool.execute('INSERT INTO users(user_id,role_id) VALUES(?,2)',[Buffer.from(uid.replace(/-/g,''),'hex')]);
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
            const offline=createAuthorityService({pool,updateUser:users.updateUser,invalidateUser:users.invalidateUserCaches,
                deleteUserSessions:sessions.deleteUserSessions,fetchAccessState:async()=>{throw new Error('synthetic_offline');}});
            await assert.rejects(offline.applyLogin({...token,app_role_revision:'9'}),/role_out_of_sync/);
            assert.equal((await reader.read(uid)).account_status,'disabled');
            assert.equal((await users.getUserById(uid.replace(/-/g,''))).access_status,'disabled');
            response={...response,version:{epoch,revision:'9'}};
            response={...response,accountStatus:'active',allowed:true};const restored=await reader.applyLogin(token);
            assert.equal(restored.blocked,0);assert.equal(restored.session_generation,denied.session_generation);
            assert.equal(require('../lib/ssoRoleProtocol').sessionPermitted(restored,'0'),false);
        });
        await t.test('versioned non-active account status closes sessions; positive events cannot clear it',async()=>{
            const cache=require('../services/cache/sessionCache');
            const uid=crypto.randomUUID(),local=uid.replace(/-/g,'');await pool.execute('INSERT INTO users(user_id,role_id) VALUES(?,2)',[Buffer.from(local,'hex')]);
            const statusEvent=(status,revision)=>({id:crypto.randomUUID(),payload:{sub:uid,role_id:2,authority_epoch:epoch,authority_revision:revision,account_status:status}});
            let response={roleId:2,version:{epoch,revision:'22'},accountStatus:'active',allowed:true};
            const reader=createAuthorityService({pool,updateUser:users.updateUser,invalidateUser:users.invalidateUserCaches,
                deleteUserSessions:sessions.deleteUserSessions,fetchAccessState:async()=>response});
            await reader.processEvent(statusEvent('active','20'));
            await pool.execute('INSERT INTO sessions(session_id,user_id) VALUES(?,?)',['status-session',Buffer.from(local,'hex')]);
            await cache.createSession('status-session',{userId:local,lastSignIn:Date.now(),lastSeen:Date.now(),roleGeneration:'0'},60);
            await reader.processEvent(statusEvent('disabled','21'));
            const denied=await reader.read(uid);assert.equal(denied.account_status,'disabled');assert.equal(denied.blocked,1);assert.equal(denied.session_generation,'1');
            assert.equal(Number((await pool.execute('SELECT COUNT(*) AS n FROM sessions WHERE session_id=?',['status-session']))[0][0].n),0);
            assert.equal(await cache.getSession('status-session'),null);
            await reader.processEvent(statusEvent('active','21'));
            let state=await reader.read(uid);assert.equal(state.blocked,1);assert.equal(state.account_status,'disabled');
            await reader.processEvent(statusEvent('active','22'));
            state=await reader.read(uid);assert.equal(state.account_status,'active');assert.equal(state.blocked,1);assert.equal(state.session_generation,'1');
            await reader.refresh(uid);state=await reader.read(uid);assert.equal(state.blocked,0);assert.equal(state.session_generation,'1');
            await reader.processEvent(statusEvent('disabled','20'));assert.equal((await reader.read(uid)).blocked,0);
            response={...response,accountStatus:'disabled',allowed:false};await reader.refresh(uid);
            state=await reader.read(uid);assert.equal(state.blocked,1);assert.equal(state.account_status,'disabled');
            response={...response,accountStatus:'active',allowed:true};await reader.refresh(uid);
            state=await reader.read(uid);assert.equal(state.blocked,0);assert.equal(state.account_status,'active');
        });
        await t.test('confirmed disabled pulls settle urgent work without repeating cache/session effects and can reactivate freshly',async()=>{
            const uid=crypto.randomUUID(),local=uid.replace(/-/g,'');await pool.execute('INSERT INTO users(user_id,role_id) VALUES(?,2)',[Buffer.from(local,'hex')]);
            let invalidations=0,deletions=0;
            let response={roleId:2,version:{epoch,revision:'41'},accountStatus:'disabled',allowed:false};
            const reader=createAuthorityService({pool,updateUser:users.updateUser,
                invalidateUser:async id=>{invalidations++;await users.invalidateUserCaches(id);},
                deleteUserSessions:async id=>{deletions++;await sessions.deleteUserSessions(id);},fetchAccessState:async()=>response});
            const event=(status,revision)=>({id:crypto.randomUUID(),payload:{sub:uid,role_id:2,authority_epoch:epoch,authority_revision:revision,account_status:status}});
            await reader.processEvent(event('active','40'));await reader.processEvent(event('disabled','41'));
            assert.equal((await reader.read(uid)).refresh_pending,1);
            await reader.refresh(uid);const confirmed=await reader.read(uid);
            assert.equal(confirmed.blocked,1);assert.equal(confirmed.refresh_pending,0);assert.equal(confirmed.effects_pending,0);
            const effects={invalidations,deletions};
            for(let i=0;i<3;i++)await reader.refresh(uid);
            const stable=await reader.read(uid);
            assert.equal(stable.blocked,1);assert.equal(stable.refresh_pending,0);assert.equal(stable.effects_pending,0);
            assert.equal(stable.session_generation,confirmed.session_generation);
            assert.ok(BigInt(stable.generation)>BigInt(confirmed.generation),'fresh observations still fence older in-flight queries');
            assert.deepEqual({invalidations,deletions},effects);
            const [[scheduled]]=await pool.execute('SELECT TIMESTAMPDIFF(SECOND,NOW(6),refresh_after) AS delay FROM sso_role_authority WHERE subject_id=?',[uid]);
            assert.ok(scheduled.delay>60 && scheduled.delay<=300,'confirmation uses routine delay, not urgent tick');
            response={...response,accountStatus:'active',allowed:true};await reader.refresh(uid);
            const restored=await reader.read(uid);assert.equal(restored.blocked,0);assert.equal(restored.account_status,'active');
            assert.equal(restored.refresh_pending,0);assert.equal(restored.session_generation,confirmed.session_generation);
        });
        const seed = uid => ({preferred_username:'seed_'+uid.slice(0,8),name:'Seeded Student',
            picture:uid+'-0123456789abcdef.webp',email:uid+'@example.test',email_verified:true});
        const provisionEvent = (uid, revision='1', profile=seed(uid), role=2, lineage=epoch) => ({id:crypto.randomUUID(),type:'account.roles_change',
            payload:{sub:uid,role_id:role,account_status:'active',authority_epoch:lineage,authority_revision:revision,...(profile===undefined?{}:{profile})}});
        const makeProvisioner = (extra={}) => createAuthorityService({pool,updateUser:users.updateUser,createUser:users.createMissingBySub,
            invalidateUser:users.invalidateUserCaches,deleteUserSessions:sessions.deleteUserSessions,
            fetchAccessState:async()=>({roleId:2,version:{epoch,revision:'2'},accountStatus:'active',allowed:true}),...extra});
        const rowFor = async uid => (await pool.execute('SELECT * FROM users WHERE user_id=?',[Buffer.from(uid.replace(/-/g,''),'hex')]))[0][0];
        await t.test('active seed creates a directory user and enrollment candidate before first login',async()=>{
            await pool.execute('CREATE TABLE role_permissions(role_id INT,permission_key VARCHAR(80),granted TINYINT)');
            await pool.execute('CREATE TABLE user_permission_overrides(user_id BINARY(16),permission_key VARCHAR(80),override_value INT)');
            const uid=crypto.randomUUID(),profile=seed(uid),reader=makeProvisioner(),ev=provisionEvent(uid);
            await reader.processEvent(ev);await reader.processEvent(ev);
            const row=await rowFor(uid);assert.equal(row.username,profile.preferred_username);assert.equal(row.display_name,profile.name);
            assert.equal(row.email,profile.email);assert.equal(row.sso_avatar,profile.picture);assert.equal(row.role_id,2);
            const listed=await users.listUsers(0,1,60,'ASC',profile.preferred_username);
            assert.equal(Number(listed.total),1);assert.equal(listed.users[0].access_status,'active');
            const candidates=await require('../services/enrollmentService').getEnrollableStudents(0);
            assert.ok(candidates.some(value=>value.user_id.equals(Buffer.from(uid.replace(/-/g,''),'hex'))));
            const [[sessionsRow]]=await pool.execute('SELECT COUNT(*) n FROM sessions WHERE user_id=?',[row.user_id]);assert.equal(Number(sessionsRow.n),0);
        });
        await t.test('seeded revocation preserves directory, avatar, enrollment and progress; late seed cannot overwrite login',async()=>{
            await pool.execute('CREATE TABLE enrollments(user_id BINARY(16),course_id INT,PRIMARY KEY(user_id,course_id))');
            await pool.execute('CREATE TABLE watch_progress(user_id BINARY(16),video_id INT,PRIMARY KEY(user_id,video_id))');
            const uid=crypto.randomUUID(),reader=makeProvisioner(),ev=provisionEvent(uid),id=Buffer.from(uid.replace(/-/g,''),'hex');
            await reader.processEvent(ev);
            await users.findOrCreateBySub({sub:uid,name:'New login name',email:'new-'+uid+'@example.test'});
            await reader.applyLogin({sub:uid,app_role:2,app_role_epoch:epoch,app_role_revision:'1'});
            await reader.processEvent({...ev,id:crypto.randomUUID()});assert.equal((await rowFor(uid)).display_name,'New login name');
            await pool.execute('INSERT INTO enrollments VALUES(?,7)',[id]);await pool.execute('INSERT INTO watch_progress VALUES(?,9)',[id]);
            await pool.execute("INSERT INTO sessions(session_id,user_id) VALUES(?,?)",['seed-session-'+uid,id]);
            await reader.processEvent({id:crypto.randomUUID(),payload:{sub:uid,role_id:null,account_status:'active',authority_epoch:epoch,authority_revision:'2'}});
            await reader.processEvent({...ev,id:crypto.randomUUID()});
            const row=await rowFor(uid);assert.equal(row.display_name,'New login name');assert.equal(row.sso_avatar,seed(uid).picture);
            const [[enrollment]]=await pool.execute('SELECT COUNT(*) n FROM enrollments WHERE user_id=?',[id]);assert.equal(Number(enrollment.n),1);
            const [[progress]]=await pool.execute('SELECT COUNT(*) n FROM watch_progress WHERE user_id=?',[id]);assert.equal(Number(progress.n),1);
            const [[session]]=await pool.execute('SELECT COUNT(*) n FROM sessions WHERE user_id=?',[id]);assert.equal(Number(session.n),0);
            assert.equal((await users.getUserById(uid.replace(/-/g,''))).access_status,'no_access');
        });
        await t.test('stale, contradictory and foreign-lineage seeds never create users',async()=>{
            for(const mode of ['stale','conflict','foreign']){
                const uid=crypto.randomUUID(),reader=makeProvisioner();
                await reader.processEvent({id:crypto.randomUUID(),payload:{sub:uid,role_id:null,account_status:'active',authority_epoch:epoch,authority_revision:'2'}});
                const ev=provisionEvent(uid,mode==='stale'?'1':'2',seed(uid),2,mode==='foreign'?crypto.randomUUID():epoch);
                await reader.processEvent(ev);assert.equal(await rowFor(uid),undefined);assert.equal((await reader.read(uid)).blocked,1);
            }
        });
        await t.test('new grant after a tombstone seeds data but remains pending until a fresh allowed pull',async()=>{
            const uid=crypto.randomUUID();let allowed=false;
            const reader=makeProvisioner({fetchAccessState:async()=>({roleId:2,version:{epoch,revision:'2'},accountStatus:'active',allowed})});
            await reader.processEvent({id:crypto.randomUUID(),payload:{sub:uid,role_id:null,account_status:'active',authority_epoch:epoch,authority_revision:'1'}});
            const generation=(await reader.read(uid)).session_generation;
            await reader.processEvent(provisionEvent(uid,'2'));
            assert.ok(await rowFor(uid));assert.equal((await reader.read(uid)).blocked,1);
            assert.equal((await users.getUserById(uid.replace(/-/g,''))).access_status,'pending');
            const token={sub:uid,app_role:2,app_role_epoch:epoch,app_role_revision:'2'};
            await assert.rejects(reader.applyLogin(token),/role_out_of_sync/);assert.equal((await reader.read(uid)).blocked,1);
            allowed=true;const state=await reader.applyLogin(token);assert.equal(state.blocked,0);assert.equal(state.account_status,'active');
            assert.equal(state.session_generation,generation);assert.equal((await users.getUserById(uid.replace(/-/g,''))).access_status,'active');
        });
        await t.test('profile seeding rolls back with authority/inbox and retries after cache failure',async()=>{
            const uid=crypto.randomUUID(),ev=provisionEvent(uid);
            const broken=makeProvisioner({updateUser:async()=>{throw new Error('synthetic_after_seed');}});
            await assert.rejects(broken.processEvent(ev),/synthetic_after_seed/);assert.equal(await rowFor(uid),undefined);assert.equal(await broken.read(uid),null);
            const [[receipt]]=await pool.execute('SELECT COUNT(*) n FROM sso_role_inbox WHERE event_id=?',[ev.id]);assert.equal(Number(receipt.n),0);
            let fail=true;const reader=makeProvisioner({invalidateUser:async id=>{if(fail)throw new Error('synthetic_seed_cache');await users.invalidateUserCaches(id);}});
            await assert.rejects(reader.processEvent(ev),/synthetic_seed_cache/);assert.ok(await rowFor(uid));assert.equal((await reader.read(uid)).effects_pending,1);
            fail=false;await reader.processEvent(ev);assert.equal((await reader.read(uid)).effects_pending,0);
            const [[count]]=await pool.execute('SELECT COUNT(*) n FROM users WHERE user_id=?',[Buffer.from(uid.replace(/-/g,''),'hex')]);assert.equal(Number(count.n),1);
        });
        await t.test('username and stale email collisions keep distinct subject identities',async()=>{
            const old=crypto.randomUUID(),fresh=crypto.randomUUID(),profile=seed(old),reader=makeProvisioner();
            await reader.processEvent(provisionEvent(old));
            await reader.processEvent(provisionEvent(fresh,'1',{...profile,picture:null,name:'Different Student'}));
            const original=await rowFor(old),created=await rowFor(fresh);
            assert.equal(original.username,profile.preferred_username);assert.equal(original.email,profile.email);
            assert.equal(created.username,'u_'+fresh.replace(/-/g,''));assert.equal(created.email,null);assert.equal(created.display_name,'Different Student');
            assert.notDeepEqual(created.user_id,original.user_id);
        });
        await t.test('legacy natural and UUID-name collisions cannot strand a seed before a following revocation',async()=>{
            const naturalOwner=crypto.randomUUID(),fallbackOwner=crypto.randomUUID(),fresh=crypto.randomUUID();
            const reader=makeProvisioner(),profile=seed(naturalOwner),fallback='u_'+fresh.replace(/-/g,'');
            await reader.processEvent(provisionEvent(naturalOwner));
            await users.createMissingBySub(fallbackOwner,{preferred_username:fallback,name:'Legacy fallback owner'},2);
            const oldNatural=await rowFor(naturalOwner),oldFallback=await rowFor(fallbackOwner);
            await pool.execute('INSERT INTO sessions(session_id,user_id) VALUES(?,?)',['collision-revoke-'+naturalOwner,oldNatural.user_id]);
            const grant=provisionEvent(fresh,'1',{...profile,name:'New distinct subject',picture:null});
            const revoke={id:crypto.randomUUID(),type:'account.roles_change',payload:{sub:naturalOwner,role_id:null,
                account_status:'active',authority_epoch:epoch,authority_revision:'2'}};
            // Same ordered dispatch as the real receiver; a poison seed would
            // throw here and leave the following revocation unapplied.
            for(const ev of [grant,revoke])await reader.processEvent(ev);
            const created=await rowFor(fresh);
            assert.match(created.username,new RegExp('^'+fallback+'_[0-9a-f]{14}$'));
            assert.equal(created.username.length,49);assert.equal(created.email,null);
            assert.equal(created.display_name,'New distinct subject');assert.notDeepEqual(created.user_id,oldNatural.user_id);
            assert.notDeepEqual(created.user_id,oldFallback.user_id);
            assert.equal((await rowFor(naturalOwner)).username,oldNatural.username);assert.equal((await rowFor(naturalOwner)).email,oldNatural.email);
            assert.equal((await rowFor(fallbackOwner)).username,oldFallback.username);
            assert.equal((await reader.read(naturalOwner)).blocked,1);
            assert.equal((await pool.execute('SELECT 1 FROM sessions WHERE user_id=?',[oldNatural.user_id]))[0].length,0);
            const [[receipts]]=await pool.execute('SELECT COUNT(*) n FROM sso_role_inbox WHERE event_id IN (?,?)',[grant.id,revoke.id]);
            assert.equal(Number(receipts.n),2);
        });
        await t.test('scope-free seeds repair a same-version missing directory row without disclosing profile fields',async()=>{
            const uid=crypto.randomUUID(),reader=makeProvisioner(),ev=provisionEvent(uid);delete ev.payload.profile;
            await reader.processEvent(ev);assert.equal(await rowFor(uid),undefined);
            await reader.processEvent(provisionEvent(uid,'1',{}));const row=await rowFor(uid);
            assert.equal(row.username,'u_'+uid.replace(/-/g,''));assert.equal(row.email,null);assert.equal(row.sso_avatar,null);
            assert.equal(row.role_id,2);assert.equal((await users.getUserById(uid.replace(/-/g,''))).access_status,'active');
            const other=crypto.randomUUID(),profile={...seed(other),preferred_username:'🙂'.repeat(20),name:'🙂'.repeat(100)};
            await reader.processEvent(provisionEvent(other,'1',profile));
            assert.equal((await rowFor(other)).display_name,profile.name);assert.equal((await rowFor(other)).username,profile.preferred_username);
        });
        await t.test('admin access status distinguishes explicit account states from unconfirmed legacy users',async()=>{
            const uid=crypto.randomUUID(),reader=makeProvisioner();await reader.processEvent(provisionEvent(uid));
            for (const [index,status] of ['disabled','locked','deleted','not_found'].entries()) {
                await reader.processEvent({id:crypto.randomUUID(),payload:{sub:uid,role_id:2,account_status:status,authority_epoch:epoch,authority_revision:String(index+2)}});
                assert.equal((await users.getUserById(uid.replace(/-/g,''))).access_status,status==='not_found'?'deleted':status);
            }
            const legacy=crypto.randomUUID();await users.createMissingBySub(legacy,{},2);
            assert.equal((await users.getUserById(legacy.replace(/-/g,''))).access_status,'unknown');
        });
        await t.test('concurrent creation and first login converge on one canonical subject',async()=>{
            const uid=crypto.randomUUID(),profile=seed(uid);let arrived=0,release;
            const ready=new Promise(resolve=>{release=resolve;});
            const db={execute:async(sql,args)=>{const result=await pool.execute(sql,args);if(sql==='SELECT * FROM users WHERE user_id=?'){
                if(++arrived===2)release();await ready;}return result;}};
            const results=await Promise.all([users.createMissingBySub(uid,profile,2,{connection:db}),users.createMissingBySub(uid,profile,2,{connection:db})]);
            assert.equal(results.filter(result=>result.created).length,1);
            const reader=makeProvisioner();
            await Promise.all([reader.processEvent(provisionEvent(uid)),users.findOrCreateBySub({sub:uid,...profile})]);
            await reader.applyLogin({sub:uid,app_role:2,app_role_epoch:epoch,app_role_revision:'1'});
            const [[count]]=await pool.execute('SELECT COUNT(*) n FROM users WHERE user_id=?',[Buffer.from(uid.replace(/-/g,''),'hex')]);assert.equal(Number(count.n),1);
            assert.equal((await rowFor(uid)).role_id,2);assert.equal((await reader.read(uid)).blocked,0);
        });
        await t.test('current login refreshes an older event seed that wins after its initial lookup misses',async()=>{
            const uid=crypto.randomUUID(),profile=seed(uid),reader=makeProvisioner();
            const local=Buffer.from(uid.replace(/-/g,''),'hex');
            const claims={sub:uid,...profile,name:'Current login name',email:'current-'+uid+'@example.test'};
            let release,arrived;
            const gate=new Promise(resolve=>{release=resolve;}),entered=new Promise(resolve=>{arrived=resolve;});
            const execute=pool.execute;
            pool.execute=async function(sql,args){
                const result=await execute.call(this,sql,args);
                if(sql==='SELECT * FROM users WHERE user_id = ?'&&Buffer.isBuffer(args?.[0])&&args[0].equals(local)){
                    assert.equal(result[0].length,0);arrived();await gate;
                }
                return result;
            };
            const login=users.findOrCreateBySub(claims);
            try{
                await Promise.race([entered,login.then(()=>{throw new Error('login completed before barrier');})]);
                await reader.processEvent(provisionEvent(uid,'1',profile));
                assert.equal((await rowFor(uid)).display_name,profile.name);
                release();const user=await login;
                assert.equal(user.display_name,claims.name);assert.equal(user.email,claims.email);
            }finally{release();pool.execute=execute;await login.catch(()=>{});}
            const row=await rowFor(uid);assert.equal(row.display_name,claims.name);assert.equal(row.email,claims.email);
            await reader.processEvent(provisionEvent(uid,'1',profile));
            assert.equal((await rowFor(uid)).display_name,claims.name);
            const [[count]]=await pool.execute('SELECT COUNT(*) n FROM users WHERE user_id=?',[local]);assert.equal(Number(count.n),1);
        });
        await t.test('login email mirror conflicts retain distinct subjects and still refresh the current name without personal diagnostics',async()=>{
            const old=crypto.randomUUID(),uid=crypto.randomUUID(),reader=makeProvisioner(),occupied=seed(old).email;
            await reader.processEvent(provisionEvent(old));
            await reader.processEvent(provisionEvent(uid,'1',{...seed(uid),email:occupied}));
            const before=await rowFor(old),warnings=[],warn=console.warn;
            console.warn=(...args)=>warnings.push(args);
            try{
                const user=await users.findOrCreateBySub({sub:uid,name:'Current collision name',email:occupied});
                assert.equal(user.display_name,'Current collision name');assert.equal(user.email,null);
            }finally{console.warn=warn;}
            assert.deepEqual(warnings,[['sso_login_profile_email_conflict']]);
            const row=await rowFor(uid);assert.equal(row.display_name,'Current collision name');assert.equal(row.email,null);
            assert.deepEqual(await rowFor(old),before);
        });
    } finally { await pool.end(); await redis.quit(); }
});
