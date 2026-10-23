import { jsonInput } from './io.js';
import { integer } from './config.js';
import { CLIError, usage } from './errors.js';

const readStages = new Set('$addFields $bucket $bucketAuto $collStats $count $densify $documents $facet $fill $geoNear $graphLookup $group $indexStats $limit $lookup $match $project $redact $replaceRoot $replaceWith $sample $search $searchMeta $set $setWindowFields $skip $sort $sortByCount $unionWith $unset $unwind $vectorSearch'.split(' '));

function object(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw usage(`${label} must be a JSON object.`);
  return value;
}

function rejectCode(value) {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (['$where', '$function', '$accumulator', '$code', '$out', '$merge'].includes(key)) throw usage('Server JavaScript and write aggregation stages are not supported.', 'UNSAFE_QUERY');
    rejectCode(child);
  }
}

function validatePipeline(pipeline) {
  if (!Array.isArray(pipeline)) throw usage('Pipeline must be a JSON array.');
  for (const stage of pipeline) {
    object(stage, 'Each pipeline stage');
    const keys = Object.keys(stage);
    if (keys.length !== 1 || !readStages.has(keys[0])) throw usage('Unsupported or mutating aggregation stage.', 'UNSAFE_PIPELINE');
    if (stage.$facet) for (const branch of Object.values(object(stage.$facet, '$facet'))) validatePipeline(branch);
    for (const key of ['$lookup', '$unionWith']) if (stage[key]?.pipeline !== undefined) validatePipeline(stage[key].pipeline);
  }
  rejectCode(pipeline);
}

export function planOperation(command, args, options, env = process.env) {
  const operation = { command, collection: args[0] };
  if (args[0] !== undefined && (!args[0] || args[0].includes('\0') || args[0].startsWith('system.'))) throw usage('Use a nonempty, non-system collection name.');
  const hasFilter = options.filter !== undefined || options['filter-file'] !== undefined;
  const readsFilter = ['document find', 'document count', 'document distinct', 'document explain', 'document update', 'document replace', 'document delete'].includes(command);
  if (readsFilter) operation.filter = object(jsonInput(options, 'filter', { fallback: {} }), 'Filter');
  if (command.startsWith('document ') && ['find', 'distinct', 'aggregate', 'explain'].includes(command.split(' ')[1])) {
    operation.limit = integer(options.limit ?? 20, '--limit', 1, 1000);
    operation.skip = integer(options.skip ?? 0, '--skip', 0, 1000000);
  }
  if (['document find', 'document explain'].includes(command)) {
    operation.sort = object(jsonInput(options, 'sort', { fallback: { _id: 1 } }), 'Sort');
    if (!Object.keys(operation.sort).length || Object.values(operation.sort).some(v => v !== 1 && v !== -1)) throw usage('Sort must contain fields with direction 1 or -1.');
    // Tie-break equal sort values so offset pages have a deterministic order.
    if (!Object.hasOwn(operation.sort, '_id')) operation.sort._id = 1;
    if (command === 'document find') operation.projection = object(jsonInput(options, 'projection', { fallback: {} }), 'Projection');
  }
  if (command === 'document aggregate') {
    operation.pipeline = jsonInput(options, 'pipeline', { required: true });
    validatePipeline(operation.pipeline);
  }
  if (command === 'document distinct') {
    if (!options.key || options.key.startsWith('$') || options.key.includes('\0')) throw usage('--key requires a MongoDB field path.');
    operation.key = options.key;
  }
  if (command === 'collection schema') operation.sample = integer(options.sample ?? 100, '--sample', 1, 1000);
  const writes = new Set(['document insert', 'document update', 'document replace', 'document delete', 'collection create', 'collection drop', 'index create', 'index drop']);
  operation.write = writes.has(command);
  if (['document insert', 'document replace'].includes(command)) {
    operation.document = jsonInput(options, 'document', { required: true });
    if (command === 'document insert' && Array.isArray(operation.document)) {
      if (!operation.document.length || operation.document.length > 1000) throw usage('Insert requires 1–1000 documents.');
      operation.document.forEach(v => object(v, 'Document'));
    } else object(operation.document, 'Document');
    if (command === 'document replace' && Object.keys(operation.document).some(k => k.startsWith('$'))) throw usage('Replacement document must not use update operators.');
  }
  if (['document update', 'document replace', 'document delete'].includes(command)) {
    if (!hasFilter) throw usage('Writes require an explicit --filter or --filter-file.');
    if (!Object.keys(operation.filter).length && !options.all) throw usage('An empty write filter requires --all.', 'EMPTY_WRITE_FILTER');
    operation.many = !!options.many;
    operation.upsert = !!options.upsert;
  }
  if (command === 'document update') {
    operation.update = object(jsonInput(options, 'update', { required: true }), 'Update');
    if (!Object.keys(operation.update).length || Object.keys(operation.update).some(k => !k.startsWith('$'))) throw usage('Use update operators such as $set; use document replace for a replacement.');
  }
  if (command === 'collection drop' && options.confirm !== args[0]) throw usage('--confirm must exactly match the collection name.', 'CONFIRMATION_REQUIRED');
  if (command === 'index create') {
    operation.keys = object(jsonInput(options, 'keys', { required: true }), 'Index keys');
    if (!Object.keys(operation.keys).length) throw usage('Index keys must not be empty.');
    operation.index_options = { ...(options.name ? { name: options.name } : {}), unique: !!options.unique, sparse: !!options.sparse };
  }
  if (command === 'index drop') {
    if (args[1] === '*' || args[1] === '_id_') throw usage('Dropping all indexes or the _id index is not supported.');
    operation.index = args[1];
  }
  rejectCode(operation);
  if (operation.write && !options['dry-run']) {
    if (options['read-only'] || env.MONGO_CLI_READ_ONLY === '1' || env.MONGO_CLI_READ_ONLY === 'true') throw new CLIError('permission', 'READ_ONLY', 'This invocation is locked to read-only mode.', 'Remove the read-only flag/environment setting only when the user authorizes a write.');
    if (!options['allow-writes']) throw new CLIError('permission', 'WRITE_BLOCKED', 'Writes require --allow-writes.', 'Preview with --dry-run, then add --allow-writes for an authorized operation.');
  }
  return operation;
}
