import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { CLIError, usage, exits } from './errors.js';
import { configDirectory, loadConfig, saveConfig, selectContext, contextFromFlags, validName, integer, defaults } from './config.js';
import { accountKey, CredentialStore, resolveCredential } from './credentials.js';
import { emit } from './io.js';
import { specs, globals, help } from './specs.js';
import { planOperation } from './plan.js';
import { runMongo } from './runner.js';
import { promptFields } from './prompts.js';
import { manageSkill } from './skills.js';
import { driverVersion } from './connection.js';
import { parseMongoURI } from './uri.js';

export const version = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

export function parse(argv) {
  // First tokenize all known flags to locate commands without mistaking a flag
  // value for a noun. Then strictly parse only the selected command's options.
  const all = Object.assign({}, globals, ...Object.values(specs).map(s => s.options || {}));
  let preliminary;
  try { preliminary = parseArgs({ args: argv, options: all, allowPositionals: true, tokens: true }); }
  catch { throw usage('Unknown flag or missing flag value. Run mongo-cli --help.', 'BAD_FLAG'); }
  const words = preliminary.positionals;
  if (preliminary.values.version) return { command: 'version', args: [], options: preliminary.values };
  let command = Object.hasOwn(specs, words[0]) ? words[0] : words.slice(0, 2).join(' ');
  if (preliminary.values.help || !words.length || (words.length === 1 && Object.keys(specs).some(k => k.startsWith(`${words[0]} `)))) {
    if (words.length && !Object.hasOwn(specs, command) && !Object.keys(specs).some(k => k.startsWith(`${words[0]} `))) throw usage('Unknown command.', 'UNKNOWN_COMMAND');
    return { help: help(Object.hasOwn(specs, command) ? command : words[0]) };
  }
  const spec = specs[command];
  if (!spec) throw usage('Unknown command. Run mongo-cli --help.', 'UNKNOWN_COMMAND');
  let parsed;
  try { parsed = parseArgs({ args: argv, options: { ...globals, ...spec.options }, allowPositionals: true, tokens: true }); }
  catch { throw usage('This flag is not supported by the selected command, or its value is missing.', 'BAD_FLAG'); }
  const flags = parsed.tokens.filter(t => t.kind === 'option').map(t => t.name);
  if (new Set(flags).size !== flags.length) throw usage('Repeated flags are not supported.', 'DUPLICATE_FLAG');
  const args = parsed.positionals.slice(command.split(' ').length);
  if (args.length !== spec.args) throw usage(`Expected: mongo-cli ${command}${spec.operand ? ` ${spec.operand}` : ''}.`);
  if (parsed.values.format && !['json', 'ndjson'].includes(parsed.values.format)) throw usage('--format must be json or ndjson.');
  if (Object.entries(parsed.values).filter(([name, value]) => name.endsWith('-file') && value === '-').length > 1) throw usage('Only one JSON input may read stdin.');
  return { command, args, options: parsed.values };
}

async function credentialsFromUser() {
  if (process.env.MONGO_CLI_USERNAME !== undefined || process.env.MONGO_CLI_PASSWORD !== undefined) {
    if (!process.env.MONGO_CLI_USERNAME || process.env.MONGO_CLI_PASSWORD === undefined) throw usage('Set MONGO_CLI_USERNAME and MONGO_CLI_PASSWORD together.');
    return { username: process.env.MONGO_CLI_USERNAME, password: process.env.MONGO_CLI_PASSWORD };
  }
  const credential = await promptFields([{ key: 'username', label: 'Username' }, { key: 'password', label: 'Password (hidden)', secret: true }]);
  if (!credential.username) throw usage('Username must not be empty.');
  return credential;
}

