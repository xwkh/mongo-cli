import test from 'node:test';
import assert from 'node:assert/strict';
import { planOperation } from '../src/plan.js';
import { parse } from '../src/cli.js';

test('read pages are bounded and custom sort has an _id tie-breaker', () => {
  const plan = planOperation('document find', ['orders'], { sort: '{"createdAt":-1}', limit: '10' }, {});
  assert.equal(plan.limit, 10);
  assert.deepEqual(plan.sort, { createdAt: -1, _id: 1 });
  for (const limit of ['0', '-1', '1001', '1.2', 'NaN']) assert.throws(() => planOperation('document find', ['orders'], { limit }, {}));
});

test('writes need explicit filters and invocation-scoped authorization', () => {
  const base = { filter: '{"_id":1}', update: '{"$set":{"state":"done"}}' };
  assert.throws(() => planOperation('document update', ['orders'], base, {}), { code: 'WRITE_BLOCKED' });
  assert.equal(planOperation('document update', ['orders'], { ...base, 'dry-run': true }, {}).write, true);
  assert.equal(planOperation('document update', ['orders'], { ...base, 'allow-writes': true }, {}).many, false);
  for (const env of [{ MONGO_CLI_READ_ONLY: '1' }, { MONGO_CLI_READ_ONLY: 'true' }]) assert.throws(() => planOperation('document update', ['orders'], { ...base, 'allow-writes': true }, env), { code: 'READ_ONLY' });
  assert.throws(() => planOperation('document delete', ['orders'], { 'allow-writes': true }, {}));
  assert.throws(() => planOperation('document delete', ['orders'], { filter: '{}', 'allow-writes': true }, {}), { code: 'EMPTY_WRITE_FILTER' });
  assert.equal(planOperation('document delete', ['orders'], { filter: '{}', all: true, 'allow-writes': true }, {}).many, false);
});

test('read-only aggregation rejects writes in nested and top-level pipelines', () => {
  for (const pipeline of [
    [{ $out: 'copy' }], [{ $merge: 'copy' }], [{ $unknown: {} }],
    [{ $facet: { nested: [{ $out: 'copy' }] } }],
    [{ $lookup: { from: 'other', pipeline: [{ $merge: 'copy' }], as: 'x' } }],
    [{ $unionWith: { coll: 'other', pipeline: [{ $futureStage: {} }] } }],
    [{ $project: { x: { $function: { body: 'return 1', args: [], lang: 'js' } } } }]
  ]) assert.throws(() => planOperation('document aggregate', ['orders'], { pipeline: JSON.stringify(pipeline), 'allow-writes': true }, {}));
  const safe = [{ $facet: { nested: [{ $group: { _id: '$state', n: { $sum: 1 } } }] } }];
  assert.deepEqual(planOperation('document aggregate', ['orders'], { pipeline: JSON.stringify(safe) }, {}).pipeline, safe);
});

test('query inputs cannot evaluate JavaScript and Extended JSON is preserved', () => {
  assert.throws(() => planOperation('document find', ['orders'], { filter: '{"$where":"sleep(9999)"}' }, {}), { code: 'UNSAFE_QUERY' });
  assert.throws(() => planOperation('document find', ['orders'], { filter: 'ObjectId("507f1f77bcf86cd799439011")' }, {}), { code: 'BAD_JSON' });
  const filter = '{"_id":{"$oid":"507f1f77bcf86cd799439011"},"n":{"$numberLong":"9223372036854775807"}}';
  assert.deepEqual(planOperation('document find', ['orders'], { filter }, {}).filter, JSON.parse(filter));
});

test('destructive metadata operations need concrete targets', () => {
  assert.throws(() => planOperation('collection drop', ['orders'], { 'dry-run': true }, {}), { code: 'CONFIRMATION_REQUIRED' });
  assert.equal(planOperation('collection drop', ['orders'], { 'dry-run': true, confirm: 'orders' }, {}).write, true);
  assert.throws(() => planOperation('index drop', ['orders', '*'], { 'dry-run': true }, {}));
});

test('strict CLI parsing rejects typos, duplicate/secret flags, stdin reuse and wrong command flags', () => {
  for (const args of [
    ['document', 'fnd', 'orders'], ['document', 'find', 'orders', '--password', 'SECRET'],
    ['document', 'find', 'orders', '--host', 'wrong-host'], ['config', 'wat'],
    ['document', 'find', 'orders', '--limit', '2', '--limit', '3'],
    ['document', 'find', 'orders', '--filter-file', '-', '--sort-file', '-'],
    ['document', 'count', 'orders', '--limit', '2']
  ]) assert.throws(() => parse(args));
  const result = parse(['--use-context', 'dev', 'document', 'find', 'orders', '--limit', '2']);
  assert.equal(result.command, 'document find');
  assert.equal(result.options['use-context'], 'dev');
  assert.deepEqual(result.args, ['orders']);
});
