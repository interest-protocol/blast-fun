// Real production Next.js HTTP path; all credentials and destinations belong to this disposable run.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash, randomBytes, sign } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { Agent, fetch } from 'undici';

async function pageGate(port, dispatcher) {
  const deadline = Date.now()+120000;
  let lastError;
  while (Date.now()<deadline) {
    try {
      const res=await fetch(`http://127.0.0.1:${port}/privacy`, { dispatcher, signal: AbortSignal.timeout(5000) });
      await res.arrayBuffer();
      assert(res.ok, `privacy returned ${res.status}`);
      const cookie=res.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ');
      assert(cookie.includes('blast_gate='));
      return cookie;
    } catch(error) {lastError=error;}
    await sleep(500);
  }
  throw new Error(`Next instance on ${port} failed to start`, {cause:lastError});
}

export async function startWalletHttp(admin, databaseUrl) {
  const dir = process.env.WALLET_SCALE_HTTP_DIR;
  assert(dir && path.isAbsolute(dir));
  const url = new URL(databaseUrl);
  assert.equal(url.hostname, '127.0.0.1');
  assert.match(url.pathname, /^\/blast_test_\d+_\d+_\d+$/);
  const root = process.cwd();
  assert(fs.existsSync(`${root}/apps/web/.next/BUILD_ID`), 'Build production Next.js before starting the test');
  const env = JSON.parse(fs.readFileSync(`${dir}/app-env.json`, 'utf8'));
  assert.equal(env.NODE_ENV, 'production');
  assert.equal(env.LOADTEST_EGRESS_MODE, 'block');
  assert(!env.LOADTEST_EGRESS_ALLOW);
  assert.equal(env.NEXT_PUBLIC_SITE_URL, 'http://127.0.0.1:39170');
  const key = fs.readFileSync(`${dir}/signing.pem`);
  const children = [];
  const dispatcher = new Agent({ connections: 32, pipelining: 1 });
  const count = 8;
  const cookies = [];
  const tokens = [];
  const sessions = [];
  function jwt(n, expiration = Math.floor(Date.now() / 1000) + 7200) {
    const data = [ { alg: 'ES256', typ: 'JWT' }, { iss: 'privy.io', aud: env.PRIVY_APP_ID, sub: `did:privy:load-${n}`, sid: `load-${n}`, iat: Math.floor(Date.now()/1000)-60, exp: expiration } ].map(x => Buffer.from(JSON.stringify(x)).toString('base64url')).join('.');
    return `${data}.${sign('sha256', Buffer.from(data), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
  }
  function launch(name, command, args, childEnv = env) {
    const fd = fs.openSync(`${dir}/${name}.log`, 'w');
    const child = spawn(command, args, { cwd: `${root}/apps/web`, env: childEnv, stdio: ['ignore', fd, fd] });
    fs.closeSync(fd);
    children.push(child);
    child.on('error', error => console.error(name, error));
    return child;
  }
  async function close() {
    await dispatcher.close();
    for (const child of children.reverse()) {
      if (child.exitCode !== null) continue;
      child.kill('SIGTERM');
      await Promise.race([new Promise(resolve => child.once('exit', resolve)), sleep(5000)]);
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  }
  try {
    fs.writeFileSync(`${dir}/runtime-egress.jsonl`, '');
    env.LOADTEST_EGRESS_LOG = `${dir}/runtime-egress.jsonl`;
    env.NODE_COMPILE_CACHE = `${dir}/node-cache`;
    await admin.query("ALTER ROLE blast_web LOGIN; ALTER ROLE blast_web SET statement_timeout='8s'; ALTER ROLE blast_web SET lock_timeout='3s'");
    fs.writeFileSync(`${dir}/users.txt`, '"blast_web" ""\n', { mode: 0o600 });
    fs.writeFileSync(`${dir}/pgbouncer.ini`, `[databases]\n${url.pathname.slice(1)} = host=127.0.0.1 port=${url.port} dbname=${url.pathname.slice(1)}\n[pgbouncer]\nlisten_addr=127.0.0.1\nlisten_port=55440\nauth_type=trust\nauth_file=${dir}/users.txt\npool_mode=transaction\ndefault_pool_size=24\nmax_client_conn=200\nmax_prepared_statements=100\nignore_startup_parameters=extra_float_digits\nlog_connections=0\nlog_disconnections=0\n`, { mode: 0o600 });
    launch('pgbouncer', '/usr/sbin/pgbouncer', [`${dir}/pgbouncer.ini`]);
    launch('latency', process.execPath, [`${root}/apps/web/loadtest/lib/latency-proxy.mjs`, '--listen', '55441', '--target', '127.0.0.1:55440', '--rtt-ms', '10']);
    // Two verified wallets per private account. Distinct balances detect cross-account responses even when coin sets repeat.
    await admin.query(`UPDATE blast_infra.wallet_balances SET balance=1000000000+('x'||right(owner,8))::bit(32)::bigint WHERE ('x'||right(owner,8))::bit(32)::int<=98000 AND coin_type LIKE '0x'||lpad(to_hex((('x'||right(owner,8))::bit(32)::int*5)%10000+1),64,'0')||'::%'`);
    for (let start = 1; start <= 50000; start += 1000) {
      const hashes = [], addresses = [];
      for (let n = start; n < start+1000; n++) {
        tokens[n] = jwt(n);
        sessions[n] = randomBytes(32).toString('base64url');
        hashes.push(createHash('sha256').update(sessions[n]).digest('hex'));
        addresses.push('0x'+(n*2-1).toString(16).padStart(64,'0'));
      }
      await admin.query(`INSERT INTO social_wallet_sessions(session_id,token_hash,wallet_address,challenge_id,created_at,expires_at,last_used_at) SELECT gen_random_uuid(), h, a, gen_random_uuid(), now()-interval '15 minutes', now()+interval '1 day', now() FROM unnest($1::text[],$2::text[]) t(h,a)`, [hashes,addresses]);
    }
    await admin.query('ANALYZE social_wallet_sessions; ANALYZE blast_infra.wallet_balances');
    const appUrl = new URL(url); appUrl.port = '55441'; appUrl.username = 'blast_web';
    for (let i=0;i<count;i++) launch(`app-${i}`, process.execPath, [`${root}/node_modules/next/dist/bin/next`, 'start', '--hostname', '127.0.0.1', '--port', String(39170+i)], { ...env, DATABASE_URL: appUrl.href, DATABASE_POOL_MAX:"20" });
    for (let i=0;i<count;i++) cookies[i] = await pageGate(39170+i,dispatcher);
    async function request(n, overrides={}, instance=n%count) {
      const headers = { cookie: cookies[instance], origin: env.NEXT_PUBLIC_SITE_URL, 'sec-fetch-site':'same-origin', 'x-forwarded-for':`10.1.${Math.floor(n/256)}.${n%256}` };
      if(n%2) headers.authorization=`Bearer ${tokens[n]}`;
      else headers.cookie+=`; __Host-blast_wallet=${sessions[n]}`;
      Object.assign(headers, overrides);
      const response=await fetch(`http://127.0.0.1:${39170+instance}/api/social/me/portfolio`, { dispatcher, headers, signal:AbortSignal.timeout(10000) });
      const body=await response.json();
      return { response, body };
    }
    async function read(n, instance) {
      const {response,body}=await request(n,{},instance);
      assert.equal(response.status,200,JSON.stringify(body));
      assert.match(response.headers.get('cache-control')??'', /private/);
      assert.match(response.headers.get('cache-control')??'', /no-store/);
      assert(response.headers.get('x-request-id'));
      return body;
    }
    for (const [name,n,headers,status] of [
      ['missing gate',1,{cookie:''},401],
      ['missing auth',1,{authorization:''},401],
      ['invalid signature',1,{authorization:`Bearer ${tokens[1].slice(0,-8)}AAAAAAAA`},401],
      ['expired JWT',1,{authorization:`Bearer ${jwt(1,1)}`},401],
      ['cross origin',2,{origin:'https://attacker.invalid'},403],
      ['unknown session',2,{cookie:`${cookies[2]}; __Host-blast_wallet=${randomBytes(32).toString('base64url')}`},401],
    ]) {
      // react-doctor-disable-next-line react-doctor/async-await-in-loop -- Keep negative authentication cases serial so this preflight does not introduce its own burst load.
      const result=await request(n,headers);
      assert.equal(result.response.status,status,`${name}: ${JSON.stringify(result.body)}`);
    }
    const sessionHash=createHash('sha256').update(sessions[2]).digest('hex');
    await admin.query("UPDATE social_wallet_sessions SET revoked_at=now() WHERE token_hash=$1",[sessionHash]);
    // react-doctor-disable-next-line react-doctor/async-await-in-loop -- Check revocation on every instance before restoring this shared session.
    for(let i=0;i<count;i++) assert.equal((await request(2,{},i)).response.status,401,'revocation must hold across instances');
    await admin.query("UPDATE social_wallet_sessions SET revoked_at=NULL WHERE token_hash=$1",[sessionHash]);
    await admin.query("UPDATE social_wallet_sessions SET expires_at=created_at+interval '5 minutes' WHERE token_hash=$1",[sessionHash]);
    // react-doctor-disable-next-line react-doctor/async-await-in-loop -- Check expiry on every instance before restoring this shared session.
    for(let i=0;i<count;i++) assert.equal((await request(2,{},i)).response.status,401,'expired session must fail across instances');
    await admin.query("UPDATE social_wallet_sessions SET expires_at=now()+interval '1 day' WHERE token_hash=$1",[sessionHash]);
    // react-doctor-disable-next-line react-doctor/async-await-in-loop -- Warm each instance one request at a time before measuring shared rate limits.
    for(let i=0;i<count;i++) { await read(1,i); await read(2,i); }
    // Stay inside one fixed rate-limit window; exercise the shared policy across all processes.
    if (Date.now()%60000 > 45000) await sleep(60010-Date.now()%60000);
    await Promise.all(Array.from({length:24},async (_,shard)=>{
      // react-doctor-disable-next-line react-doctor/async-await-in-loop -- Each of the 24 bounded clients sends one request at a time to exhaust the shared fixed window.
      for(let j=0;j<25;j++) assert.equal((await request(1,{'x-forwarded-for':'192.0.2.1'},shard%count)).response.status,200);
    }));
    // react-doctor-disable-next-line react-doctor/async-await-in-loop -- Probe each instance after exhausting the shared quota, without adding a second burst.
    for(let i=0;i<count;i++) assert.equal((await request(1,{'x-forwarded-for':'192.0.2.1'},i)).response.status,429,'rate limit must hold across instances');
    console.log('HTTP_READY',JSON.stringify({instances:count,pool_per_instance:20,pgbouncer_backends:24,database_rtt_ms:10,identities:50000,auth:'50% P256 JWT; 50% persisted wallet sessions',negative_auth_checks:22,shared_rate_limit_checks:608}));
    return {read,close};
  } catch(error) { await close(); throw error; }
}
