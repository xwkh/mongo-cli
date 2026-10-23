export const exits = { usage: 2, config: 3, auth: 4, permission: 5, not_found: 6, network: 7, timeout: 8, dependency: 9, internal: 10, query: 11 };

export class CLIError extends Error {
  constructor(category, code, message, hint, nextSteps = [], retryable = false) {
    super(message);
    Object.assign(this, { category, code, hint, next_steps: nextSteps, retryable });
  }
  payload() {
    return { error: { category: this.category, code: this.code, message: this.message,
      hint: this.hint || 'Run mongo-cli --help for supported commands.',
      next_steps: this.next_steps, retryable: this.retryable } };
  }
}

export function usage(message, code = 'BAD_ARGUMENT') {
  return new CLIError('usage', code, message, 'Use JSON or Extended JSON, and check the command help.', ['mongo-cli --help']);
}

// Never echo a raw driver error: MongoDB errors can contain an authenticated URI.
export function remoteError(error = {}) {
  const code = Number(error.code);
  const name = String(error.name || '');
  if (code === 18 || /Authentication|AuthError/i.test(name)) return new CLIError('auth', 'AUTHENTICATION_FAILED', 'MongoDB authentication failed.', 'Check the credentials and auth database locally.', ['mongo-cli auth login', 'mongo-cli doctor']);
  if (code === 13) return new CLIError('permission', 'PERMISSION_DENIED', 'MongoDB denied this operation.', 'Use an account with the required database permissions.');
  if (code === 26) return new CLIError('not_found', 'NAMESPACE_NOT_FOUND', 'The database collection was not found.', 'Discover collection names first.', ['mongo-cli collection list']);
  if (code === 50 || /Timeout|TimeLimit/i.test(name)) return new CLIError('timeout', 'QUERY_TIMEOUT', 'MongoDB operation exceeded its time limit.', 'Narrow the query or increase --max-time-ms.', [], true);
  if (code === 11000) return new CLIError('query', 'DUPLICATE_KEY', 'A unique index rejected a duplicate value.', 'Check the document and collection indexes.');
  if (/ServerSelection|Network|TLS|Topology/i.test(name)) return new CLIError('network', 'CONNECTION_FAILED', 'Could not connect to MongoDB.', 'Check the host, port, TLS settings, network and replica set.', ['mongo-cli config show', 'mongo-cli doctor'], true);
  if (name === 'MongoCompatibilityError') return new CLIError('network', 'SERVER_INCOMPATIBLE', 'The MongoDB server is incompatible with the bundled driver.', 'Check the server version against the driver compatibility documentation.');
  if (name === 'MongoParseError' || name === 'MongoInvalidArgumentError') return new CLIError('config', 'INVALID_CONNECTION_OPTIONS', 'MongoDB connection options are invalid.', 'Check the authentication mechanism, seed hosts and TLS configuration locally.');
  if (name === 'BSONError' || name === 'BSONTypeError') return usage('Invalid MongoDB Extended JSON value.', 'BAD_EJSON');
  return new CLIError('query', 'MONGO_OPERATION_FAILED', `MongoDB rejected the operation${Number.isFinite(code) ? ` (server code ${code})` : ''}.`, 'Check query syntax, server version, collection names and permissions.');
}
