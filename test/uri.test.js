import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { parseMongoURI } from '../src/uri.js';
import { validateContext, contextFromFlags, loadConfig } from '../src/config.js';
import { CredentialStore, accountKey } from '../src/credentials.js';
import { parse } from '../src/cli.js';

test('imports a multi-host PLAIN/$external URI without retaining the URI in settings', () => {
  const source = 'mongodb://YYY:XXXX@192.0.2.10,192.0.2.11/app?authMechanism=PLAIN&authSource=%24external';
  const { context, credential } = parseMongoURI(source);
  assert.equal(context.host, '192.0.2.10,192.0.2.11');
  assert.equal(context.port, 27017);
  assert.equal(context.database, 'app');
  assert.equal(context.auth_mechanism, 'PLAIN');
  assert.equal(context.auth_database, '$external');
  assert.deepEqual(credential, { username: 'YYY', password: 'XXXX' });
  assert.ok(!JSON.stringify(context).includes('YYY'));
  assert.ok(!JSON.stringify(context).includes('XXXX'));
  assert.ok(!JSON.stringify(context).includes('mongodb://'));
});

test('percent-encoded credentials decode exactly once and query options are case-insensitive', () => {
  const username = 'a@b:$[]', password = 'p@ss:/$?#[]%+中文';
  const { context, credential } = parseMongoURI(`mongodb://${encodeURIComponent(username)}:${encodeURIComponent(password)}@db1:27018,db2:27019/app?AUTHMECHANISM=SCRAM-SHA-256&AUTHSOURCE=admin&ReplicaSet=rs0&SSL=true`);
  assert.deepEqual(credential, { username, password });
  assert.equal(context.auth_database, 'admin');
  assert.equal(context.replica_set, 'rs0');
  assert.equal(context.tls, true);
  assert.equal(context.host, 'db1:27018,db2:27019');
});

test('URI auth database defaults and SRV/IPv6 settings retain MongoDB semantics', () => {
  assert.equal(parseMongoURI('mongodb://u:p@host/app').context.auth_database, 'app');
  assert.equal(parseMongoURI('mongodb://u:p@host/').context.auth_database, 'admin');
  assert.equal(parseMongoURI('mongodb://u:p@host/app?authMechanism=PLAIN').context.auth_database, '$external');
  const srv = parseMongoURI('mongodb+srv://u:p@cluster.example.com/app?authSource=admin');
  assert.equal(srv.context.srv, true); assert.equal(srv.context.tls, true);
  assert.equal(parseMongoURI('mongodb://[::1]:28017,[2001:db8::2]/app').context.host, '[::1]:28017,[2001:db8::2]');
  assert.equal(parseMongoURI('mongodb://host/app?directConnection=true').context.direct_connection, true);
  assert.equal(parseMongoURI('mongodb://host/').credential, null);
  assert.equal(parseMongoURI('mongodb://u:@host/app').credential.password, '');
  assert.equal(parseMongoURI('mongodb://host/?authMechanism=DEFAULT').context.auth_mechanism, undefined);
});

test('invalid/unsupported URI options fail closed and never echo any URI content', () => {
  const inputs = [
    'http://sensitive-user:sensitive-password@host/app',
    'mongodb://sensitive-user:sensitive-password@host/app?password=sensitive-password',
    'mongodb://sensitive-user:sensitive-password@host/app?authMechanism=PLAIN&authSource=admin',
    'mongodb://sensitive-user:sensitive-password@host/app?authMechanism=UNKNOWN',
    'mongodb://sensitive-user:sensitive-password@host/app?tls=false&ssl=true',
    'mongodb://sensitive-user:sensitive-password@host/app?authSource=admin&AuthSource=other',
    'mongodb://sensitive-user:sensitive-password@host/app?tls=FALSE',
    'mongodb://sensitive-user:sensitive-password@host/app?tlsInsecure=true',
    'mongodb://sensitive-user:sensitive-password@host/app?authSource=%ZZ',
    'mongodb://sensitive-user:sensitive-password@host/app?authSource=%FF',
    'mongodb://sensitive-user:sensitive-password@host/app?replicaSet=',
    'mongodb://sensitive-user:sensitive-password@host/app?readPreference=secondary',
    'mongodb://sensitive-user:sensitive-password@host:99999/app',
    'mongodb://sensitive-user:sensitive-password@host:0/app',
    'mongodb://sensitive-user:sensitive-password@host,,other/app',
    'mongodb://sensitive-user:sensitive-password@[not-ipv6]/app',
    'mongodb://sensitive-user:sensitive-password@::1/app',
    'mongodb://sensitive-user:sensitive-password@host/a/b',
    'mongodb://sensitive-user:sensitive-password@host/app#fragment',
    'mongodb://sensitive-user:sensitive-password@host/app?authSource=other%2Fbad',
    'mongodb://sensitive-user:sensitive-password@host/app?authSource=%24other',
    'mongodb+srv://sensitive-user:sensitive-password@host:27017/app',
    'mongodb+srv://sensitive-user:sensitive-password@host,other/app',
    'mongodb+srv://sensitive-user:sensitive-password@host/app?tls=false',
    'mongodb://sensitive-user:sensitive-password:colon@host/app',
    'mongodb://sensitive-user:sensitive-password@at@host/app'
  ];
  for (const source of inputs) assert.throws(() => parseMongoURI(source), error => {
    assert.equal(error.code, 'INVALID_MONGODB_URI');
    const payload = JSON.stringify(error.payload());
    assert.ok(!payload.includes('sensitive-user')); assert.ok(!payload.includes('sensitive-password'));
    assert.ok(!payload.includes(source));
    return true;
  });
});

