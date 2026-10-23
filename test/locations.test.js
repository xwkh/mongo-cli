import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { configPaths } from '../src/locations.js';
import { configDirectory, saveConfig, loadConfig, validateContext } from '../src/config.js';
import { accountKey, CredentialStore } from '../src/credentials.js';

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mongo-cli-locations-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return { home, ...configPaths(home) };
}

test('fresh installs use the zhouping namespace without creating files during lookup', t => {
  const { home, current } = fixture(t);
  assert.equal(configDirectory({}, {}, home), path.join(home, '.zhouping', 'mongo'));
  assert.equal(fs.existsSync(current), false);
});

test('legacy configuration and file credentials move intact with compatible account keys', t => {
  const { home, current, legacy } = fixture(t);
  const context = validateContext({ credential_backend: 'file', auth_database: '$external', auth_mechanism: 'PLAIN' });
  const config = { version: 1, current_context: 'dev', contexts: { dev: context } };
  saveConfig(legacy, config);
  const credential = { username: 'synthetic-account', password: 'synthetic-password' };
  const oldKey = accountKey(legacy, 'dev', context, home);
  const store = new CredentialStore(legacy, { platform: 'linux' });
  store.save(oldKey, credential, 'file');
  const oldBytes = fs.readFileSync(store.file(oldKey));
  assert.equal(configDirectory({}, {}, home), current);
  assert.deepEqual(loadConfig(current), config);
  assert.equal(fs.existsSync(legacy), false);
  assert.equal(fs.statSync(current).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(current, 'config.json')).mode & 0o777, 0o600);
  const newKey = accountKey(current, 'dev', context, home);
  assert.equal(newKey, oldKey);
  const migrated = new CredentialStore(current, { platform: 'linux' });
  assert.deepEqual(fs.readFileSync(migrated.file(newKey)), oldBytes);
  assert.deepEqual(migrated.load(newKey, 'file'), credential);
  assert.equal(configDirectory({}, {}, home), current); // repeat is idempotent
});

test('migration preserves keychain account identities without contacting the keychain', t => {
  const { home, current, legacy } = fixture(t);
  const context = validateContext({ credential_backend: 'keychain' });
  saveConfig(legacy, { version: 1, current_context: 'dev', contexts: { dev: context } });
  const key = accountKey(legacy, 'dev', context, home);
  configDirectory({}, {}, home);
  assert.equal(accountKey(current, 'dev', loadConfig(current).contexts.dev, home), key);
  assert.equal(fs.existsSync(path.join(current, 'credentials')), false);
});

test('explicit directories bypass migration and flags take precedence over environment', t => {
  const { home, current, legacy } = fixture(t);
  saveConfig(legacy, { version: 1, current_context: null, contexts: {} });
  const custom = path.join(home, 'custom');
  assert.equal(configDirectory({ config: custom }, { MONGO_CLI_CONFIG_DIR: legacy }, home), custom);
  assert.equal(configDirectory({}, { MONGO_CLI_CONFIG_DIR: legacy }, home), legacy);
  assert.ok(fs.existsSync(path.join(legacy, 'config.json')));
  assert.equal(fs.existsSync(current), false);
  assert.notEqual(accountKey(custom, 'dev', validateContext({}), home), accountKey(current, 'dev', validateContext({}), home));
});

test('existing destination wins without merging or overwriting either configuration', t => {
  const { home, current, legacy } = fixture(t);
  const oldConfig = { version: 1, current_context: 'old', contexts: { old: validateContext({}) } };
  const newConfig = { version: 1, current_context: 'new', contexts: { new: validateContext({ host: 'other-host' }) } };
  saveConfig(legacy, oldConfig); saveConfig(current, newConfig);
  assert.equal(configDirectory({}, {}, home), current);
  assert.deepEqual(loadConfig(current), newConfig);
  assert.deepEqual(loadConfig(legacy), oldConfig);
});

test('automatic migration refuses a symbolic link as its source directory', t => {
  const { home, current, legacy } = fixture(t);
  const other = path.join(home, 'other');
  saveConfig(other, { version: 1, current_context: null, contexts: {} });
  fs.mkdirSync(path.dirname(legacy), { recursive: true });
  fs.symlinkSync(other, legacy);
  assert.throws(() => configDirectory({}, {}, home), { code: 'UNSAFE_CONFIG_PATH' });
  assert.equal(fs.existsSync(current), false);
  assert.ok(fs.existsSync(path.join(other, 'config.json')));
});
