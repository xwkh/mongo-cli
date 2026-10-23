import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { CLIError, usage } from './errors.js';

export function privateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new CLIError('config', 'UNSAFE_CONFIG_PATH', 'Configuration directory must be a real directory.', 'Choose a private directory with --config.');
  if (process.platform !== 'win32') fs.chmodSync(directory, 0o700);
}

export function atomicJSON(file, value) {
  privateDirectory(path.dirname(file));
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
}

export function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT' && fallback !== undefined) return structuredClone(fallback);
    throw new CLIError('config', 'INVALID_CONFIG', 'Cannot read a valid JSON configuration file.', 'Check file permissions and JSON syntax locally; do not paste credentials into chat.');
  }
}

export function jsonInput(options, name, { required = false, fallback } = {}) {
  const inline = options[name];
  const file = options[`${name}-file`];
  if (inline !== undefined && file !== undefined) throw usage(`Use either --${name} or --${name}-file.`);
  if (inline === undefined && file === undefined) {
    if (required) throw usage(`--${name} or --${name}-file is required.`);
    return structuredClone(fallback);
  }
  let source = inline;
  if (file !== undefined) {
    try { source = fs.readFileSync(file === '-' ? 0 : file, 'utf8'); }
    catch { throw usage(`Cannot read --${name}-file.`, 'INPUT_FILE_UNREADABLE'); }
  }
  if (Buffer.byteLength(source) > 8 * 1024 * 1024) throw usage('JSON input must be at most 8 MiB.');
  try { return JSON.parse(source); }
  catch { throw usage(`--${name} must contain valid JSON or Extended JSON.`, 'BAD_JSON'); }
}

function projection(value, fields) {
  const out = Object.create(null);
  for (const field of fields) {
    const keys = field.split('.');
    let source = value;
    for (const key of keys) source = source != null && Object.hasOwn(source, key) ? source[key] : undefined;
    if (source === undefined) continue;
    let target = out;
    for (const key of keys.slice(0, -1)) {
      if (target[key] === null || typeof target[key] !== 'object') target[key] = Object.create(null);
      target = target[key] ??= Object.create(null);
    }
    target[keys.at(-1)] = source;
  }
  return out;
}

export function emit(value, options = {}, stdout = process.stdout, stderr = process.stderr) {
  if (options.fields) {
    const fields = options.fields.split(',');
    value = Array.isArray(value.items) ? { ...value, items: value.items.map(item => projection(item, fields)) } : projection(value, fields);
  }
  const stringify = v => JSON.stringify(v, null, options.pretty ? 2 : undefined);
  if (options.format === 'ndjson') {
    for (const item of Array.isArray(value.items) ? value.items : [value]) stdout.write(`${JSON.stringify(item)}\n`);
    if (value.has_more) stderr.write(`${JSON.stringify({ _notice: { pagination: { has_more: true, next: value.next, hint: 'Repeat the same query and sort with --skip set to next. Concurrent changes may shift offset pages.' } } })}\n`);
  } else stdout.write(`${stringify(value)}\n`);
}
