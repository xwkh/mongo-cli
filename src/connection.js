import { createRequire } from 'node:module';

export const driverVersion = createRequire(import.meta.url)('mongodb/package.json').version;

// Keep credentials out of the URI, argv and filesystem. The driver receives
// decoded credentials separately, including PLAIN passwords with special chars.
export function connectionOptions(context, credential, timeout) {
  let hosts = context.host;
  if (!context.srv) {
    if (!hosts.includes(',') && !hosts.startsWith('[') && (hosts.match(/:/g) || []).length > 1) hosts = `[${hosts}]`;
    hosts = hosts.split(',').map(host => /\]:\d+$/.test(host) || (!host.startsWith('[') && /:\d+$/.test(host)) ? host : `${host}:${context.port}`).join(',');
  }
  return {
    uri: `mongodb${context.srv ? '+srv' : ''}://${hosts}/${encodeURIComponent(context.database)}`,
    options: {
      appName: 'mongo-cli', authSource: context.auth_database,
      ...(credential ? { auth: { username: credential.username, password: credential.password } } : {}),
      ...(context.auth_mechanism ? { authMechanism: context.auth_mechanism } : {}),
      tls: !!(context.tls || context.srv),
      ...(context.direct_connection ? { directConnection: true } : {}),
      ...(context.replica_set ? { replicaSet: context.replica_set } : {}),
      ...(context.tls_ca_file ? { tlsCAFile: context.tls_ca_file } : {}),
      ...(context.tls_certificate_key_file ? { tlsCertificateKeyFile: context.tls_certificate_key_file } : {}),
      serverSelectionTimeoutMS: Math.min(timeout, 15000), connectTimeoutMS: Math.min(timeout, 15000),
      retryWrites: false, retryReads: false, promoteLongs: false,
      // A CLI operation needs only one application connection.
      maxPoolSize: 1, minPoolSize: 0,
      mongodbLogComponentSeverities: { default: 'off' }
    }
  };
}
