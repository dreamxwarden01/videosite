import {randomBytes,randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
const exec=promisify(execFile),context=process.env.VS_TEST_DOCKER_CONTEXT||'orbstack',suffix=randomUUID().replaceAll('-',''),database='vs_sso_test_'+suffix;
const names={db:'vs-role-db-'+suffix,redis:'vs-role-redis-'+suffix},created=[];
const directory=await mkdtemp(join(tmpdir(),'vs-role-fixture-')),password=randomBytes(24).toString('hex');
const docker=(...args)=>exec('docker',['--context',context,...args],{maxBuffer:512*1024});
try {
 const envFile=join(directory,'mariadb.env');
 await writeFile(envFile,`MARIADB_ROOT_PASSWORD=${randomBytes(24).toString('hex')}\nMARIADB_DATABASE=${database}\nMARIADB_USER=role_fixture\nMARIADB_PASSWORD=${password}\n`,{mode:0o600});
 console.log('Starting disposable MariaDB and Redis fixtures.');
 await docker('run','--detach','--name',names.db,'--label','videosite.scope=role-sync-local-test','--cpus','1','--memory','512m','--env-file',envFile,'--publish','127.0.0.1::3306','--tmpfs','/var/lib/mysql:rw,size=512m','mariadb:11','--innodb-buffer-pool-size=64M','--innodb-log-file-size=32M','--max-connections=30','--performance-schema=OFF');created.push(names.db);
 await docker('run','--detach','--name',names.redis,'--label','videosite.scope=role-sync-local-test','--cpus','0.5','--memory','128m','--publish','127.0.0.1::6379','redis:7-alpine','redis-server','--save','','--appendonly','no','--maxmemory','32mb','--maxmemory-policy','noeviction');created.push(names.redis);
 let ready=false;
 for(let n=0;n<100;n++) {try {await docker('exec',names.db,'healthcheck.sh','--connect','--innodb_initialized');await docker('exec',names.redis,'redis-cli','ping');ready=true;break;}catch {await new Promise(resolve=>setTimeout(resolve,250));}}
 if(!ready)throw Error('Generated database fixture did not become ready.');
 const ports={};for(const [kind,port] of [['db','3306/tcp'],['redis','6379/tcp']]){const {stdout}=await docker('port',names[kind],port);const m=/^127\.0\.0\.1:(\d+)\s*$/.exec(stdout);if(!m)throw Error('Unexpected fixture binding.');ports[kind]=m[1];}
 const env={...process.env,FORCE_COLOR:'0',DOTENV_CONFIG_PATH:'/dev/null',VS_SSO_ISOLATED_TEST:'1',VS_TEST_DB_URI:`mysql://role_fixture:${password}@127.0.0.1:${ports.db}/${database}`,VS_TEST_REDIS_URI:`redis://127.0.0.1:${ports.redis}`};
 const result=await exec(process.execPath,['--test','--test-reporter=spec','--test-concurrency=1','scripts/sso-role-protocol.test.js','scripts/sso-role-http.test.js','scripts/sso-role-isolated.test.js'],{cwd:dirname(dirname(fileURLToPath(import.meta.url))),env,maxBuffer:8*1024*1024});
 process.stdout.write(result.stdout);process.stderr.write(result.stderr);
 if(!/^ℹ skipped 0\s*$/m.test(result.stdout))throw Error('Expected the complete suite with no skipped tests.');
} catch(error) {
 console.error('Isolated VideoSite role tests failed.');
 if(error.stdout)process.stdout.write(error.stdout);if(error.stderr)process.stderr.write(error.stderr);process.exitCode=1;
} finally {
 for(const name of created.reverse()) {try {await docker('rm','--force',name);console.log('Owned fixture removed: '+name);}catch {console.error('Owned fixture cleanup failed: '+name);process.exitCode=1;}}
 await rm(directory,{recursive:true,force:true});
}
