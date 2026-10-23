import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { privateDirectory } from './io.js';
import { CLIError } from './errors.js';

export function configPaths(home = os.homedir()) {
  return {
    current: path.join(home, '.zhouping', 'mongo'),
    legacy: path.join(home, '.config', 'mongo-cli')
  };
}

export function resolveConfigDirectory(options = {}, env = process.env, home = os.homedir()) {
  // Explicit directories are independent and must never trigger migration.
  if (options.config || env.MONGO_CLI_CONFIG_DIR) return path.resolve(options.config || env.MONGO_CLI_CONFIG_DIR);
  const { current, legacy } = configPaths(home);
  if (!fs.existsSync(current) && fs.existsSync(path.join(legacy, 'config.json'))) {
    const source = fs.lstatSync(legacy);
    if (source.isSymbolicLink() || !source.isDirectory()) throw new CLIError('config', 'UNSAFE_CONFIG_PATH', 'Legacy configuration must be a real directory.', 'Choose the existing directory explicitly with --config.');
    privateDirectory(path.dirname(current));
    try {
      // Move the whole private directory atomically. Credential bytes and
      // filenames stay untouched; keychain entries are not accessed or copied.
      fs.renameSync(legacy, current);
    } catch {
      // Another invocation may have completed migration concurrently.
      if (!fs.existsSync(current)) throw new CLIError('config', 'CONFIG_MIGRATION_FAILED', 'Could not move the existing configuration to ~/.zhouping/mongo.', 'Check filesystem permissions, or use --config with the existing directory.');
    }
  }
  return current;
}

export function credentialIdentityDirectory(directory, home = os.homedir()) {
  const resolved = path.resolve(directory);
  const { current, legacy } = configPaths(home);
  // The renamed default directory is the same credential namespace. Retaining
  // its original hash input keeps file/keychain credentials usable without
  // reading, rewriting or exporting any secrets during migration.
  return resolved === current ? legacy : resolved;
}
