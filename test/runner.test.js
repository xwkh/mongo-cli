import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { runMongo } from '../src/runner.js';
import { validateContext } from '../src/config.js';

const context = validateContext({});
const credential = { username: 'secret-user', password: 'secret-password' };
const operation = { command: 'document find', collection: 'orders', write: false };

test('runner isolates credentials in stdin and parses only the structured envelope', async () => {
  const result = await runMongo({ context, credential, operation, env: { ...process.env, MONGO_CLI_USERNAME: credential.username, MONGO_CLI_PASSWORD: credential.password }, spawnProcess: (file, args, options) => {
    assert.ok(!JSON.stringify(args).includes(credential.password));
    assert.equal(file, process.execPath);
    assert.equal(args.length, 1); assert.ok(args[0].endsWith('/src/worker.js'));
    assert.equal(options.env.MONGO_CLI_PASSWORD, undefined);
    assert.equal(options.env.MONGO_CLI_USERNAME, undefined);
    return spawn(process.execPath, ['-e', `let input=''; process.stdin.on('data', c => input += c); process.stdin.on('end', () => { const r=JSON.parse(input); if (r.credential.password !== 'secret-password') process.exit(1); console.log('worker startup notice'); console.log('__MONGO_CLI_RESPONSE__'+JSON.stringify({ok:true,result:{items:[{text:'中文'}],has_more:false}})); });`], options);
  } });
  assert.deepEqual(result, { items: [{ text: '中文' }], has_more: false });
});

test('runner never forwards raw URI errors, stdout or stderr', async () => {
  const spawnProcess = (_, args, options) => spawn(process.execPath, ['-e', `process.stdin.resume(); console.error('mongodb://secret-user:secret-password@host'); console.log('secret-password'); process.exitCode=1;`], options);
  await assert.rejects(runMongo({ context, credential, operation, spawnProcess }), error => {
    assert.equal(error.code, 'INVALID_WORKER_RESPONSE');
    assert.ok(!JSON.stringify(error.payload()).includes(credential.password));
    return true;
  });
});

test('runner terminates timed-out writes and reports an unknown outcome without retry advice', async () => {
  const spawnProcess = (_, args, options) => spawn(process.execPath, ['-e', 'process.stdin.resume(); setInterval(()=>{}, 1000);'], options);
  await assert.rejects(runMongo({ context, credential, operation: { ...operation, write: true }, spawnProcess, timeout: 100 }), error => {
    assert.equal(error.code, 'PROCESS_TIMEOUT'); assert.equal(error.retryable, false);
    assert.match(error.hint, /unknown or partial/);
    return true;
  });
});

test('worker startup failure produces a structured dependency error', async () => {
  await assert.rejects(runMongo({ context, credential, operation, spawnProcess: (_, args, options) => spawn('/nonexistent/node', args, options) }), { code: 'WORKER_UNAVAILABLE' });
});

test('driver error envelopes redact raw messages and retain authentication classification', async () => {
  const spawnProcess = (_, args, options) => spawn(process.execPath, ['-e', `process.stdin.resume(); console.log('__MONGO_CLI_RESPONSE__'+JSON.stringify({ok:false,error:{code:18,name:'MongoServerError',message:'mongodb://secret-user:secret-password@host'}}));`], options);
  await assert.rejects(runMongo({ context, credential, operation, spawnProcess }), error => {
    assert.equal(error.code, 'AUTHENTICATION_FAILED');
    assert.ok(!JSON.stringify(error.payload()).includes(credential.password));
    return true;
  });
});

test('worker response bytes remain bounded', async () => {
  const spawnProcess = (_, args, options) => spawn(process.execPath, ['-e', `process.stdin.resume(); process.stdout.write('x'.repeat(17 * 1024 * 1024));`], options);
  await assert.rejects(runMongo({ context, credential, operation, spawnProcess }), { code: 'OUTPUT_TOO_LARGE' });
});
