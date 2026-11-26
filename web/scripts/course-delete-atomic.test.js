'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const hashA = 'A'.repeat(64), hashB = 'B'.repeat(64);
function fixture(options = {}) {
    const events = [], effects = [], errors = [];
    let state = { exists: options.exists !== false, pending: [] }, staged = null, inserts = 0;
    const videos = options.videos || [
        { video_id: 1, hashed_video_id: hashA, r2_source_key: 'source/Upload000001/source.mp4', status: 'finished' },
        { video_id: 2, hashed_video_id: hashB, r2_source_key: null, status: 'queued' },
    ];
    const jobs = options.jobs || [{ video_id: 2, job_id: 'Job000000001', status: 'leased' }];
    const sessions = options.sessions || [
        { upload_id: 'Upload000002', type: 'attachment', object_key: 'attachments/12/Material0001.pdf' },
        { upload_id: 'Upload000003', type: 'video', object_key: 'source/Upload000003/source.mp4', r2_upload_id: 'multipart-fixture' },
    ];
    const connection = {
        async beginTransaction() { events.push('begin'); staged = structuredClone(state); },
        async execute(sql, args) {
            assert.ok(staged, 'SQL outside transaction');
            if (/^SELECT course_id/.test(sql)) { events.push('course-lock'); assert.match(sql,/FOR UPDATE/); return [staged.exists ? [{ course_id: 12 }] : []]; }
            if (/SELECT video_id, hashed_video_id/.test(sql)) { events.push('video-lock'); assert.match(sql,/FOR UPDATE/); return [videos]; }
            if (/SELECT pq.video_id/.test(sql)) { events.push('job-lock'); assert.match(sql,/FOR UPDATE/); assert.doesNotMatch(sql,/pq\.status\s+IN|pq\.job_id IS NOT NULL/); return [jobs]; }
            if (/SELECT upload_id/.test(sql)) { events.push('upload-lock'); assert.match(sql,/FOR UPDATE/); return [sessions]; }
            if (/INSERT INTO pending_deletes/.test(sql)) {
                events.push('enqueue');
                if (++inserts === options.failInsert) throw Object.assign(new Error('fixture insert failure'),{code:'ER_FIXTURE'});
                staged.pending.push(args[0]); return [{ affectedRows: 1 }];
            }
            if (/DELETE FROM courses/.test(sql)) {
                events.push('delete'); assert.equal(args[0],12);
                if (options.failDelete) throw new Error('fixture delete failure');
                staged.exists = false; return [{ affectedRows: 1 }];
            }
            throw new Error('Unexpected SQL: '+sql);
        },
        async commit() {
            events.push('commit');
            if (options.failCommit === 'before') throw new Error('fixture commit failure');
            state = staged; staged = null;
            if (options.failCommit === 'after') throw new Error('fixture lost commit response');
        },
        async rollback() { events.push('rollback'); staged = null; if (options.failRollback) throw new Error('fixture rollback failure'); },
        release() { events.push('release'); },
        destroy() { events.push('destroy'); },
    };
    const pool = { getConnection: async () => connection, execute() { throw new Error('unbound pool write'); } };
    const effect = name => async (...args) => {
        assert.equal(staged,null, 'remote effect before transaction finished');
        if (!['videos','course','course-list'].includes(name)) assert.equal(state.exists,false, 'destructive effect before course deletion committed');
        effects.push([name,args]); events.push('effect:'+name);
        if ((options.failEffects || []).includes(name)) throw Object.assign(new Error('sensitive fixture message'),{code:'FIXTURE_EFFECT'});
    };
    const enqueue = mode => async (target, opts) => {
        assert.equal(opts.connection,connection, 'cleanup intent did not share the course transaction');
        assert.equal(opts.source,'course_delete');
        await opts.connection.execute('INSERT INTO pending_deletes fixture', [{ mode, target, at: opts.execute_at.getTime(), hash: opts.hashed_video_id || null }]);
    };
    const dependencies = {
        '../config/database': { getPool: () => pool, idBuf: value => value },
        './deletionService': { enqueuePrefix: enqueue('prefix'), enqueueKey: enqueue('key') },
        './cache/videoCache': { invalidateMany: effect('videos') },
        './cache/courseCache': { invalidate: effect('course') },
        './cache/courseListCache': { invalidate: effect('course-list') },
        './cache/watchProgressCache': { clearForVideos: effect('watch') },
        './cache/transcodeProgressCache': { clearJobs: effect('transcode') },
        './cache/uploadHeartbeatCache': { clearHeartbeat: effect('heartbeat') },
        './processingService': { clearStaleTimer: effect('timer') },
        './uploadService': { abortMultipartUpload: effect('abort') },
    };
    const filename = path.join(__dirname,'../services/courseService.js'), module = {exports:{}};
    vm.runInNewContext(fs.readFileSync(filename,'utf8'), {
        module,exports:module.exports,console:{error:(...args)=>errors.push(args)},
        require(name) { if (!Object.hasOwn(dependencies,name)) throw new Error('Unexpected dependency: '+name); return dependencies[name]; },
    }, {filename});
    return { service:module.exports, events,effects,errors, get state(){return state;} };
}

