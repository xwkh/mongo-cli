import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { CLIError, usage } from './errors.js';

const bundled = fileURLToPath(new URL('../skills/mongodb', import.meta.url));
const agents = { codex: ['.codex/skills', '.agents/skills'], claude: ['.claude/skills', '.claude/skills'], cursor: ['.cursor/skills', '.cursor/skills'], agents: ['.agents/skills', '.agents/skills'] };

export function skillTargets(options = {}, home = os.homedir()) {
  if (options.dir) {
    if (options.agent || options.project) throw usage('--dir cannot be combined with --agent or --project.');
    return [{ path: path.resolve(options.dir, 'mongodb') }];
  }
  const selected = options.agent ? options.agent.split(',') : Object.keys(agents).filter(a => fs.existsSync(path.join(home, agents[a][0].split('/')[0])));
  if (!selected.length) throw usage('No agent detected; select --agent codex,claude,cursor,agents or --dir <skills-directory>.');
  const unique = new Map();
  for (const agent of selected) {
    if (!Object.hasOwn(agents, agent)) throw usage('Supported agents: codex, claude, cursor, agents.');
    const target = path.join(options.project ? process.cwd() : home, agents[agent][options.project ? 1 : 0], 'mongodb');
    unique.set(target, { agent, path: target });
  }
  return [...unique.values()];
}

export function manageSkill(action, options, version) {
  if (action === 'show') return fs.readFileSync(path.join(bundled, 'SKILL.md'), 'utf8');
  const targets = skillTargets(options);
  const items = targets.map(target => {
    const entry = path.join(target.path, 'SKILL.md');
    let installed;
    if (fs.existsSync(target.path) && fs.lstatSync(target.path).isSymbolicLink()) throw new CLIError('config', 'SKILL_PATH_SYMLINK', 'Skill destination must not be a symbolic link.', 'Choose another skill directory.');
    if (fs.existsSync(entry)) installed = fs.readFileSync(entry, 'utf8').match(/^  version:\s*["']?([\d.]+)["']?\s*$/m)?.[1];
    if (action === 'install') {
      if (fs.existsSync(target.path) && fs.readdirSync(target.path).length && !fs.existsSync(path.join(target.path, '.mongo-cli-skill')) && !options.force) throw new CLIError('config', 'SKILL_CONFLICT', 'An existing MongoDB skill occupies this destination.', 'Review the existing skill and use --force to overwrite its bundled files, or choose --dir.');
      // Only write bundled files; never recursively remove user-owned directories.
      fs.mkdirSync(target.path, { recursive: true });
      for (const name of ['SKILL.md', '.mongo-cli-skill']) {
        const file = path.join(target.path, name);
        if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) throw new CLIError('config', 'SKILL_PATH_SYMLINK', 'Skill files must not be symbolic links.', 'Choose another skill directory.');
      }
      fs.copyFileSync(path.join(bundled, 'SKILL.md'), entry);
      fs.writeFileSync(path.join(target.path, '.mongo-cli-skill'), `${version}\n`);
      installed = version;
    }
    return { ...target, status: installed ? 'installed' : 'missing', version: installed ?? null, alignment: installed === version ? 'current' : installed ? 'outdated' : 'missing' };
  });
  return { items, has_more: false, bundled_version: version, loaded_version: process.env.MONGO_CLI_SKILL || null };
}