test('mechanism is validated/bound to credentials while legacy keys remain compatible', () => {
  const base = validateContext({});
  const dir = '/tmp/uri-test', name = 'dev';
  const originalIdentity = [path.resolve(dir), name, base.host, base.port, base.auth_database, base.replica_set, base.srv, base.tls, base.direct_connection, base.tls_ca_file, base.tls_certificate_key_file];
  const originalKey = crypto.createHash('sha256').update(JSON.stringify(originalIdentity)).digest('hex');
  assert.equal(accountKey(dir, name, base), originalKey);
  const explicit = contextFromFlags({ 'auth-mechanism': 'SCRAM-SHA-256' }, base);
  assert.notEqual(accountKey(dir, name, explicit), originalKey);
  assert.equal(accountKey(dir, name, contextFromFlags({ 'auth-mechanism': 'DEFAULT' }, explicit)), originalKey);
  const plain = contextFromFlags({ 'auth-mechanism': 'PLAIN', 'auth-database': '$external' });
  assert.equal(plain.auth_mechanism, 'PLAIN');
  assert.throws(() => validateContext({ auth_mechanism: 'PLAIN' }));
  assert.throws(() => validateContext({ database: '$external' }));
});

test('stdin import stores credentials separately, preserves no old settings, and emits no secrets', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mongo-cli-uri-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const cli = path.resolve('bin/mongo-cli.js');
  const invoke = (args, input) => spawnSync(process.execPath, [cli, '--config', directory, ...args], { encoding: 'utf8', input });
  assert.equal(invoke(['config', 'set-context', 'dev', '--tls', '--replica-set', 'old']).status, 0);
  const credential = { username: 'synthetic-private-user', password: 'synthetic-private-password' };
  const source = `mongodb://${credential.username}:${credential.password}@host1,host2/app?authMechanism=PLAIN&authSource=%24external`;
  const result = invoke(['config', 'init', '--uri-stdin', '--name', 'dev', '--credential-store', 'file'], source + '\n');
  assert.equal(result.status, 0, result.stderr);
  const config = loadConfig(directory), context = config.contexts.dev;
  assert.equal(config.current_context, 'dev');
  assert.equal(context.auth_database, '$external'); assert.equal(context.auth_mechanism, 'PLAIN');
  assert.equal(context.tls, false); assert.equal(context.replica_set, undefined);
  const publicOutput = result.stdout + result.stderr + fs.readFileSync(path.join(directory, 'config.json'), 'utf8') + invoke(['config', 'show']).stdout + invoke(['config', 'contexts']).stdout;
  assert.ok(!publicOutput.includes(credential.username)); assert.ok(!publicOutput.includes(credential.password));
  const store = new CredentialStore(directory, { platform: 'linux' });
  assert.deepEqual(store.load(accountKey(directory, 'dev', context), 'file'), credential);
  const bad = invoke(['config', 'init', '--uri-stdin', '--name', 'dev'], source + '&unknown=secret');
  assert.equal(bad.status, 2);
  assert.equal(JSON.parse(bad.stderr).error.code, 'INVALID_MONGODB_URI');
  assert.ok(!bad.stderr.includes(credential.password));
  assert.deepEqual(loadConfig(directory), config);
  assert.equal(invoke(['config', 'init', '--from-uri', '--uri-stdin'], source).status, 2);
});

test('URI setup rejects credential-bearing command arguments', () => {
  assert.equal(parse(['config', 'init', '--from-uri', '--name', 'dev']).options['from-uri'], true);
  assert.throws(() => parse(['config', 'init', '--uri', 'mongodb://u:p@host/app']));
  assert.throws(() => parse(['config', 'init', 'mongodb://u:p@host/app']));
});

test('real worker forwards PLAIN, decoded authSource, credentials and both seeds into mongosh', async () => {
  const source = fs.readFileSync(new URL('../src/worker.cjs', import.meta.url), 'utf8');
  const { context, credential } = parseMongoURI('mongodb://u%40example:p%3Aword@192.0.2.10,192.0.2.11/app?authMechanism=PLAIN&authSource=%24external');
  let connected;
  const output = [];
  await vm.runInNewContext(source, {
    require: () => ({ readFileSync: () => JSON.stringify({ context, credential, operation: { command: 'ping' }, timeout: 30000, max_time_ms: 10000 }) }),
    EJSON: { deserialize: value => value, serialize: value => value }, URLSearchParams,
    Mongo: class {
      constructor(uri) { connected = uri; }
      getDB(database) { assert.equal(database, 'app'); return { runCommand: async () => ({ ok: true }) }; }
      close() {}
    }, print: value => output.push(value)
  });
  assert.ok(connected.startsWith('mongodb://u%40example:p%3Aword@192.0.2.10:27017,192.0.2.11:27017/app?'));
  const params = new URLSearchParams(connected.split('?')[1]);
  assert.equal(params.get('authMechanism'), 'PLAIN'); assert.equal(params.get('authSource'), '$external');
  assert.equal(params.get('retryWrites'), 'false');
  assert.equal(JSON.parse(output[0].replace('__MONGO_CLI_RESPONSE__', '')).ok, true);
});