test('course deletion commits every cleanup intent before remote effects, including in-flight buffers', async () => {
    const f=fixture(); await f.service.deleteCourse('00012');
    assert.equal(f.state.exists,false);
    const rows=f.state.pending;
    assert.equal(rows.length,6);
    assert.deepEqual(rows.map(r=>r.target),[
        'source/Upload000001/', hashA+'/',hashB+'/',
        'attachments/12/Material0001.pdf','attachments/12/','posters/12/',
    ]);
    assert.equal(rows.find(r=>r.target===hashA+'/').hash,hashA);
    const at=rows[0].at;
    assert.equal(rows.find(r=>r.target===hashB+'/').at-at,120000,'leased jobs retain the writer buffer even before video status advances');
    assert.equal(rows.find(r=>r.mode==='key').at-at,60000);
    assert.equal(f.events.filter(x=>x==='enqueue').length,6);
    assert.ok(f.events.lastIndexOf('enqueue')<f.events.indexOf('delete'));
    assert.ok(f.events.indexOf('commit')<f.events.findIndex(x=>x.startsWith('effect:')));
    assert.ok(f.events.indexOf('release')<f.events.findIndex(x=>x.startsWith('effect:')));
    assert.equal(f.effects.filter(([name])=>name==='abort').length,1);
});

for (const number of [1,3,6]) test(`failed cleanup insertion ${number} rolls back all intents and preserves course`,async()=>{
    const f=fixture({failInsert:number});
    await assert.rejects(f.service.deleteCourse(12),/fixture insert failure/);
    assert.deepEqual(f.state,{exists:true,pending:[]});
    assert.deepEqual(f.effects,[]);assert.ok(f.events.includes('rollback'));assert.ok(!f.events.includes('delete'));
});

test('course DELETE failure rolls back already inserted cleanup intents',async()=>{
    const f=fixture({failDelete:true});
    await assert.rejects(f.service.deleteCourse(12),/fixture delete failure/);
    assert.deepEqual(f.state,{exists:true,pending:[]});assert.deepEqual(f.effects,[]);
});

test('failed commit keeps course/queue atomic and invalidates only refillable metadata',async()=>{
    const f=fixture({failCommit:'before'});
    await assert.rejects(f.service.deleteCourse(12),/fixture commit failure/);
    assert.deepEqual(f.state,{exists:true,pending:[]});
    assert.deepEqual(f.effects.map(([name])=>name).sort(),['course','course-list','videos']);
});

test('lost commit response clears metadata without aborting writers or discarding buffered state',async()=>{
    const f=fixture({failCommit:'after'});
    await assert.rejects(f.service.deleteCourse(12),/fixture lost commit response/);
    assert.equal(f.state.exists,false);assert.equal(f.state.pending.length,6);
    assert.deepEqual(f.effects.map(([name])=>name).sort(),['course','course-list','videos']);
});

test('failed rollback destroys the connection instead of returning it to the pool',async()=>{
    const f=fixture({failInsert:2,failRollback:true});
    await assert.rejects(f.service.deleteCourse(12),/fixture insert failure/);
    assert.ok(f.events.includes('destroy'));assert.ok(!f.events.includes('release'));assert.deepEqual(f.effects,[]);
});

