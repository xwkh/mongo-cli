import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { manageSkill, skillTargets } from '../src/skills.js';
import { version } from '../src/cli.js';

test('skill installs bundled instructions, reports alignment and refreshes safely', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mongo-cli-skill-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const target = { dir: directory };
  assert.equal(manageSkill('status', target, version).items[0].status, 'missing');
  const installed = manageSkill('install', target, version);
  assert.equal(installed.items[0].alignment, 'current');
  assert.equal(manageSkill('status', target, version).items[0].version, version);
  fs.writeFileSync(path.join(directory, 'mongodb', 'personal-notes.txt'), 'retain');
  manageSkill('install', target, version);
  assert.equal(fs.readFileSync(path.join(directory, 'mongodb', 'personal-notes.txt'), 'utf8'), 'retain');
  fs.rmSync(path.join(directory, 'mongodb', '.mongo-cli-skill'));
  assert.throws(() => manageSkill('install', target, version), { code: 'SKILL_CONFLICT' });
  assert.equal(manageSkill('install', { ...target, force: true }, version).items[0].alignment, 'current');
});

test('skill targets use global/project agent conventions and reject conflicting options', () => {
  assert.equal(skillTargets({ agent: 'codex' }, '/tmp/test-home')[0].path, '/tmp/test-home/.codex/skills/mongodb');
  assert.equal(skillTargets({ agent: 'codex', project: true })[0].path, path.join(process.cwd(), '.agents/skills/mongodb'));
  assert.throws(() => skillTargets({ dir: '/tmp/skills', agent: 'codex' }));
  assert.throws(() => skillTargets({ agent: 'unknown' }));
});