async function execute(command, args, options) {
  if (command === 'version') return { version, node: process.version, driver_version: driverVersion };
  if (command.startsWith('skill ')) return manageSkill(command.split(' ')[1], options, version);
  const directory = configDirectory(options);
  const store = new CredentialStore(directory);
  if (command === 'config contexts') {
    const config = loadConfig(directory);
    return { items: Object.entries(config.contexts).map(([name, c]) => ({ name, current: config.current_context === name, ...c })), has_more: false };
  }
  if (command === 'config init') {
    const name = validName(options.name || 'default');
    const config = loadConfig(directory);
    const explicitModes = ['from-uri', 'step-by-step', 'uri-stdin'].filter(flag => options[flag]);
    if (explicitModes.length > 1) throw usage('Use only one of --from-uri, --step-by-step or --uri-stdin.');
    let fromURI = !!options['from-uri'];
    if (!explicitModes.length) {
      const { method } = await promptFields([{
        key: 'method',
        label: 'Connection setup:\n  1) MongoDB URI (recommended)\n  2) Step-by-step fields\nSelect setup method',
        default: '1'
      }]);
      const choice = method.trim().toLowerCase();
      if (!['1', 'uri', '2', 'fields'].includes(choice)) throw usage('Select 1 (URI) or 2 (step-by-step fields).');
      fromURI = choice === '1' || choice === 'uri';
    }
    if (fromURI || options['uri-stdin']) {
      let source;
      if (options['uri-stdin']) {
        if (process.stdin.isTTY) throw usage('--uri-stdin needs a private pipe; use --from-uri in an interactive terminal.');
        // A connection string is small; bound stdin before allocating/parsing it.
        const buffer = Buffer.alloc(65537);
        let length = 0, count;
        do { count = fs.readSync(0, buffer, length, buffer.length - length, null); length += count; } while (count && length < buffer.length);
        if (length === buffer.length) throw usage('MongoDB connection URI must be at most 64 KiB.', 'INVALID_MONGODB_URI');
        source = buffer.subarray(0, length).toString('utf8');
      } else source = (await promptFields([{ key: 'uri', label: 'MongoDB connection URI (hidden)', secret: true }])).uri;
      // Import replaces connection settings rather than merging in a previous
      // endpoint's TLS/auth options. Never store or emit the original URI.
      const { context, credential } = parseMongoURI(source);
      if (credential) context.credential_backend = store.save(accountKey(directory, name, context), credential, options['credential-store'] || 'auto');
      else context.credential_backend = 'none';
      Object.defineProperty(config.contexts, name, { value: context, enumerable: true, configurable: true, writable: true });
      config.current_context = name;
      saveConfig(directory, config);
      return { configured: true, context: name, credential_backend: context.credential_backend, next_steps: ['mongo-cli doctor'] };
    }
    const existing = Object.hasOwn(config.contexts, name) ? config.contexts[name] : defaults;
    const answers = await promptFields([
      { key: 'host', label: 'MongoDB host/IP (no URI)', default: existing.host },
      { key: 'port', label: 'Port', default: String(existing.port) },
      { key: 'database', label: 'Database', default: existing.database },
      { key: 'auth-database', label: 'Authentication database', default: existing.auth_database },
      { key: 'tls', label: 'Use TLS? (yes/no)', default: existing.tls ? 'yes' : 'no' },
      { key: 'auth', label: 'Use username/password authentication? (yes/no)', default: 'yes' }
    ]);
    if (!['yes', 'no'].includes(answers.tls) || !['yes', 'no'].includes(answers.auth)) throw usage('Answer yes or no for TLS and authentication.');
    const context = contextFromFlags({ ...answers, tls: answers.tls === 'yes' }, existing);
    if (answers.auth === 'yes') {
      const credential = await credentialsFromUser();
      context.credential_backend = store.save(accountKey(directory, name, context), credential, options['credential-store'] || 'auto');
    } else context.credential_backend = 'none';
    Object.defineProperty(config.contexts, name, { value: context, enumerable: true, configurable: true, writable: true });
    config.current_context = name;
    saveConfig(directory, config);
    return { configured: true, context: name, credential_backend: context.credential_backend, next_steps: ['mongo-cli doctor'] };
  }
  if (command === 'config set-context') {
    const name = validName(args[0]);
    const config = loadConfig(directory);
    const previous = Object.hasOwn(config.contexts, name) ? config.contexts[name] : {};
    const context = contextFromFlags(options, previous);
    // Keep the backend marker after endpoint changes: its newly scoped key is
    // missing, so reads request login instead of silently trying anonymous auth.
    Object.defineProperty(config.contexts, name, { value: context, enumerable: true, configurable: true, writable: true });
    config.current_context ??= name;
    saveConfig(directory, config);
    return { context: name, ...context, next_steps: ['mongo-cli auth login'] };
  }
  if (command === 'config use-context' || command === 'config delete-context') {
    const name = validName(args[0]);
    const config = loadConfig(directory);
    if (!Object.hasOwn(config.contexts, name)) throw new CLIError('config', 'CONTEXT_NOT_FOUND', 'Context does not exist.', 'List configured contexts.', ['mongo-cli config contexts']);
    if (command === 'config use-context') config.current_context = name;
    else {
      const context = config.contexts[name];
      store.remove(accountKey(directory, name, context), context.credential_backend);
      delete config.contexts[name];
      if (config.current_context === name) config.current_context = Object.keys(config.contexts)[0] || null;
    }
    saveConfig(directory, config);
    return { context: name, action: command.split(' ')[1], current_context: config.current_context };
  }
  // Validate operation, including read-only gating, before opening a credential store or starting the MongoDB worker.
  const isRemote = !command.startsWith('config ') && !command.startsWith('auth ');
  const operation = isRemote ? planOperation(command, args, options) : { command };
  const selected = selectContext(directory, options);
  const { name, context, stored, config } = selected;
  if (command === 'config show') return { directory, context: name, settings: context, read_only: options['read-only'] || process.env.MONGO_CLI_READ_ONLY === '1' || process.env.MONGO_CLI_READ_ONLY === 'true' || !options['allow-writes'] };
  if (operation.write && options['dry-run']) return { dry_run: true, context: name, database: context.database, operation };
  if (command === 'auth logout') {
    store.remove(accountKey(directory, name, stored), stored.credential_backend);
    // Retain the backend marker so subsequent reads report missing credentials
    // rather than silently downgrading to unauthenticated access.
    return { context: name, logged_out: true };
  }
  const timeout = integer(options.timeout ?? 30000, '--timeout (milliseconds)', 100, 600000);
  const maxTimeMS = integer(options['max-time-ms'] ?? Math.min(10000, timeout), '--max-time-ms', 1, timeout);
  const run = credential => runMongo({ context, credential, operation, timeout, maxTimeMS });
  if (command === 'auth login') {
    const credential = await credentialsFromUser();
    if (options.verify) await run(credential);
    stored.credential_backend = store.save(accountKey(directory, name, stored), credential, options['credential-store'] || 'auto');
    config.contexts[name] = stored;
    saveConfig(directory, config);
    return { context: name, stored: true, verified: !!options.verify, credential_backend: stored.credential_backend };
  }
  const credential = resolveCredential(store, directory, name, stored);
  if (command === 'auth status' && !options.verify) return { context: name, available: !!credential, source: process.env.MONGO_CLI_USERNAME ? 'environment' : stored.credential_backend || 'none', verified: false };
  if (command === 'doctor') {
    await run(credential);
    return { ok: true, context: name, database: context.database, driver_version: driverVersion, credentials: credential ? 'available' : 'not_configured', checks: { configuration: 'ok', driver: 'ok', connectivity: 'ok' } };
  }
  const result = await run(credential);
  return command === 'auth status' ? { context: name, available: !!credential, verified: true } : result;
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const parsed = parse(argv);
    if (parsed.help) { process.stdout.write(parsed.help); return 0; }
    const value = await execute(parsed.command, parsed.args, parsed.options);
    if (parsed.command === 'skill show') process.stdout.write(value);
    else emit(value, parsed.options);
    return 0;
  } catch (error) {
    const safe = error instanceof CLIError ? error : new CLIError('internal', 'LOCAL_OPERATION_FAILED', 'A local operation failed.', 'Check filesystem permissions, credential store access and the installed runtime.');
    process.stderr.write(`${JSON.stringify(safe.payload())}\n`);
    return exits[safe.category] || 10;
  }
}
