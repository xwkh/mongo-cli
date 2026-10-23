import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { atomicJSON } from './io.js';
import { CLIError } from './errors.js';
import { credentialIdentityDirectory } from './locations.js';

const service = 'mongo-cli';
const inaccessible = () => new CLIError('auth', 'CREDENTIAL_STORE_INACCESSIBLE', 'The local credential store is inaccessible.', 'Run in the same host user session that configured mongo-cli. Do not paste credentials into chat.', ['mongo-cli auth status']);

export function accountKey(directory, name, context, home) {
  // Scope credentials to both config location and endpoint. Changing hosts never forwards an old password.
  const identity = [credentialIdentityDirectory(directory, home), name, context.host, context.port, context.auth_database, context.replica_set, context.srv, context.tls, context.direct_connection, context.tls_ca_file, context.tls_certificate_key_file];
  // Preserve 0.1.0 credential keys for existing default-mechanism connections.
  if (context.auth_mechanism !== undefined) identity.push(context.auth_mechanism);
  return crypto.createHash('sha256').update(JSON.stringify(identity)).digest('hex');
}

export class CredentialStore {
  constructor(directory, { platform = process.platform, run = spawnSync } = {}) { Object.assign(this, { directory, platform, run }); }
  file(key) { return path.join(this.directory, 'credentials', `${key}.json`); }
  security(args, input) { return this.run('/usr/bin/security', args, { input, encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024, windowsHide: true }); }
  save(key, credential, backend = 'auto') {
    if (!credential || typeof credential.username !== 'string' || !credential.username || typeof credential.password !== 'string') throw inaccessible();
    if (!['auto', 'file', 'keychain'].includes(backend)) throw inaccessible();
    if (backend !== 'file' && this.platform === 'darwin') {
      const probe = this.security(['default-keychain', '-d', 'user']);
      if (probe.status === 0) {
        // security -i reads commands from stdin; base64 is safe for its command lexer.
        // No secret is ever an OS command-line argument, including during setup.
        const encoded = Buffer.from(JSON.stringify(credential)).toString('base64');
        const result = this.security(['-i'], `add-generic-password -U -s ${service} -a ${key} -w ${encoded}\n`);
        // Interactive security can exit zero even when its subcommand failed.
        if (result.status === 0 && !/SecKeychain|error:|failed|denied/i.test(result.stderr || '')) return 'keychain';
        throw inaccessible();
      }
      if (backend === 'keychain') throw inaccessible();
    } else if (backend === 'keychain') throw inaccessible();
    if (this.platform === 'win32') throw new CLIError('config', 'CREDENTIAL_BACKEND_UNSUPPORTED', 'File credential storage on Windows is not supported.', 'Use MONGO_CLI_USERNAME and MONGO_CLI_PASSWORD in a private process environment.');
    atomicJSON(this.file(key), credential);
    return 'file';
  }
  load(key, backend) {
    if (!backend || backend === 'none') return null;
    let credential;
    if (backend === 'keychain') {
      const result = this.security(['find-generic-password', '-s', service, '-a', key, '-w']);
      if (result.status === 44) return null;
      if (result.status !== 0 || result.error) throw inaccessible();
      try { credential = JSON.parse(Buffer.from(result.stdout.trim(), 'base64').toString('utf8')); } catch { throw inaccessible(); }
    } else {
      try {
        const file = this.file(key);
        // O_NOFOLLOW also prevents a check/open race for the secret file.
        const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
        try {
          const stat = fs.fstatSync(fd);
          if (!stat.isFile() || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) throw inaccessible();
          const parent = fs.lstatSync(path.dirname(file));
          if (parent.isSymbolicLink() || (parent.mode & 0o077) !== 0) throw inaccessible();
          credential = JSON.parse(fs.readFileSync(fd, 'utf8'));
        } finally { fs.closeSync(fd); }
      } catch (error) { if (error.code === 'ENOENT') return null; throw inaccessible(); }
    }
    if (!credential || typeof credential.username !== 'string' || !credential.username || typeof credential.password !== 'string') throw inaccessible();
    return credential;
  }
  remove(key, backend) {
    if (backend === 'keychain') {
      const result = this.security(['delete-generic-password', '-s', service, '-a', key]);
      if (result.status !== 0 && result.status !== 44) throw inaccessible();
    } else if (backend === 'file') fs.rmSync(this.file(key), { force: true });
  }
}

export function resolveCredential(store, directory, name, context, env = process.env) {
  const username = env.MONGO_CLI_USERNAME;
  const password = env.MONGO_CLI_PASSWORD;
  if (username !== undefined || password !== undefined) {
    if (!username || password === undefined) throw new CLIError('auth', 'INCOMPLETE_ENV_CREDENTIALS', 'Both credential environment variables are required.', 'Set MONGO_CLI_USERNAME and MONGO_CLI_PASSWORD together in a private environment.');
    return { username, password };
  }
  const credential = store.load(accountKey(directory, name, context), context.credential_backend);
  if (!credential && context.credential_backend && context.credential_backend !== 'none') throw new CLIError('auth', 'CREDENTIAL_NOT_FOUND', 'No credentials were found for this connection.', 'Log in locally for the selected context.', ['mongo-cli auth login']);
  return credential;
}
