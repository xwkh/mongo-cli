const strings = names => Object.fromEntries(names.split(' ').filter(Boolean).map(name => [name, { type: 'string' }]));
const booleans = names => Object.fromEntries(names.split(' ').filter(Boolean).map(name => [name, { type: 'boolean' }]));
const input = names => strings(names.flatMap(name => [name, `${name}-file`]).join(' '));
const connection = { ...strings('host port auth-database auth-mechanism replica-set tls-ca-file tls-certificate-key-file'), ...booleans('tls direct-connection srv') };
const filter = input(['filter']);
const write = booleans('dry-run');
const page = strings('limit skip');

export const globals = { ...strings('config use-context database format fields timeout max-time-ms mongosh'), ...booleans('help pretty allow-writes read-only version') };
export const specs = {
  version: { description: 'Show CLI and runtime version.', args: 0 },
  doctor: { description: 'Check mongosh, local configuration, credentials and MongoDB connectivity.', args: 0 },
  ping: { description: 'Ping the selected MongoDB connection.', args: 0 },
  'config init': { description: 'Choose URI (default) or step-by-step setup. Skip the choice with --from-uri or --step-by-step; automation can use --uri-stdin.', args: 0, options: { ...strings('name credential-store'), ...booleans('from-uri step-by-step uri-stdin') } },
  'config show': { description: 'Show selected non-secret connection settings.', args: 0 },
  'config contexts': { description: 'List configured connection aliases.', args: 0 },
  'config set-context': { description: 'Create/update non-secret settings. Endpoint changes require another login.', args: 1, operand: '<name>', options: connection },
  'config use-context': { description: 'Select the default connection.', args: 1, operand: '<name>' },
  'config delete-context': { description: 'Remove a local context and its credentials.', args: 1, operand: '<name>' },
  'auth login': { description: 'Store credentials from a terminal prompt or private environment. Use --verify to ping first.', args: 0, options: { ...strings('credential-store'), ...booleans('verify') } },
  'auth status': { description: 'Report credential availability without showing identity or secrets; --verify also connects.', args: 0, options: booleans('verify') },
  'auth logout': { description: 'Delete the selected context credentials.', args: 0 },
  'skill install': { description: 'Install the bundled MongoDB skill for Codex, Claude, Cursor or shared Agents.', args: 0, options: { ...strings('agent dir'), ...booleans('project force') } },
  'skill status': { description: 'Inspect installed and bundled skill versions.', args: 0, options: { ...strings('agent dir'), ...booleans('project') } },
  'skill path': { description: 'Show companion skill paths.', args: 0, options: { ...strings('agent dir'), ...booleans('project') } },
  'skill show': { description: 'Print the bundled SKILL.md.', args: 0 },
  'db list': { description: 'List databases authorized for the configured account.', args: 0 },
  'db stats': { description: 'Inspect selected database statistics.', args: 0 },
  'collection list': { description: 'List collection names and types.', args: 0 },
  'collection stats': { description: 'Inspect collection statistics.', args: 1, operand: '<collection>' },
  'collection schema': { description: 'Infer top-level fields/types from a bounded sample; results are not a validator.', args: 1, operand: '<collection>', options: strings('sample') },
  'collection create': { description: 'Create a collection (write).', args: 1, operand: '<collection>', options: write },
  'collection drop': { description: 'Drop a collection (write); requires --confirm with the collection name.', args: 1, operand: '<collection>', options: { ...write, ...strings('confirm') } },
  'index list': { description: 'List indexes on a collection.', args: 1, operand: '<collection>' },
  'index create': { description: 'Create an index (write).', args: 1, operand: '<collection>', options: { ...write, ...input(['keys']), ...strings('name'), ...booleans('unique sparse') } },
  'index drop': { description: 'Drop a named index (write).', args: 2, operand: '<collection> <index>', options: write },
  'document find': { description: 'Read documents with bounded pagination. Default sort is _id ascending.', args: 1, operand: '<collection>', options: { ...filter, ...input(['projection', 'sort']), ...page } },
  'document count': { description: 'Count documents matching a filter.', args: 1, operand: '<collection>', options: filter },
  'document distinct': { description: 'Return a bounded page of unique field values via aggregation.', args: 1, operand: '<collection>', options: { ...filter, ...strings('key'), ...page } },
  'document aggregate': { description: 'Run a bounded read-only aggregation pipeline. $out/$merge and server JavaScript are rejected.', args: 1, operand: '<collection>', options: { ...input(['pipeline']), ...page } },
  'document explain': { description: 'Explain a find query with queryPlanner verbosity.', args: 1, operand: '<collection>', options: { ...filter, ...input(['sort']), ...strings('limit') } },
  'document insert': { description: 'Insert one document or an array of documents (write).', args: 1, operand: '<collection>', options: { ...write, ...input(['document']) } },
  'document update': { description: 'Update one document, or --many matching documents (write).', args: 1, operand: '<collection>', options: { ...write, ...filter, ...input(['update']), ...booleans('many upsert all') } },
  'document replace': { description: 'Replace one matching document (write).', args: 1, operand: '<collection>', options: { ...write, ...filter, ...input(['document']), ...booleans('upsert all') } },
  'document delete': { description: 'Delete one document, or --many matching documents (write).', args: 1, operand: '<collection>', options: { ...write, ...filter, ...booleans('many all') } }
};

export function help(command) {
  const spec = specs[command];
  if (spec) {
    return `mongo-cli ${command}${spec.operand ? ` ${spec.operand}` : ''}\n\n${spec.description}\n\nOptions:\n${Object.entries({ ...globals, ...spec.options }).map(([name, definition]) => `  --${name}${definition.type === 'string' ? ' <value>' : ''}`).join('\n')}\n\nJSON inputs also accept --<name>-file <path|->. Use Extended JSON for BSON types.\n`;
  }
  return `mongo-cli — MongoDB for coding agents (mongosh backend)\n\nUsage: mongo-cli <noun> <verb> [options]\n\n${Object.entries(specs).filter(([name]) => !command || name.startsWith(`${command} `)).map(([name, s]) => `  ${name.padEnd(24)} ${s.description}`).join('\n')}\n\nGlobal options:\n${Object.entries(globals).map(([name, d]) => `  --${name}${d.type === 'string' ? ' <value>' : ''}`).join('\n')}\n\nJSON stdout; structured JSON errors on stderr. Writes require --allow-writes.\nStart: mongo-cli config init → mongo-cli doctor → mongo-cli db list\nAgent usage: load the companion skill with mongo-cli skill show.\n`;
}
