import { isIP } from 'node:net';
import { CLIError } from './errors.js';
import { validateContext } from './config.js';

const invalid = () => new CLIError('usage', 'INVALID_MONGODB_URI', 'Invalid or unsupported MongoDB connection URI.',
  'Check the URI locally, percent-encode special characters in credentials, and use supported connection options. The URI is never echoed.', ['mongo-cli config init --help']);
const supported = new Map([
  ['authsource', 'auth_database'], ['authmechanism', 'auth_mechanism'],
  ['replicaset', 'replica_set'], ['tls', 'tls'], ['ssl', 'tls'],
  ['directconnection', 'direct_connection'], ['tlscafile', 'tls_ca_file'],
  ['tlscertificatekeyfile', 'tls_certificate_key_file']
]);

// Parse a seed list explicitly: WHATWG URL does not support MongoDB's comma
// separated hosts. Never return a raw parser exception, which may contain URI secrets.
export function parseMongoURI(input) {
  try {
    if (typeof input !== 'string' || Buffer.byteLength(input) > 65536) throw invalid();
    const source = input.trim();
    if (/[\s\0]/.test(source) || /%(?![\da-f]{2})/i.test(source)) throw invalid();
    const match = /^(mongodb(?:\+srv)?):\/\/([^/?#]+)(?:\/([^?#]*))?(?:\?([^#]*))?$/.exec(source);
    if (!match) throw invalid();
    const [, scheme, authority, rawDatabase = '', query = ''] = match;
    const at = authority.indexOf('@');
    if (at !== authority.lastIndexOf('@')) throw invalid();
    let credential = null;
    if (at !== -1) {
      const raw = authority.slice(0, at);
      const colon = raw.indexOf(':');
      if (colon < 1 || colon !== raw.lastIndexOf(':') || /[$/\[\]]/.test(raw)) throw invalid();
      credential = { username: decodeURIComponent(raw.slice(0, colon)), password: decodeURIComponent(raw.slice(colon + 1)) };
      if (!credential.username || /\0/.test(credential.username + credential.password)) throw invalid();
    }
    const host = authority.slice(at + 1);
    const seeds = host.split(',');
    const srv = scheme === 'mongodb+srv';
    if (srv && seeds.length !== 1) throw invalid();
    for (const seed of seeds) {
      const parts = seed.startsWith('[') ? /^\[([^\]]+)\](?::(\d+))?$/.exec(seed) : /^([\w.-]+)(?::(\d+))?$/.exec(seed);
      if (!parts || (seed.startsWith('[') && isIP(parts[1]) !== 6)) throw invalid();
      if (parts[2] !== undefined && (Number(parts[2]) < 1 || Number(parts[2]) > 65535)) throw invalid();
      if (srv && (parts[2] !== undefined || isIP(parts[1]) || seed.startsWith('['))) throw invalid();
    }
    const database = rawDatabase ? decodeURIComponent(rawDatabase) : 'test';
    const context = { host, database, srv, tls: srv };
    const seen = new Set();
    // Match driver semantics: option names are case-insensitive, values are not.
    // Normalize supported aliases before detecting duplicates and reject all
    // unknown options instead of dropping flags or persisting a secret option.
    if (query) for (const part of query.split(/[&;]/)) {
      const equal = part.indexOf('=');
      if (equal < 1) throw invalid();
      const decodeQuery = text => decodeURIComponent(text.replace(/\+/g, ' '));
      const key = supported.get(decodeQuery(part.slice(0, equal)).toLowerCase());
      const value = decodeQuery(part.slice(equal + 1));
      if (!key || seen.has(key) || !value) throw invalid();
      seen.add(key);
      if (['tls', 'direct_connection'].includes(key)) {
        if (!['true', 'false'].includes(value)) throw invalid();
        context[key] = value === 'true';
      } else context[key] = value;
    }
    if (context.auth_mechanism === 'DEFAULT') delete context.auth_mechanism;
    context.auth_database ??= context.auth_mechanism === 'PLAIN' ? '$external' : rawDatabase ? database : 'admin';
    // SRV always uses TLS in this CLI; do not silently change an explicit false.
    if (srv && !context.tls) throw invalid();
    return { context: validateContext(context), credential };
  } catch { throw invalid(); }
}
