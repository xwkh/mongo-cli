import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadConfig, saveConfig, validateContext } from '../src/config.js';
import { accountKey, CredentialStore, resolveCredential } from '../src/credentials.js';
import { emit } from '../src/io.js';

function temporary(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mongo-cli-test-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }

test('config has atomic private permissions and rejects embedded credentials', t => {
  const dir = temporary(t);
  saveConfig(dir, { version: 1, current_context: 'dev', contexts: { dev: validateContext({ host: 'localhost' }) } });
  assert.equal(fs.statSync(path.join(dir, 'config.json')).mode & 0o777, 0o600);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  assert.equal(loadConfig(dir).current_context, 'dev');
  for (const c of [{ host: 'mongodb://u:p@host' }, { password: 'SECRET' }, { port: 0 }, { database: '../bad' }, { srv: true, host: 'host:27017' }]) assert.throws(() => validateContext(c));
});

test('file store separates credentials and rejects permissive files/symlinks', t => {
  const dir = temporary(t), context = validateContext({}), store = new CredentialStore(dir, { platform: 'linux' });
  const key = accountKey(dir, 'dev', context), credential = { username: 'account', password: 'p@ss"\n$word' };
  assert.equal(store.save(key, credential, 'file'), 'file');
  assert.deepEqual(store.load(key, 'file'), credential);
  assert.equal(fs.statSync(store.file(key)).mode & 0o777, 0o600);
  fs.chmodSync(store.file(key), 0o644);
  assert.throws(() => store.load(key, 'file'), { code: 'CREDENTIAL_STORE_INACCESSIBLE' });
  fs.rmSync(store.file(key)); fs.symlinkSync('/dev/null', store.file(key));
  assert.throws(() => store.load(key, 'file'), { code: 'CREDENTIAL_STORE_INACCESSIBLE' });
});

test('credential keys bind endpoints but allow database changes', t => {
  const dir = temporary(t), c = validateContext({});
  const key = accountKey(dir, 'dev', c);
  assert.equal(accountKey(dir, 'dev', { ...c, database: 'other' }), key);
  for (const patch of [{ host: 'different' }, { port: 28017 }, { auth_database: 'other' }, { tls: true }]) assert.notEqual(accountKey(dir, 'dev', { ...c, ...patch }), key);
  assert.notEqual(accountKey(dir, 'prod', c), key);
});

test('macOS credential setup sends secrets to security stdin, never argv', t => {
  const dir = temporary(t), calls = [];
  const store = new CredentialStore(dir, { platform: 'darwin', run: (executable, args, options) => { calls.push({ executable, args, options }); return { status: 0, stderr: '', stdout: '' }; } });
  const credential = { username: 'private-user', password: 'private-password' };
  assert.equal(store.save('abc123', credential), 'keychain');
  assert.deepEqual(calls[1].args, ['-i']);
  assert.ok(!JSON.stringify(calls.map(c => c.args)).includes(credential.password));
  assert.ok(calls[1].options.input.includes(Buffer.from(JSON.stringify(credential)).toString('base64')));
  const failed = new CredentialStore(dir, { platform: 'darwin', run: (_, args) => ({ status: 0, stderr: args[0] === '-i' ? 'SecKeychainItem: User interaction is not allowed.' : '' }) });
  assert.throws(() => failed.save('key', credential), { code: 'CREDENTIAL_STORE_INACCESSIBLE' });
  assert.ok(!fs.existsSync(path.join(dir, 'credentials')));
});

test('incomplete environment credentials fail; logout cannot downgrade auth', t => {
  const dir = temporary(t), store = new CredentialStore(dir, { platform: 'linux' }), c = validateContext({ credential_backend: 'file' });
  assert.throws(() => resolveCredential(store, dir, 'dev', c, { MONGO_CLI_USERNAME: 'a' }), { code: 'INCOMPLETE_ENV_CREDENTIALS' });
  assert.throws(() => resolveCredential(store, dir, 'dev', c, {}), { code: 'CREDENTIAL_NOT_FOUND' });
});

test('JSON and NDJSON projection retain continuation without polluting stdout', () => {
  let stdout = '', stderr = '';
  const out = { write: s => { stdout += s; } }, err = { write: s => { stderr += s; } };
  emit({ items: [{ _id: 1, detail: { state: 'x', secret: 'omit' } }], has_more: true, next: 20 }, { fields: 'detail.state' }, out, err);
  assert.deepEqual(JSON.parse(stdout), { items: [{ detail: { state: 'x' } }], has_more: true, next: 20 });
  stdout = ''; emit({ items: [{ a: 1 }], has_more: true, next: 2 }, { format: 'ndjson' }, out, err);
  assert.deepEqual(JSON.parse(stdout), { a: 1 });
  assert.equal(JSON.parse(stderr)._notice.pagination.next, 2);
  assert.equal({}.polluted, undefined);
  stdout = ''; emit(JSON.parse('{"__proto__":{"polluted":true}}'), { fields: '__proto__.polluted' }, out, err);
  assert.equal({}.polluted, undefined);
});

test('offline CLI dry-run never connects or loads credentials', t => {
  const dir = temporary(t), cli = path.resolve('bin/mongo-cli.js');
  const invoke = args => spawnSync(process.execPath, [cli, '--config', dir, ...args], { encoding: 'utf8' });
  assert.equal(invoke(['config', 'set-context', 'dev']).status, 0);
  const r = invoke(['document', 'insert', 'orders', '--document', '{"x":1}', '--dry-run']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).dry_run, true);
  const bad = invoke(['document', 'find', 'orders', '--password', 'DO_NOT_ECHO']);
  assert.equal(bad.status, 2);
  assert.ok(!bad.stderr.includes('DO_NOT_ECHO'));
});

test('changing a configured endpoint never forwards previous credentials or downgrades authentication', t => {
  const dir = temporary(t), cli = path.resolve('bin/mongo-cli.js');
  const invoke = args => spawnSync(process.execPath, [cli, '--config', dir, ...args], { encoding: 'utf8', env: { ...process.env, MONGO_CLI_USERNAME: '', MONGO_CLI_PASSWORD: '' } });
  const context = validateContext({ credential_backend: 'file' });
  saveConfig(dir, { version: 1, current_context: 'dev', contexts: { dev: context } });
  const store = new CredentialStore(dir, { platform: 'linux' });
  store.save(accountKey(dir, 'dev', context), { username: 'private', password: 'private' }, 'file');
  assert.equal(invoke(['config', 'set-context', 'dev', '--host', 'other-host']).status, 0);
  const changed = loadConfig(dir).contexts.dev;
  assert.equal(changed.credential_backend, 'file');
  assert.throws(() => resolveCredential(store, dir, 'dev', changed, {}), { code: 'CREDENTIAL_NOT_FOUND' });
});
