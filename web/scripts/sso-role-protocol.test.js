'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const p = require('../lib/ssoRoleProtocol');
const { readCatalog } = require('../services/ssoCatalogStore');
const epoch = '11111111-1111-4111-8111-111111111111';
const sub = '22222222-2222-4222-8222-222222222222';
const incoming = (role, rev = '7', e = epoch) => p.observation({ sub, role_id: role, authority_epoch: e, authority_revision: rev });
test('profile seeds enforce complete scope groups and subject-owned avatar names', () => {
    const profile = { preferred_username:'student', name:'Student', picture:sub+'-0123456789abcdef.webp', email:'student@example.test', email_verified:true };
    const event = { sub, role_id:2, account_status:'active', authority_epoch:epoch, authority_revision:'1', profile };
    assert.deepEqual(p.observation(event).profile, profile);
    assert.equal(p.observation({...event,profile:{...profile,name:'🙂'.repeat(100)}}).profile.name,'🙂'.repeat(100));
    assert.deepEqual(p.profileSeed({},sub),{});
    assert.deepEqual(p.profileSeed({email:null,email_verified:false},sub),{email:null,email_verified:false});
    for (const value of [null, [], 'profile', {name:'Student'}, {...profile,preferred_username:'x'.repeat(21)},
        {...profile,name:'x'.repeat(101)}, {...profile,picture:epoch+'-0123456789abcdef.webp'},
        {...profile,email:'x'.repeat(255)}, {...profile,email_verified:1}, {...profile,extra:'secret'},
        {...profile,name:'🙂'.repeat(101)}, {...profile,name:'  '}, {...profile,name:'a\u0000b'},
        {...profile,name:'a\u007fb'}, {...profile,name:'a\ud800b'}]) {
        assert.throws(() => p.observation({...event,profile:value}), /invalid_profile_seed/);
    }
    for (const patch of [{role_id:null},{account_status:'disabled'},{account_status:undefined},
        {authority_epoch:undefined,authority_revision:undefined}]) assert.throws(() => p.observation({...event,...patch}), /invalid_profile_seed/);
    assert.throws(() => p.observation(event,'login'), /invalid_profile_seed/);
});
test('null and role zero remain distinct; coercible values are invalid', () => {
    assert.equal(p.roleId(null), null); assert.equal(p.roleId(0), 0);
    for (const value of [undefined, false, '', '0', [], {}, NaN, 2147483648, -2147483649]) assert.throws(() => p.roleId(value));
});
test('decimal versions preserve all signed-bigint bits', () => {
    assert.equal(p.revision('9223372036854775807'), '9223372036854775807');
    for (const value of ['01','-1','1.0','9223372036854775808',1,null,'']) assert.throws(() => p.revision(value));
    assert.throws(() => p.revision('0', true));
    assert.equal(p.version(undefined, undefined), null);
    assert.throws(() => p.version(epoch, undefined));
});
test('subject watermarks reject stale snapshots, conflicts, foreign epochs, and legacy downgrades', () => {
    const stored = { authority_epoch: epoch, authority_revision: '7', role_id: 0 };
    assert.equal(p.compare(stored, incoming(0)), 'same');
    assert.equal(p.compare(stored, incoming(null)), 'conflict');
    assert.equal(p.compare(stored, incoming(null, '6')), 'stale');
    assert.equal(p.compare(stored, incoming(null, '8')), 'apply');
    assert.equal(p.compare(stored, incoming(0, '8', '33333333-3333-4333-8333-333333333333')), 'epoch');
    assert.equal(p.compare(stored, p.observation({ sub, role_id: 0 })), 'legacy');
    assert.equal(p.compare(null, incoming(0, '6')), 'apply');
});
test('ordering stays exact above JavaScript safe integer range', () => {
    assert.equal(p.compare({ authority_epoch: epoch, authority_revision: '9007199254740993', role_id: 0 }, incoming(null, '9007199254740992')), 'stale');
});
test('a restored subject never accepts a cached session from before a denial', () => {
    const state={blocked:0,effects_pending:0,session_generation:'2'};
    assert.equal(p.sessionPermitted(state,'1'),false);assert.equal(p.sessionPermitted(state,'2'),true);
    assert.equal(p.sessionPermitted({...state,effects_pending:1},'2'),false);
    assert.equal(p.sessionPermitted({...state,blocked:1},'2'),false);
    assert.equal(p.sessionPermitted(null,'0'),true);
});
test('complete inbox digest includes authority revision; object key order does not matter', () => {
    assert.equal(p.digest({ a: 1, b: null }), p.digest({ b: null, a: 1 }));
    assert.notEqual(p.digest({ role_id: 0, authority_revision: '7' }), p.digest({ role_id: 0, authority_revision: '8' }));
    let deep = {}; for (let i = 0; i < 30; i++) deep = { child: deep };
    assert.throws(() => p.digest(deep));
});
test('catalog reads use database values and preserve default zero or explicit no access', async () => {
    const rows = [{ role_id: 0, role_name: ' Root ', permission_level: 0, is_system: 1 }];
    for (const [raw, expected] of [['0',0],['null',null],['false',null],['99',null]]) {
        const db = { execute: async sql => sql.includes('FROM roles') ? [rows] : [[{ setting_key: 'registration_default_role', setting_value: raw }]] };
        const result = await readCatalog(db); assert.equal(result.default_role, expected); assert.equal(result.roles[0].role_id, 0);
    }
});
test('catalog display names truncate by Unicode code points without splitting astral characters',async()=>{
    const roleName='🙂'.repeat(100)+'X',siteName='a'.repeat(99)+'🙂'+'Z';
    const db={execute:async sql=>sql.includes('FROM roles')
        ? [[{role_id:0,role_name:roleName,permission_level:0,is_system:1}]]
        : [[{setting_key:'site_name',setting_value:siteName},{setting_key:'registration_default_role',setting_value:'0'}]]};
    const payload=await readCatalog(db);
    assert.equal(payload.roles[0].name,'🙂'.repeat(100));assert.equal(Array.from(payload.roles[0].name).length,100);
    assert.equal(payload.site_name,'a'.repeat(99)+'🙂');assert.equal(Array.from(payload.site_name).length,100);
    assert.equal(payload.site_name.isWellFormed(),true);assert.equal(payload.roles[0].name.isWellFormed(),true);
});
test('invalid local display names cannot become permanently rejected immutable jobs',async()=>{
    for(const value of ['bad\0name','bad\ud83dname','bad\udc00name']){
        const db={execute:async sql=>sql.includes('FROM roles')
            ? [[{role_id:0,role_name:value,permission_level:0,is_system:1}]] : [[]]};
        await assert.rejects(readCatalog(db),/invalid_catalog_name/);
        const siteDb={execute:async sql=>sql.includes('FROM roles')
            ? [[{role_id:0,role_name:'Root',permission_level:0,is_system:1}]] : [[{setting_key:'site_name',setting_value:value}]]};
        await assert.rejects(readCatalog(siteDb),/invalid_catalog_name/);
    }
});
test('signed status contradictions conflict only at the same source version; legacy pulls can update status',()=>{
    const stored={authority_epoch:epoch,authority_revision:'7',role_id:0,account_status:'active'};
    const disabled=p.observation({sub,role_id:0,authority_epoch:epoch,authority_revision:'7',account_status:'disabled'});
    assert.equal(p.compare(stored,disabled),'conflict');
    assert.equal(p.compare(stored,{...disabled,source:'pull'}),'same');
    assert.equal(p.compare(stored,{...disabled,version:{epoch,revision:'6'}}),'stale');
    assert.equal(p.compare(stored,{...disabled,version:{epoch,revision:'8'}}),'apply');
    assert.equal(p.compare(stored,incoming(0)),'same','legacy omission is not an active assertion');
    assert.equal(p.compare({...stored,account_status:null},disabled),'same');
    for(const account_status of [null,false,'unknown',1])assert.throws(()=>p.observation({sub,role_id:0,account_status}),/invalid_account_status/);
});
