'use strict';
// Only the explicitly supplied disposable local MariaDB fixture is used.
// Never load .env or fall back to application connection settings.
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const enabled=process.env.VS_DELETION_ISOLATED_TEST==='1';
const hashA='A'.repeat(64),hashB='B'.repeat(64);
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));

test('course deletion atomically commits native MariaDB cleanup intents and fences new children',{skip:!enabled},async t=>{
    const url=new URL(process.env.VS_TEST_DB_URI||'invalid:');
    if(url.protocol!=='mysql:'||url.hostname!=='127.0.0.1'||!/^\/vs_(?:sso|delete)_test_[a-z0-9_]+$/.test(url.pathname))throw Error('disposable_fixture_required');
    const mysql=require('mysql2/promise');
    const pool=mysql.createPool({host:url.hostname,port:Number(url.port||3306),user:decodeURIComponent(url.username),password:decodeURIComponent(url.password),database:url.pathname.slice(1),connectionLimit:8});
    const dbModule=require('../config/database');const previousGetPool=dbModule.getPool;dbModule.getPool=()=>pool;
    delete require.cache[require.resolve('../services/deletionService')];
    const deletion=require('../services/deletionService');
    const source=fs.readFileSync(path.join(__dirname,'../services/courseService.js'),'utf8');
    const seed=async()=>{
        await pool.execute('DELETE FROM courses');await pool.execute('DELETE FROM pending_deletes');
        await pool.execute('INSERT INTO courses(course_id) VALUES(12)');
        await pool.execute('INSERT INTO videos VALUES(1,12,?,?,?)',[hashA,'source/Upload000001/source.mp4','finished']);
        await pool.execute('INSERT INTO videos VALUES(2,12,?,?,?)',[hashB,null,'queued']);
        await pool.execute("INSERT INTO processing_queue(video_id,job_id,status) VALUES(2,'Job000000001','leased')");
        await pool.execute("INSERT INTO upload_sessions VALUES('Upload000002',12,'attachment','attachments/12/Material0001.pdf',NULL,'active')");
    };
    function service(options={}) {
        const errors=[],effects=[];let inserts=0;
        const wrappedPool={getConnection:async()=>{
            const real=await pool.getConnection();
            return new Proxy(real,{get(target,key){
                if(key==='execute')return async(sql,args)=>{
                    if(/INSERT INTO pending_deletes/.test(sql)&&++inserts===options.failInsert)throw Error('synthetic_insert_failure');
                    if(/^DELETE FROM courses/.test(sql)&&options.failDelete)throw Error('synthetic_delete_failure');
                    const result=await target.execute(sql,args);
                    if(/^SELECT course_id/.test(sql))await options.afterParentLock?.();
                    if(/FROM videos WHERE course_id/.test(sql))await options.afterVideoLock?.();
                    if(/SELECT pq.video_id/.test(sql))await options.afterJobLock?.();
                    if(/^DELETE FROM courses/.test(sql))await options.beforeCommit?.();
                    return result;
                };
                if(key==='commit'&&options.lostCommitReply)return async()=>{await target.commit();throw Error('synthetic_lost_commit_reply');};
                const value=target[key];return typeof value==='function'?value.bind(target):value;
            }});
        }};
        const effect=name=>async()=>{
            const [[row]]=await pool.execute('SELECT COUNT(*) AS n FROM courses WHERE course_id=12');
            if(!['videos','course','course-list'].includes(name))assert.equal(row.n,0,'destructive effect preceded commit');effects.push(name);
            if(options.cacheFailure&&name==='videos')throw Error('synthetic_cache_failure');
        };
        const deps={
            '../config/database':{getPool:()=>wrappedPool,idBuf:x=>x},'./deletionService':deletion,
            './cache/videoCache':{invalidateMany:effect('videos')},'./cache/courseCache':{invalidate:effect('course')},
            './cache/courseListCache':{invalidate:effect('course-list')},'./cache/watchProgressCache':{clearForVideos:effect('watch')},
            './cache/transcodeProgressCache':{clearJobs:effect('transcode')},'./cache/uploadHeartbeatCache':{clearHeartbeat:effect('heartbeat')},
            './processingService':{clearStaleTimer:effect('timer')},'./uploadService':{abortMultipartUpload:effect('abort')},
        };
        const module={exports:{}};
        // Share Date identity: real enqueue helpers intentionally validate Date inputs.
        vm.runInNewContext(source,{module,exports:module.exports,Date,console:{error:(...args)=>errors.push(args)},require(name){assert.ok(Object.hasOwn(deps,name),'unexpected dependency '+name);return deps[name];}},{filename:'courseService.js'});
        return {deleteCourse:module.exports.deleteCourse,errors,effects};
    }
    const counts=async()=>{
        const [[row]]=await pool.query('SELECT (SELECT COUNT(*) FROM courses) AS courses,(SELECT COUNT(*) FROM videos) AS videos,(SELECT COUNT(*) FROM pending_deletes) AS pending');return row;
    };
    try {
        await pool.execute('CREATE TABLE courses(course_id INT UNSIGNED PRIMARY KEY) ENGINE=InnoDB');
        await pool.execute(`CREATE TABLE videos(video_id INT UNSIGNED PRIMARY KEY,course_id INT UNSIGNED NOT NULL,hashed_video_id VARCHAR(64) NOT NULL,r2_source_key VARCHAR(500),status VARCHAR(32),KEY(course_id),FOREIGN KEY(course_id) REFERENCES courses(course_id) ON DELETE CASCADE) ENGINE=InnoDB`);
        await pool.execute(`CREATE TABLE processing_queue(task_id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,video_id INT UNSIGNED NOT NULL,job_id VARCHAR(64),status VARCHAR(32),FOREIGN KEY(video_id) REFERENCES videos(video_id) ON DELETE CASCADE) ENGINE=InnoDB`);
        await pool.execute(`CREATE TABLE upload_sessions(upload_id VARCHAR(12) PRIMARY KEY,course_id INT UNSIGNED NOT NULL,type VARCHAR(16),object_key VARCHAR(500),r2_upload_id VARCHAR(1024),status VARCHAR(16),KEY(course_id),FOREIGN KEY(course_id) REFERENCES courses(course_id) ON DELETE CASCADE) ENGINE=InnoDB`);
        const schema=fs.readFileSync(path.join(__dirname,'../db/schema.sql'),'utf8');
        const start=schema.indexOf('CREATE TABLE IF NOT EXISTS `pending_deletes`');
        const end=schema.indexOf('CREATE TABLE IF NOT EXISTS `processing_queue`',start);
        assert.ok(start>=0&&end>start);await pool.query(schema.slice(start,end));

        await t.test('partial native queue inserts roll back and preserve the complete course',async()=>{
            await seed();const api=service({failInsert:3});
            await assert.rejects(api.deleteCourse(12),/synthetic_insert_failure/);
            assert.deepEqual(await counts(),{courses:1,videos:2,pending:0});assert.equal(api.effects.length,0);
        });
        await t.test('DELETE failure rolls back the already-written cleanup plan',async()=>{
            await seed();const api=service({failDelete:true});
            await assert.rejects(api.deleteCourse(12),/synthetic_delete_failure/);
            assert.deepEqual(await counts(),{courses:1,videos:2,pending:0});assert.equal(api.effects.length,0);
        });
        await t.test('queue consumers see either course-before or complete deletion plan-after commit',async()=>{
            await seed();const entered=deferred(),release=deferred();
            const api=service({beforeCommit:async()=>{entered.resolve();await release.promise;}});
            const pending=api.deleteCourse(12);await entered.promise;
            try {assert.deepEqual(await counts(),{courses:1,videos:2,pending:0});}
            finally {release.resolve();}
            await pending;assert.deepEqual(await counts(),{courses:0,videos:0,pending:6});
            const [rows]=await pool.query('SELECT mode,target,hashed_video_id,TIMESTAMPDIFF(SECOND,(SELECT MIN(execute_at) FROM pending_deletes),execute_at) AS delay FROM pending_deletes');
            assert.equal(rows.find(r=>r.target===hashB+'/').delay,120);
            assert.equal(rows.find(r=>r.mode==='key').delay,60);
            assert.equal(rows.find(r=>r.target===hashA+'/').hashed_video_id,hashA);
        });
        await t.test('parent lock blocks a concurrent FK child insert, which then fails after deletion',async()=>{
            await seed();const entered=deferred(),release=deferred();
            const api=service({afterParentLock:async()=>{entered.resolve();await release.promise;}});
            const removing=api.deleteCourse(12);await entered.promise;
            const writer=await pool.getConnection();let settled=false;
            try {
                await writer.execute('SET SESSION innodb_lock_wait_timeout=5');
                const inserting=writer.execute('INSERT INTO videos VALUES(3,12,?,?,?)',['C'.repeat(64),null,'queued']).then(()=>{settled=true;return null;},e=>{settled=true;return e;});
                await delay(70);assert.equal(settled,false,'child insert did not wait for parent lock');
                release.resolve();await removing;
                const error=await inserting;assert.equal(error?.code,'ER_NO_REFERENCED_ROW_2');
                assert.deepEqual(await counts(),{courses:0,videos:0,pending:6});
            } finally {release.resolve();writer.release();}
        });
        await t.test('locked child snapshot prevents an unplanned source replacement during deletion',async()=>{
            await seed();const entered=deferred(),release=deferred();
            const api=service({afterVideoLock:async()=>{entered.resolve();await release.promise;}});
            const removing=api.deleteCourse(12);await entered.promise;
            const writer=await pool.getConnection();let settled=false;
            try {
                await writer.execute('SET SESSION innodb_lock_wait_timeout=5');
                const update=writer.execute('UPDATE videos SET r2_source_key=? WHERE video_id=1',['source/Upload000099/source.mp4']).then(x=>{settled=true;return x;});
                await delay(70);assert.equal(settled,false);
                release.resolve();await removing;const [result]=await update;assert.equal(result.affectedRows,0);
                const [targets]=await pool.query("SELECT target FROM pending_deletes WHERE target LIKE 'source/%'");
                assert.deepEqual(targets,[{target:'source/Upload000001/'}]);
            } finally {release.resolve();writer.release();}
        });
        await t.test('queued processing rows cannot become leased after the cleanup snapshot',async()=>{
            await seed();await pool.execute("INSERT INTO processing_queue(video_id,job_id,status) VALUES(1,NULL,'queued')");
            const entered=deferred(),release=deferred();
            const api=service({afterJobLock:async()=>{entered.resolve();await release.promise;}});
            const removing=api.deleteCourse(12);await entered.promise;
            const writer=await pool.getConnection();let settled=false;
            try {
                await writer.execute('SET SESSION innodb_lock_wait_timeout=5');
                const leasing=writer.execute("UPDATE processing_queue SET status='leased',job_id='NewLease0001' WHERE video_id=1 AND status='queued'").then(x=>{settled=true;return x;});
                await delay(70);assert.equal(settled,false,'queued row was not included in the locking read');
                release.resolve();await removing;const [result]=await leasing;assert.equal(result.affectedRows,0);
                assert.deepEqual(await counts(),{courses:0,videos:0,pending:6});
                const [rows]=await pool.query('SELECT target,TIMESTAMPDIFF(SECOND,(SELECT MIN(execute_at) FROM pending_deletes),execute_at) AS delay FROM pending_deletes');
                assert.equal(rows.find(r=>r.target===hashA+'/').delay,0);
                assert.equal(rows.find(r=>r.target===hashB+'/').delay,120);
            } finally {release.resolve();writer.release();}
        });
        await t.test('enqueue Date deadlines use the SQL connection timezone without host-local conversion',async()=>{
            await seed();const connection=await pool.getConnection();
            try {
                await connection.query("SET SESSION time_zone='+05:30'");await connection.beginTransaction();
                await deletion.enqueuePrefix('posters/999/',{connection,execute_at:new Date(Date.now()+120000),source:'test'});
                await deletion.enqueueKey('attachments/999/example.pdf',{connection,execute_at:new Date(Date.now()+60000),source:'test'});
                const [rows]=await connection.query('SELECT mode,TIMESTAMPDIFF(SECOND,NOW(),execute_at) AS seconds FROM pending_deletes ORDER BY mode');
                assert.equal(rows.length,2);
                for(const row of rows) {
                    const expected=row.mode==='key'?60:120;
                    assert.ok(row.seconds>=expected-2&&row.seconds<=expected+1,'deadline incorrectly shifted by timezone: '+row.seconds);
                }
                await connection.rollback();
            } finally {await connection.query('SET SESSION time_zone=@@global.time_zone');connection.release();}
        });
        await t.test('cache failure after native commit cannot lose the cleanup plan or turn deletion into a retry',async()=>{
            await seed();const api=service({cacheFailure:true});await api.deleteCourse(12);
            assert.deepEqual(await counts(),{courses:0,videos:0,pending:6});assert.equal(api.errors.length,1);
            await api.deleteCourse(12);assert.deepEqual(await counts(),{courses:0,videos:0,pending:6});
        });
        await t.test('lost commit response leaves an atomic result and clears only refillable metadata',async()=>{
            await seed();const api=service({lostCommitReply:true});
            await assert.rejects(api.deleteCourse(12),/synthetic_lost_commit_reply/);
            assert.deepEqual(await counts(),{courses:0,videos:0,pending:6});
            assert.deepEqual(api.effects.sort(),['course','course-list','videos']);
            const retry=service();await retry.deleteCourse(12);assert.deepEqual(retry.effects.sort(),['course','course-list']);assert.equal((await counts()).pending,6);
        });
    } finally {dbModule.getPool=previousGetPool;await pool.end();}
});