test('cache and abort failures after commit remain visible but do not discard the plan or fail the committed delete',async()=>{
    const f=fixture({failEffects:['videos','course','abort']});
    await f.service.deleteCourse(12);
    assert.equal(f.state.exists,false);assert.equal(f.state.pending.length,6);
    assert.ok(f.effects.some(([name])=>name==='course-list'));assert.ok(f.effects.some(([name])=>name==='transcode'));
    assert.equal(f.errors.length,3);
    assert.ok(!JSON.stringify(f.errors).includes('sensitive fixture message'));
});

test('already deleted course refreshes course/list metadata without enqueueing a replacement plan',async()=>{
    const f=fixture({exists:false});await f.service.deleteCourse(12);
    assert.deepEqual(f.state,{exists:false,pending:[]});
    assert.deepEqual(f.effects.map(([name])=>name).sort(),['course','course-list']);
    assert.deepEqual(f.events.slice(0,4),['begin','course-lock','commit','release']);
});

for (const key of ['source.mp4','source/source.mp4','source/../source.mp4','other/Upload000001/source.mp4']) {
    test('unsupported source target fails before any cleanup plan or course deletion: '+key,async()=>{
        const f=fixture({videos:[{video_id:1,hashed_video_id:hashA,r2_source_key:key,status:'finished'}]});
        await assert.rejects(f.service.deleteCourse(12),{code:'invalid_cleanup_target'});
        assert.deepEqual(f.state,{exists:true,pending:[]});assert.deepEqual(f.effects,[]);assert.ok(!f.events.includes('enqueue'));
    });
}

test('unknown video hash and cross-course attachment target fail closed before deletes',async()=>{
    for(const options of [
        {videos:[{video_id:1,hashed_video_id:'../',r2_source_key:null,status:'finished'}]},
        {sessions:[{upload_id:'Upload000002',type:'attachment',object_key:'attachments/99/item.pdf'}]},
    ]) {
        const f=fixture(options);await assert.rejects(f.service.deleteCourse(12),{code:'invalid_cleanup_target'});
        assert.deepEqual(f.state,{exists:true,pending:[]});assert.deepEqual(f.effects,[]);
    }
});

test('duplicate source references produce one narrow source sweep',async()=>{
    const f=fixture({videos:[
        {video_id:1,hashed_video_id:hashA,r2_source_key:'source/Upload000001/source.mp4',status:'finished'},
        {video_id:2,hashed_video_id:hashB,r2_source_key:'source/Upload000001/source.mp4',status:'finished'},
    ],jobs:[],sessions:[]});
    await f.service.deleteCourse(12);
    assert.equal(f.state.pending.filter(r=>r.target==='source/Upload000001/').length,1);
    assert.equal(f.state.pending.length,5);
});


test('metadata cache failures after uncertain commit do not mask the original commit error',async()=>{
    const f=fixture({failCommit:'after',failEffects:['videos','course','course-list']});
    await assert.rejects(f.service.deleteCourse(12),/fixture lost commit response/);
    assert.equal(f.errors.length,3);
    assert.deepEqual(f.effects.map(([name])=>name).sort(),['course','course-list','videos']);
});

test('all processing rows are locked but only active jobs with IDs trigger writer cleanup and buffers',async()=>{
    const f=fixture({jobs:[
        {video_id:1,job_id:null,status:'queued'},
        {video_id:1,job_id:'OldCompleted',status:'completed'},
        {video_id:1,job_id:'PendingJob01',status:'pending'},
        {video_id:1,job_id:null,status:'leased'},
        {video_id:2,job_id:'Job000000002',status:'leased'},
    ],sessions:[]});
    await f.service.deleteCourse(12);
    const a=f.state.pending.find(r=>r.target===hashA+'/'),b=f.state.pending.find(r=>r.target===hashB+'/');
    assert.equal(b.at-a.at,120000);
    assert.deepEqual(f.effects.filter(([name])=>name==='timer').map(([,args])=>args[0]),['Job000000002']);
    assert.deepEqual(Array.from(f.effects.find(([name])=>name==='transcode')[1][0]),['Job000000002']);
});
