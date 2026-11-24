// Run from the repository root. A fresh build uses only disposable local credentials.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';

const root = process.cwd();
const dir = process.env.WALLET_SCALE_HTTP_DIR;
assert(dir && path.isAbsolute(dir), 'Set WALLET_SCALE_HTTP_DIR to an isolated absolute directory');
fs.mkdirSync(dir, {recursive:true,mode:0o700});
fs.mkdirSync(`${dir}/next`, {recursive:true});
if (!fs.existsSync(`${dir}/node_modules`)) fs.symlinkSync(`${root}/node_modules`, `${dir}/node_modules`);
const next = `${root}/apps/web/.next`;
if (!fs.existsSync(next)) fs.symlinkSync(`${dir}/next`,next);
assert.equal(fs.realpathSync(next),fs.realpathSync(`${dir}/next`),'Use a separate worktree/build directory');
const {privateKey,publicKey}=generateKeyPairSync('ec',{namedCurve:'P-256'});
const env={
  PATH:process.env.PATH, HOME:process.env.HOME, NODE_COMPILE_CACHE:`${dir}/node-cache`, NODE_ENV:'production', NEXT_TELEMETRY_DISABLED:'1',
  NEXT_PUBLIC_SITE_URL:'http://127.0.0.1:39170',
  PRIVY_APP_ID:'lt00000000000000000000000', NEXT_PUBLIC_PRIVY_APP_ID:'lt00000000000000000000000',
  PRIVY_JWT_VERIFICATION_KEY:publicKey.export({format:'pem',type:'spki'}).toString(),
  RATE_LIMIT_SUBJECT_PEPPER:randomBytes(32).toString('hex'), BLAST_GATE_SECRET:randomBytes(32).toString('hex'),
  BLAST_SOCIAL_ENABLED:'true', BLAST_PRESALE_ENABLED:'true', BLAST_TRADING_ENABLED:'false', BLAST_LAUNCHPAD_ENABLED:'false',
  NODE_OPTIONS:[process.env.NODE_OPTIONS, `--import ${root}/apps/web/loadtest/lib/egress-guard.mjs`].filter(Boolean).join(" "),
  LOADTEST_EGRESS_LOG:`${dir}/runtime-egress.jsonl`, LOADTEST_EGRESS_MODE:'block',
};
fs.writeFileSync(`${dir}/app-env.json`,JSON.stringify(env),{mode:0o600});
fs.writeFileSync(`${dir}/signing.pem`,privateKey.export({format:'pem',type:'pkcs8'}),{mode:0o600});
// Only next/font may leave loopback while building. Running servers have no allowlist.
const child=spawn(process.execPath,[`${root}/node_modules/next/dist/bin/next`,'build','--webpack'],{
  cwd:`${root}/apps/web`, env:{...env,LOADTEST_EGRESS_ALLOW:'fonts.googleapis.com,fonts.gstatic.com',LOADTEST_EGRESS_LOG:`${dir}/build-egress.jsonl`}, stdio:'inherit',
});
child.on('error',error=>{ console.error(error);process.exitCode=1; });
child.on('exit',code=>{process.exitCode=code??1;});
