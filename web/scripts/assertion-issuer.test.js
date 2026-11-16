'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),crypto=require('node:crypto'),path=require('node:path');
test('VideoSite private-key assertions bind exact POST operations and preserve legacy audience compatibility',async()=>{
    const jose=await import('jose'),{privateKey,publicKey}=await jose.generateKeyPair('EdDSA',{extractable:true});
    const jwk=await jose.exportJWK(privateKey);jwk.kid='fixture-key';
    const issuer='https://sso.example.invalid',client='videosite',requests=[];
    function load(relative,dependencies,env={}){
        // Only resolve the real lazy jose dependency through injection; issuer
        // logic remains the complete production module. No key/config file reads.
        const source=fs.readFileSync(path.join(__dirname,'..',relative),'utf8').replace("import('jose')","Promise.resolve(require('jose'))");
        const module={exports:{}};vm.runInNewContext('(function(require,module,exports){'+source+'\n})',
            {process:{env},__dirname:'/fixture',URL,URLSearchParams,Date,Buffer,AbortSignal,console:{error(){},warn(){}}})(id=>{assert.ok(Object.hasOwn(dependencies,id),id);return dependencies[id];},module,module.exports);return module.exports;
    }
    const transport={s2sFetch:async(url,init)=>{requests.push({url,init});return Response.json({id_token:'fixture',access_token:'fixture',expires_in:900});}};
    const oidc=load('lib/oidc.js',{crypto,fs:new Proxy({}, {get(){throw Error('unexpected_file_access');}}),path,jose,
        '../services/cache/settingsCache':{getSetting:async()=>null},'../services/s2sFetch':transport,
        '../services/clientSigningKeys':{ClientSigningKeyStore:class{async read(){return{state:{current:jwk},at:Date.now()};}},ClientSigningKeyError:Error},
        '../config/database':{getPool:()=>({})}},
        {DB_HOST:'fixture',DB_NAME:'fixture',SSO_ISSUER:issuer,SSO_INTERNAL:'https://private-sso.example.invalid',OIDC_CLIENT_ID:client,OIDC_REDIRECT_URI:'https://video.example.invalid/auth/callback'});
    async function verify(token,route){const{payload,protectedHeader}=await jose.jwtVerify(token,publicKey,{issuer:client,audience:issuer,algorithms:['EdDSA']});
        assert.equal(payload.sub,client);assert.equal(payload.aud,issuer);assert.equal(payload.method,'POST');assert.equal(payload.path,route);assert.equal(protectedHeader.kid,jwk.kid);
        assert.equal(payload.exp-payload.iat,60);assert.match(payload.jti,/^[a-f0-9-]{36}$/);return payload.jti;}
    await oidc.exchangeCode('fixture-code','fixture-verifier');await verify(requests.pop().init.body.get('client_assertion'),'/token');
    await oidc.fetchInternalAvatar('fixture.webp');await verify(JSON.parse(requests.pop().init.body).client_assertion,'/internal/avatar');
    const activity=load('services/ssoActivity.js',{'./redis':{getClient:()=>({set:async()=> 'OK'})},'./s2sFetch':{s2sFetch:async(url,init)=>{requests.push({url,init});return{status:204};}},
        '../lib/oidc':oidc,'../lib/backgroundTasks':{track:p=>p}});
    await activity.reportActivity('fixture-local',crypto.randomUUID(),Date.now(),'00000000000000000000000000000001');
    await verify(JSON.parse(requests.pop().init.body).client_assertion,'/internal/session-activity');
    const a=await verify(await oidc.signClientAssertion('/token'),'/token'),b=await verify(await oidc.signClientAssertion('/token'),'/token');assert.notEqual(a,b);
    for(const route of [undefined,'','/internal//avatar','/token?other','https://other.invalid/token'])await assert.rejects(oidc.signClientAssertion(route),/invalid_assertion_path/);
});
