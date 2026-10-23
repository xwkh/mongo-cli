import path from 'node:path';
import { atomicJSON, readJSON } from './io.js';
import { CLIError, usage } from './errors.js';
import { resolveConfigDirectory } from './locations.js';

export const defaults = { host: '127.0.0.1', port: 27017, database: 'test', auth_database: 'admin', tls: false, direct_connection: false, srv: false };
const contextKeys = new Set([...Object.keys(defaults), 'auth_mechanism', 'replica_set', 'tls_ca_file', 'tls_certificate_key_file', 'credential_backend']);
export const contextFlags = { host: 'host', port: 'port', database: 'database', 'auth-database': 'auth_database', 'auth-mechanism': 'auth_mechanism', tls: 'tls', 'direct-connection': 'direct_connection', srv: 'srv', 'replica-set': 'replica_set', 'tls-ca-file': 'tls_ca_file', 'tls-certificate-key-file': 'tls_certificate_key_file' };

export const configDirectory = resolveConfigDirectory;

export function validName(name) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(name || '')) throw usage('Context name must use 1–64 letters, digits, dots, underscores or hyphens.');
  return name;
}

export function validateContext(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw usage('Context must be an object.');
  for (const key of Object.keys(value)) if (!contextKeys.has(key)) throw usage('Unsupported context field; credentials belong in the credential store.');
  const c = { ...defaults, ...value };
  // Accept a DNS name, IPv4, bracketed/bare IPv6, or comma-separated seed hosts.
  if (typeof c.host !== 'string' || !c.host || /[\s/@?#\\%]/.test(c.host) || !/^[a-zA-Z0-9.:[\],_-]+$/.test(c.host)) throw usage('Host must be a hostname/IP or comma-separated seed hosts, without a URI or credentials.');
  if (!Number.isInteger(c.port) || c.port < 1 || c.port > 65535) throw usage('Port must be an integer from 1 to 65535.');
  for (const key of ['database', 'auth_database']) {
    if (key === 'auth_database' && c[key] === '$external') continue;
    if (typeof c[key] !== 'string' || !c[key] || /[\0/\\ "$.]/.test(c[key])) throw usage('Database names contain unsupported characters.');
  }
  if (c.auth_mechanism !== undefined && !['SCRAM-SHA-1', 'SCRAM-SHA-256', 'PLAIN'].includes(c.auth_mechanism)) throw usage('Supported auth mechanisms are DEFAULT, SCRAM-SHA-1, SCRAM-SHA-256 and PLAIN.');
  if (c.auth_mechanism === 'PLAIN' && c.auth_database !== '$external') throw usage('PLAIN authentication requires the $external auth database.');
  for (const key of ['tls', 'direct_connection', 'srv']) if (typeof c[key] !== 'boolean') throw usage('TLS, direct connection and SRV settings must be booleans.');
  if (c.replica_set !== undefined && (typeof c.replica_set !== 'string' || !c.replica_set)) throw usage('Replica set name must be nonempty.');
  for (const key of ['tls_ca_file', 'tls_certificate_key_file']) if (c[key] !== undefined && (typeof c[key] !== 'string' || !c[key])) throw usage('TLS file paths must be nonempty strings.');
  if (c.srv && (c.host.includes(':') || c.host.includes(',') || c.direct_connection || c.port !== 27017)) throw usage('SRV requires one DNS hostname, the default port setting and no direct connection.');
  if (c.credential_backend !== undefined && !['keychain', 'file', 'none'].includes(c.credential_backend)) throw usage('Unknown credential backend.');
  return c;
}

export function loadConfig(directory) {
  const config = readJSON(path.join(directory, 'config.json'), { version: 1, current_context: null, contexts: {} });
  if (config?.version !== 1 || !config.contexts || typeof config.contexts !== 'object' || Array.isArray(config.contexts)) throw new CLIError('config', 'INVALID_CONFIG', 'Unsupported configuration format.', 'Use a version 1 configuration created by mongo-cli config init.');
  for (const [name, context] of Object.entries(config.contexts)) {
    try { validName(name); validateContext(context); }
    catch { throw new CLIError('config', 'INVALID_CONFIG', 'Invalid context configuration.', 'Check the local configuration fields. Secrets must be stored separately.'); }
  }
  if (config.current_context !== null && !Object.hasOwn(config.contexts, config.current_context)) throw new CLIError('config', 'INVALID_CONFIG', 'Current context does not exist.', 'Select an existing context.');
  return config;
}

export function saveConfig(directory, config) { atomicJSON(path.join(directory, 'config.json'), config); }

export function contextFromFlags(options, previous = {}) {
  const value = { ...previous };
  for (const [flag, key] of Object.entries(contextFlags)) if (options[flag] !== undefined) value[key] = flag === 'port' ? integer(options[flag], '--port', 1, 65535) : options[flag];
  if (value.auth_mechanism === 'DEFAULT') delete value.auth_mechanism;
  return validateContext(value);
}

export function selectContext(directory, options = {}, env = process.env) {
  const config = loadConfig(directory);
  const name = options['use-context'] || env.MONGO_CLI_CONTEXT || config.current_context;
  if (!name || !Object.hasOwn(config.contexts, name)) throw new CLIError('config', 'CONTEXT_NOT_FOUND', 'No matching MongoDB context is configured.', 'Configure a connection locally, or select an existing context.', ['mongo-cli config init', 'mongo-cli config contexts']);
  const stored = validateContext(config.contexts[name]);
  // Only database is a per-call override; endpoint changes require a new context/login.
  const context = validateContext({ ...stored, ...(options.database !== undefined ? { database: options.database } : {}) });
  return { config, name, context, stored };
}

export function integer(value, label, minimum, maximum) {
  if (!/^\d+$/.test(String(value))) throw usage(`${label} must be an integer.`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) throw usage(`${label} must be between ${minimum} and ${maximum}.`);
  return number;
}
