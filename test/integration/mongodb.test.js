import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient, ObjectId, Long, Decimal128 } from 'mongodb';

const cli = path.resolve('bin/mongo-cli.js');
const username = 'mongo-cli-test-user';
const password = 'temporary-p@ss:"word/$?中文';
let server, client, directory, port;

async function invoke(args, { env = {}, success = true, input = '' } = {}) {
  // The CLI and its worker run via absolute Node paths. No external binaries
  // (including mongosh) can be found in any integration invocation.
  const childEnv = { ...process.env, PATH: directory, MONGO_CLI_MONGOSH: '/missing/mongosh', ...env };
  delete childEnv.MONGO_CLI_USERNAME; delete childEnv.MONGO_CLI_PASSWORD;
  Object.assign(childEnv, env);
  const result = await new Promise(resolve => {
    const child = execFile(process.execPath, [cli, '--config', directory, '--use-context', 'test', ...args], { encoding: 'utf8', env: childEnv, timeout: 45000, maxBuffer: 20 * 1024 * 1024 }, (error, stdout, stderr) => resolve({ status: error ? error.code : 0, stdout, stderr }));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
  assert.ok(!result.stdout.includes(password), 'password must not appear in stdout');
  assert.ok(!result.stderr.includes(password), 'password must not appear in stderr');
  if (success) assert.equal(result.status, 0, `${args.slice(0, 3).join(' ')}: ${result.stderr}`);
  return { ...result, data: result.stdout.trim() && !args.includes('ndjson') ? JSON.parse(result.stdout) : null, error: result.stderr.trim().startsWith('{"error":') ? JSON.parse(result.stderr).error : null };
}

before(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mongo-cli-integration-'));
  server = await MongoMemoryServer.create({ auth: { enable: true, customRootName: username, customRootPwd: password } });
  port = server.instanceInfo.port;
  client = new MongoClient(server.getUri(), { auth: { username, password }, authSource: 'admin' });
  await client.connect();
  const collection = client.db('app').collection('orders');
  await collection.insertMany([
    { _id: new ObjectId('507f1f77bcf86cd799439011'), state: 'pending', amount: Decimal128.fromString('12.34'), big: Long.fromString('9223372036854775807'), smallLong: Long.fromNumber(42), createdAt: new Date('2026-01-01T00:00:00Z'), tags: ['a', 'b'] },
    { _id: new ObjectId('507f1f77bcf86cd799439012'), state: 'pending', amount: 5, tags: ['b', 'c'] },
    { _id: new ObjectId('507f1f77bcf86cd799439013'), state: 'done', amount: 8, tags: null },
    { _id: new ObjectId('507f1f77bcf86cd799439014'), state: 'done', amount: 9 }
  ]);
  await invoke(['config', 'set-context', 'test', '--host', '127.0.0.1', '--port', String(port), '--database', 'app']);
  await invoke(['auth', 'login', '--credential-store', 'file', '--verify'], { env: { MONGO_CLI_USERNAME: username, MONGO_CLI_PASSWORD: password } });
}, { timeout: 300000 });

after(async () => {
  await client?.close();
  await server?.stop();
  if (directory) fs.rmSync(directory, { recursive: true, force: true });
});

test('URI import separates encoded credentials and authenticates with the selected mechanism', async () => {
  const uri = `mongodb://${encodeURIComponent(username)}:${encodeURIComponent(password)}@127.0.0.1:${port}/app?authSource=admin&authMechanism=SCRAM-SHA-256`;
  const imported = await invoke(['config', 'init', '--uri-stdin', '--name', 'test', '--credential-store', 'file'], { input: uri });
  assert.equal(imported.data.configured, true);
  const settings = (await invoke(['config', 'show'])).data.settings;
  assert.equal(settings.auth_mechanism, 'SCRAM-SHA-256');
  assert.equal(settings.auth_database, 'admin');
  assert.ok(!JSON.stringify(settings).includes(username));
  assert.equal((await invoke(['ping'])).data.ok, true);
});

test('authenticated doctor, discovery and schema work with the bundled driver and an empty executable PATH', async () => {
  const doctor = (await invoke(['doctor'])).data;
  assert.equal(doctor.ok, true);
  assert.equal(doctor.checks.driver, 'ok');
  assert.match(doctor.driver_version, /^7\./);
  assert.equal(doctor.mongosh_version, undefined);
  assert.ok((await invoke(['db', 'list'])).data.items.some(db => db.name === 'app'));
  assert.ok((await invoke(['collection', 'list'])).data.items.some(c => c.name === 'orders'));
  assert.ok((await invoke(['collection', 'schema', 'orders'])).data.items.some(f => f.field === 'state' && f.types.includes('string')));
  assert.equal((await invoke(['collection', 'stats', 'orders'])).data.count, 4);
  assert.equal((await invoke(['db', 'stats'])).data.db, 'app');
  assert.ok((await invoke(['index', 'list', 'orders'])).data.items.some(i => i.name === '_id_'));
});

test('find preserves BSON and paginates without lossy int64 conversion', async () => {
  const first = (await invoke(['document', 'find', 'orders', '--limit', '2'])).data;
  assert.equal(first.items.length, 2); assert.equal(first.has_more, true); assert.equal(first.next, 2);
  assert.deepEqual(first.items[0].smallLong, { $numberLong: '42' });
  assert.deepEqual(first.items[0].big, { $numberLong: '9223372036854775807' });
  assert.deepEqual(first.items[0]._id, { $oid: '507f1f77bcf86cd799439011' });
  assert.deepEqual(first.items[0].amount, { $numberDecimal: '12.34' });
  assert.deepEqual(first.items[0].createdAt, { $date: { $numberLong: '1767225600000' } });
  const second = (await invoke(['document', 'find', 'orders', '--limit', '2', '--skip', String(first.next)])).data;
  assert.equal(second.has_more, false); assert.equal(second.items.length, 2);
  assert.notDeepEqual(first.items[0]._id, second.items[0]._id);
  const precise = (await invoke(['document', 'find', 'orders', '--filter', '{"big":{"$numberLong":"9223372036854775807"}}'])).data;
  assert.equal(precise.items.length, 1);
  assert.equal((await invoke(['document', 'count', 'orders', '--filter', '{"state":"pending"}'])).data.count, 2);
  const projected = (await invoke(['document', 'find', 'orders', '--projection', '{"_id":0,"state":1}', '--limit', '1'])).data;
  assert.deepEqual(projected.items, [{ state: 'pending' }]);
  const dated = (await invoke(['document', 'find', 'orders', '--filter', '{"createdAt":{"$gte":{"$date":"2026-01-01T00:00:00Z"}}}'])).data;
  assert.equal(dated.items.length, 1);
});

test('aggregate, distinct, explain and NDJSON use bounded results', async () => {
  const grouped = (await invoke(['document', 'aggregate', 'orders', '--pipeline', '[{"$group":{"_id":"$state","n":{"$sum":1}}},{"$sort":{"_id":1}}]', '--limit', '1'])).data;
  assert.equal(grouped.items.length, 1); assert.equal(grouped.has_more, true);
  const distinct = (await invoke(['document', 'distinct', 'orders', '--key', 'tags'])).data;
  assert.deepEqual(distinct.items.map(v => v.value), [null, 'a', 'b', 'c']);
  assert.ok((await invoke(['document', 'explain', 'orders', '--filter', '{"state":"pending"}'])).data.queryPlanner);
  const nd = (await invoke(['document', 'find', 'orders', '--limit', '1', '--format', 'ndjson', '--fields', '_id,state']));
  assert.equal(nd.stdout.trim().split('\n').length, 1);
  assert.equal(JSON.parse(nd.stderr)._notice.pagination.next, 1);
});

test('writes change data only after authorization and previews are offline', async () => {
  const insert = ['document', 'insert', 'scratch', '--document', '[{"_id":1,"state":"new"},{"_id":2,"state":"new"}]'];
  assert.equal((await invoke(insert, { success: false })).status, 5);
  assert.equal((await invoke([...insert, '--dry-run'])).data.dry_run, true);
  assert.equal(await client.db('app').collection('scratch').countDocuments(), 0);
  assert.equal((await invoke([...insert, '--allow-writes'])).data.acknowledged, true);
  assert.equal((await invoke(['document', 'update', 'scratch', '--filter', '{"state":"new"}', '--update', '{"$set":{"state":"done"}}', '--many', '--allow-writes'])).data.modifiedCount, 2);
  assert.equal((await invoke(['document', 'replace', 'scratch', '--filter', '{"_id":1}', '--document', '{"state":"replaced"}', '--allow-writes'])).data.modifiedCount, 1);
  assert.equal((await invoke(['index', 'create', 'scratch', '--keys', '{"state":1}', '--name', 'state_idx', '--allow-writes'])).data.name, 'state_idx');
  await invoke(['index', 'drop', 'scratch', 'state_idx', '--allow-writes']);
  assert.equal((await invoke(['document', 'delete', 'scratch', '--filter', '{"_id":1}', '--allow-writes'])).data.deletedCount, 1);
  assert.equal((await invoke(['document', 'delete', 'scratch', '--filter', '{}', '--many', '--all', '--allow-writes', '--read-only'], { success: false })).status, 5);
  assert.equal(await client.db('app').collection('scratch').countDocuments(), 1);
  assert.equal((await invoke(['collection', 'drop', 'scratch', '--confirm', 'scratch', '--allow-writes'])).data.dropped, true);
  assert.equal((await invoke(['collection', 'create', 'scratch', '--allow-writes'])).data.ok, 1);
  assert.ok((await invoke(['collection', 'list'])).data.items.some(c => c.name === 'scratch'));
  assert.equal((await invoke(['document', 'insert', 'scratch', '--document', '{"_id":3,"state":"new"}', '--allow-writes'])).data.insertedId, 3);
  assert.equal((await invoke(['document', 'update', 'scratch', '--filter', '{"_id":3}', '--update', '{"$set":{"state":"updated"}}', '--allow-writes'])).data.modifiedCount, 1);
  assert.equal((await invoke(['document', 'update', 'scratch', '--filter', '{"_id":4}', '--update', '{"$set":{"state":"upserted"}}', '--upsert', '--allow-writes'])).data.upsertedId, 4);
  assert.equal((await invoke(['document', 'delete', 'scratch', '--filter', '{}', '--many', '--all', '--allow-writes'])).data.deletedCount, 2);
});

test('auth failures and query errors never reveal credentials or raw URIs', async () => {
  const bad = (await invoke(['ping'], { success: false, env: { MONGO_CLI_USERNAME: username, MONGO_CLI_PASSWORD: 'wrong-password' } }));
  assert.equal(bad.status, 4); assert.equal(bad.error.code, 'AUTHENTICATION_FAILED');
  assert.ok(!bad.stderr.includes('mongodb://'));
  const duplicate = (await invoke(['document', 'insert', 'orders', '--document', '{"_id":{"$oid":"507f1f77bcf86cd799439011"}}', '--allow-writes'], { success: false }));
  assert.equal(duplicate.error.code, 'DUPLICATE_KEY');
});

test('logout reports missing credentials rather than trying anonymous auth', async () => {
  await invoke(['auth', 'logout']);
  const result = (await invoke(['ping'], { success: false }));
  assert.equal(result.status, 4);
  assert.equal(result.error.code, 'CREDENTIAL_NOT_FOUND');
});
