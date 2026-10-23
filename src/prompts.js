import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { CLIError } from './errors.js';

export async function promptFields(fields) {
  if (!process.stdin.isTTY || !process.stderr.isTTY) throw new CLIError('config', 'INTERACTIVE_REQUIRED', 'This command needs your own interactive terminal.', 'Run the command locally. For automation, configure non-secret settings with config set-context and supply credentials through a private environment.');
  let hidden = false;
  const output = new Writable({ write(chunk, encoding, done) { if (!hidden) process.stderr.write(chunk); done(); } });
  const terminal = createInterface({ input: process.stdin, output, terminal: true });
  let interrupted = false;
  terminal.on('SIGINT', () => { interrupted = true; terminal.close(); });
  const values = {};
  try {
    for (const field of fields) {
      hidden = !!field.secret;
      const label = `${field.label}${field.default !== undefined ? ` [${field.default}]` : ''}: `;
      if (hidden) process.stderr.write(label);
      let value;
      try { value = await terminal.question(hidden ? '' : label); }
      catch { throw new CLIError('config', 'SETUP_CANCELLED', 'Local configuration was cancelled.', 'Run the command again in your terminal.'); }
      if (interrupted) throw new CLIError('config', 'SETUP_CANCELLED', 'Local configuration was cancelled.', 'Run the command again in your terminal.');
      if (hidden) process.stderr.write('\n');
      values[field.key] = value === '' && field.default !== undefined ? field.default : value;
    }
    return values;
  } finally { terminal.close(); }
}
