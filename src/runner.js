import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CLIError, remoteError } from './errors.js';

const worker = fileURLToPath(new URL('./worker.cjs', import.meta.url));
const prefix = '__MONGO_CLI_RESPONSE__';

export function mongoshVersion(executable = 'mongosh') {
  const r = spawnSync(executable, ['--version'], { encoding: 'utf8', timeout: 10000, maxBuffer: 65536, windowsHide: true });
  if (r.error || r.status !== 0 || !/^\d+\.\d+\.\d+/.test(r.stdout.trim())) throw new CLIError('dependency', 'MONGOSH_UNAVAILABLE', 'A working mongosh executable was not found.', 'Install mongosh, put it on PATH, or set MONGO_CLI_MONGOSH.');
  return r.stdout.trim();
}

function outcome(error, operation) {
  if (operation.write && ['network', 'timeout', 'internal'].includes(error.category)) {
    error.retryable = false;
    error.hint = 'The write outcome may be unknown or partial. Inspect the affected documents before retrying; the CLI does not retry writes.';
  }
  return error;
}

export async function runMongo({ context, credential, operation, executable = 'mongosh', timeout = 30000, maxTimeMS = 10000, spawnProcess = spawn, env = process.env }) {
  return new Promise((resolve, reject) => {
    // Credentials are sent through a private anonymous stdin pipe. Strip inherited
    // credential env vars so mongosh diagnostics cannot accidentally dump them.
    const childEnv = Object.fromEntries(Object.entries(env).filter(([key]) => !/^MONGO_CLI_(USERNAME|PASSWORD)$/.test(key)));
    const child = spawnProcess(executable, ['--nodb', '--norc', '--quiet', '--file', worker], { stdio: ['pipe', 'pipe', 'pipe'], env: childEnv, windowsHide: true });
    child.stdout.setEncoding('utf8');
    let stdout = '', size = 0, failure, killTimer;
    const stop = error => {
      if (failure) return;
      failure = error;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 500);
      killTimer.unref();
    };
    const timer = setTimeout(() => stop(new CLIError('timeout', 'PROCESS_TIMEOUT', 'mongosh exceeded the process deadline.', 'Narrow the query or increase --timeout.', [], true)), timeout);
    const onInterrupt = () => stop(new CLIError('internal', 'INTERRUPTED', 'MongoDB operation interrupted.', 'Check whether the operation completed before retrying.'));
    process.once('SIGINT', onInterrupt);
    process.once('SIGTERM', onInterrupt);
    child.stdout.on('data', chunk => {
      size += Buffer.byteLength(chunk);
      if (size > 16 * 1024 * 1024) stop(new CLIError('query', 'OUTPUT_TOO_LARGE', 'MongoDB response exceeded 16 MiB.', 'Use a smaller --limit, a projection, or a narrower aggregation.'));
      else stdout += chunk.toString();
    });
    // Drain but never forward raw stderr; it can include a URI or server data.
    child.stderr.on('data', chunk => {
      size += chunk.length;
      if (size > 16 * 1024 * 1024) stop(new CLIError('internal', 'SHELL_OUTPUT_LIMIT', 'mongosh exceeded the diagnostic output limit.', 'Run mongo-cli doctor.'));
    });
    child.on('error', () => { failure = new CLIError('dependency', 'MONGOSH_UNAVAILABLE', 'Could not start mongosh.', 'Check PATH or MONGO_CLI_MONGOSH.'); });
    child.stdin.on('error', () => {}); // Close reports an early shell failure safely.
    child.on('close', code => {
      clearTimeout(timer); clearTimeout(killTimer);
      process.removeListener('SIGINT', onInterrupt); process.removeListener('SIGTERM', onInterrupt);
      if (failure) return reject(outcome(failure, operation));
      const line = stdout.split(/\r?\n/).filter(s => s.startsWith(prefix)).at(-1);
      let response;
      try { response = JSON.parse(line?.slice(prefix.length)); } catch { /* Sanitized error below. */ }
      if (!response || code !== 0) return reject(outcome(new CLIError('internal', 'INVALID_SHELL_RESPONSE', 'mongosh did not return a valid structured response.', 'Verify your mongosh installation with mongo-cli doctor.'), operation));
      if (!response.ok) return reject(outcome(remoteError(response.error), operation));
      resolve(response.result);
    });
    child.stdin.end(JSON.stringify({ context, credential, operation, timeout, max_time_ms: maxTimeMS }));
  });
}
