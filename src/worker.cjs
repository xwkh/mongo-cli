/* Executed by mongosh --nodb --norc --quiet --file. No credentials in this file. */
(async function () {
  let connection;
  const prefix = '__MONGO_CLI_RESPONSE__';
  try {
    const request = JSON.parse(require('fs').readFileSync(0, 'utf8'));
    const c = request.context;
    const op = request.operation;
    for (const key of ['filter', 'projection', 'pipeline', 'document', 'update']) {
      if (op[key] !== undefined) op[key] = EJSON.deserialize(op[key], { relaxed: false });
    }
    let hosts = c.host;
    if (!c.srv) {
      // Bare IPv6 is one host; seed lists can contain explicit per-host ports.
      if (!hosts.includes(',') && !hosts.startsWith('[') && (hosts.match(/:/g) || []).length > 1) hosts = `[${hosts}]`;
      hosts = hosts.split(',').map(h => /\]:\d+$/.test(h) || (!h.startsWith('[') && /:\d+$/.test(h)) ? h : `${h}:${c.port}`).join(',');
    }
    const params = new URLSearchParams({ appName: 'mongo-cli', authSource: c.auth_database, retryWrites: 'false', retryReads: 'false',
      serverSelectionTimeoutMS: String(Math.min(request.timeout, 15000)), connectTimeoutMS: String(Math.min(request.timeout, 15000)) });
    if (c.auth_mechanism) params.set('authMechanism', c.auth_mechanism);
    if (c.tls || c.srv) params.set('tls', 'true');
    if (c.direct_connection) params.set('directConnection', 'true');
    if (c.replica_set) params.set('replicaSet', c.replica_set);
    if (c.tls_ca_file) params.set('tlsCAFile', c.tls_ca_file);
    if (c.tls_certificate_key_file) params.set('tlsCertificateKeyFile', c.tls_certificate_key_file);
    const auth = request.credential ? `${encodeURIComponent(request.credential.username)}:${encodeURIComponent(request.credential.password)}@` : '';
    const uri = `mongodb${c.srv ? '+srv' : ''}://${auth}${hosts}/${encodeURIComponent(c.database)}?${params}`;
    connection = new Mongo(uri);
    const database = connection.getDB(c.database);
    const collection = op.collection ? database.getCollection(op.collection) : null;
    const maxTimeMS = request.max_time_ms;
    let result;
    const page = items => ({ items: items.slice(0, op.limit), has_more: items.length > op.limit,
      ...(items.length > op.limit ? { next: op.skip + op.limit } : {}) });
    switch (op.command) {
      case 'ping': case 'doctor': case 'auth status': case 'auth login':
        await database.runCommand({ ping: 1, maxTimeMS });
        result = { ok: true, database: c.database }; break;
      case 'db list': {
        const r = await connection.getDB('admin').runCommand({ listDatabases: 1, nameOnly: true, authorizedDatabases: true, maxTimeMS });
        result = { items: r.databases, has_more: false }; break;
      }
      case 'db stats': result = await database.runCommand({ dbStats: 1, maxTimeMS }); break;
      case 'collection list': result = { items: await database.getCollectionInfos({}, { nameOnly: true, authorizedCollections: true }), has_more: false }; break;
      case 'collection stats': result = await database.runCommand({ collStats: op.collection, maxTimeMS }); break;
      case 'collection schema': {
        const fields = await collection.aggregate([
          { $limit: op.sample }, { $project: { fields: { $objectToArray: '$$ROOT' } } },
          { $unwind: '$fields' }, { $group: { _id: '$fields.k', types: { $addToSet: { $type: '$fields.v' } }, occurrences: { $sum: 1 } } },
          { $project: { _id: 0, field: '$_id', types: 1, occurrences: 1 } }, { $sort: { field: 1 } }
        ], { maxTimeMS }).toArray();
        result = { items: fields, has_more: false, sample_limit: op.sample, scope: 'top-level fields from the first bounded sample; not an exhaustive schema' }; break;
      }
      case 'index list': result = { items: await collection.getIndexes(), has_more: false }; break;
      case 'document find': result = page(await collection.find(op.filter, op.projection).sort(op.sort).skip(op.skip).limit(op.limit + 1).maxTimeMS(maxTimeMS).toArray()); break;
      case 'document count': result = { count: await collection.countDocuments(op.filter, { maxTimeMS }) }; break;
      case 'document distinct': {
        // Aggregation keeps the server response bounded, unlike distinct().
        const items = await collection.aggregate([
          { $match: op.filter }, { $match: { [op.key]: { $exists: true } } },
          { $project: { value: { $cond: [{ $isArray: `$${op.key}` }, `$${op.key}`, [`$${op.key}`]] } } }, { $unwind: '$value' },
          { $group: { _id: '$value' } }, { $sort: { _id: 1 } }, { $skip: op.skip }, { $limit: op.limit + 1 },
          { $project: { _id: 0, value: '$_id' } }
        ], { maxTimeMS }).toArray();
        result = page(items); break;
      }
      case 'document aggregate': result = page(await collection.aggregate([...op.pipeline, { $skip: op.skip }, { $limit: op.limit + 1 }], { maxTimeMS }).toArray()); break;
      case 'document explain': result = await collection.find(op.filter).sort(op.sort).limit(op.limit).maxTimeMS(maxTimeMS).explain('queryPlanner'); break;
      case 'document insert': result = Array.isArray(op.document) ? await collection.insertMany(op.document) : await collection.insertOne(op.document); break;
      case 'document update': result = op.many ? await collection.updateMany(op.filter, op.update, { upsert: op.upsert }) : await collection.updateOne(op.filter, op.update, { upsert: op.upsert }); break;
      case 'document replace': result = await collection.replaceOne(op.filter, op.document, { upsert: op.upsert }); break;
      case 'document delete': result = op.many ? await collection.deleteMany(op.filter) : await collection.deleteOne(op.filter); break;
      case 'collection create': result = await database.createCollection(op.collection); break;
      case 'collection drop': result = { dropped: await collection.drop() }; break;
      case 'index create': result = { name: await collection.createIndex(op.keys, op.index_options) }; break;
      case 'index drop': result = await collection.dropIndex(op.index); break;
      default: throw Object.assign(new Error(), { name: 'UnsupportedOperation' });
    }
    // Keep Long/Decimal128/ObjectId/Date lossless while ordinary Int32/Double
    // values remain convenient JSON numbers for agents.
    const plainNumbers = value => {
      if (Array.isArray(value)) return value.map(plainNumbers);
      if (!value || typeof value !== 'object') return value;
      const keys = Object.keys(value);
      if (keys.length === 1 && Object.hasOwn(value, '$numberInt')) return Number(value.$numberInt);
      if (keys.length === 1 && Object.hasOwn(value, '$numberDouble') && Number.isFinite(Number(value.$numberDouble))) return Number(value.$numberDouble);
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, plainNumbers(item)]));
    };
    print(prefix + JSON.stringify({ ok: true, result: plainNumbers(EJSON.serialize(result, { relaxed: false })) }));
  } catch (error) {
    print(prefix + JSON.stringify({ ok: false, error: { code: error.code, name: error.name } }));
  } finally {
    try { if (connection) await connection.close(); } catch { /* Response has already been sent. */ }
  }
})();
