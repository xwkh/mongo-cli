# mongo-cli

让 AI 直接使用 MongoDB，同时让连接信息与凭据留在本机。基于已有的 `mongosh`，提供非交互命令、默认 JSON 输出、结构化错误、多连接配置和配套 `mongodb` skill。

运行需要 **Node.js 22+** 和 **mongosh**。运行时没有额外 npm 依赖。开发测试使用的 MongoDB driver 和临时 MongoDB 服务都是 devDependencies。

## 安装与首次配置

```sh
npm install -g @xwkh/mongo-cli
mongo-cli version
mongo-cli skill install --agent codex
```

源码位于 [GitHub](https://github.com/xwkh/mongo-cli)。需要从源码安装时：

```sh
git clone https://github.com/xwkh/mongo-cli.git
cd mongo-cli
npm pack --pack-destination /tmp
npm install -g /tmp/xwkh-mongo-cli-0.1.4.tgz --omit=dev
```

先打包再安装能兼容 Volta 的全局命令管理。未使用 Volta 的环境也可直接 `npm install -g . --omit=dev`。

**在你自己的终端**完成配置，不要把账号密码发到聊天里：

```sh
mongo-cli config init --name dev
mongo-cli doctor --use-context dev
```

向导首先选择配置方式，默认推荐 URI，直接回车即可进入隐藏粘贴：

```text
Connection setup:
  1) MongoDB URI (recommended)
  2) Step-by-step fields
Select setup method [1]:
```

选择 `2` 则依次询问 IP/域名、端口、业务数据库、认证数据库、TLS、是否启用账号密码认证。也可用 `--from-uri` 直接进入 URI 输入，或用 `--step-by-step` 直接进入逐项配置；两者与 `--uri-stdin` 互斥。

URI 和密码输入隐藏；账号和密码都单独保存，不写进普通配置文件。向导默认使用 macOS 登录钥匙串；没有可用默认钥匙串时，macOS/Linux 使用权限为 `0600` 的凭据文件，父目录权限为 `0700`。可以使用 `--credential-store keychain` 强制钥匙串，或 `--credential-store file` 明确选择文件。钥匙串存在但拒绝访问时会报错，不会静默切换存储。

### 直接粘贴 MongoDB URI

已有完整连接串时，在自己的终端运行：

```sh
mongo-cli config init --name dev --from-uri
```

然后在 `MongoDB connection URI (hidden):` 提示后粘贴完整 URI 并回车。**输入不会回显**，URI 不进入命令参数或 shell 历史。例如以下形式已经支持（账号密码为占位符）：

```text
mongodb://USERNAME:PASSWORD@db1.example.com,db2.example.com/app?authMechanism=PLAIN&authSource=%24external
```

导入后业务库为 `app`，认证库为解码后的 `$external`，认证机制为 `PLAIN`，两个节点未指定端口时都使用 27017。账号密码拆分保存到凭据存储，原始 URI 不写入配置文件，也不出现在成功或错误输出中。URI 中账号密码的特殊字符要做百分号编码，例如 `@` → `%40`、`:` → `%3A`。

```sh
mongo-cli doctor --use-context dev
mongo-cli collection list --use-context dev
```

支持 `mongodb://` 和 `mongodb+srv://`，以及 URI 中的 `authSource`、`authMechanism`（`DEFAULT` / `SCRAM-SHA-1` / `SCRAM-SHA-256` / `PLAIN`）、`replicaSet`、`tls` / `ssl`、`directConnection`、`tlsCAFile`、`tlsCertificateKeyFile`。参数名不区分大小写。未知参数或重复参数会报错，不会静默丢弃；SRV 的 TLS 不能关闭。

未显式指定认证库时，URI 使用路径中的数据库；路径为空时认证库使用 `admin`；PLAIN 默认使用 `$external`。不含账号密码的 URI 导入后是未配置凭据的连接，可以再运行 `auth login`。导入会替换该别名的连接设置，不继承旧服务器的 TLS/副本集等参数。

自动化可使用 `config init --uri-stdin --name dev` 从私密标准输入管道导入；它与 `--from-uri` 互斥。不提供 `--uri <连接串>`，以免账号密码出现在进程参数中。

默认配置目录是 `~/.xwkh/mongo`，与 npm 包 `@xwkh/mongo-cli` 的命名空间一致：

```text
config.json                 # 非敏感连接参数，不含账号密码
credentials/<hash>.json     # 仅 file 后端使用，0600，明文凭据
```

0.1.4 首次使用默认目录时，如果新目录尚不存在，会先查找 `~/.zhouping/mongo/config.json`，再查找更早的 `~/.config/mongo-cli/config.json`，将找到的旧目录整体迁移到 `~/.xwkh/mongo`。连接配置、凭据文件和钥匙串的查找键保持兼容，无需重新登录。新旧目录同时存在时优先使用新目录，不自动合并或覆盖。显式指定 `--config` 或 `MONGO_CLI_CONFIG_DIR` 时按指定目录使用，不触发迁移。

这是配置目录；程序仍由 npm/Volta 管理，skill 仍安装到对应代理的技能目录，例如 `~/.codex/skills/mongodb`。

文件后端的保护来自操作系统文件权限，并非加密。同一用户权限的程序仍能访问；skill 会明确要求模型不要读取该目录中的凭据。此工具解决的是凭据不进入聊天、命令参数和正常输出，并不隔离同一操作系统用户下的任意代码。

## AI 的使用方式

安装 skill 后重新加载 AI 会话；告诉它连接别名即可：

> 用 dev 连接看看 app 库有哪些集合，再统计 orders 最近一周的订单状态。

对应的调用不需要密码：

```sh
mongo-cli config contexts
mongo-cli db list --use-context dev
mongo-cli collection list --use-context dev --database app
mongo-cli collection schema orders --use-context dev --database app
mongo-cli document find orders --use-context dev --database app \
  --filter '{"status":"pending"}' \
  --projection '{"_id":1,"status":1,"createdAt":1}' --limit 20
mongo-cli document aggregate orders --use-context dev --database app \
  --pipeline '[{"$group":{"_id":"$status","count":{"$sum":1}}},{"$sort":{"count":-1}}]'
```

`schema` 只推断有限样本的顶层字段，不代表集合完整 schema。模型应先发现库、集合、字段，再构造查询。

## 多连接与认证

```sh
# 只设置非敏感参数；首次添加的 context 会成为默认连接
mongo-cli config set-context dev --host 127.0.0.1 --port 27017 --database app
mongo-cli auth login --use-context dev --verify

mongo-cli config set-context prod --host mongo.example.com --port 27017 \
  --database app --auth-database admin --tls --replica-set rs0
mongo-cli auth login --use-context prod --verify

mongo-cli config contexts
mongo-cli config use-context dev
mongo-cli config show
mongo-cli auth status
mongo-cli auth status --verify
mongo-cli auth logout --use-context prod
mongo-cli config delete-context prod
```

`auth login` 默认只保存本地凭据；`--verify` 在保存前验证连接。`auth status` 默认只检查本地凭据可用性，不表示服务器认证已经成功。`doctor` 会实际连接并检查。

支持独立实例、逗号分隔的副本集种子地址、IPv6、`--direct-connection`、`--replica-set`、TLS CA/客户端证书文件，以及 `--srv`。例如：

```sh
mongo-cli config set-context cluster --host 'db1.example.com:27017,db2.example.com:27017' \
  --replica-set rs0 --tls --tls-ca-file /path/to/ca.pem --database app
mongo-cli config set-context atlas --host cluster.example.mongodb.net --srv --database app

# 也可手动指定 PLAIN 认证；$external 用单引号避免 shell 展开
mongo-cli config set-context ldap --host 'db1.example.com,db2.example.com' \
  --database app --auth-database '$external' --auth-mechanism PLAIN
```

SRV 使用 DNS 端口、自动启用 TLS；不支持自定义端口或 direct connection。TLS 证书校验始终开启。修改服务器、端口、认证库、认证机制或 TLS 参数后需要重新登录，旧凭据不会发送到新的连接。`--auth-mechanism DEFAULT` 恢复驱动自动选择机制。业务库 `--database` 可按调用覆盖，认证库仍保留原值。升级兼容原有默认认证连接的凭据键，无需重新配置。

全局参数优先于相应环境变量，再使用配置文件：

| 环境变量 | 用途 |
| --- | --- |
| `MONGO_CLI_CONFIG_DIR` | 配置目录，对应 `--config` |
| `MONGO_CLI_CONTEXT` | 单次选择连接，对应 `--use-context` |
| `MONGO_CLI_MONGOSH` | mongosh 可执行文件路径，对应 `--mongosh` |
| `MONGO_CLI_USERNAME` / `MONGO_CLI_PASSWORD` | 自动化私密环境提供的一组凭据，优先于凭据存储 |
| `MONGO_CLI_READ_ONLY=1` | 严格只读锁，优先于 `--allow-writes` |
| `MONGO_CLI_SKILL=0.1.4` | skill 已加载的版本标记 |

不自动读取当前工程的 `.env`，不提供 `--password` 或含凭据的 URI 参数。用于自动化的凭据应由私密的进程环境注入，不应让模型输出 `export PASSWORD=...`。

## 查询与 BSON

```sh
mongo-cli document count orders --filter '{"status":"pending"}'
mongo-cli document distinct orders --key status --limit 20
mongo-cli document explain orders --filter '{"status":"pending"}'
mongo-cli index list orders
mongo-cli db stats
mongo-cli collection stats orders

# BSON 类型用 Extended JSON，不执行 JavaScript
mongo-cli document find orders --filter '{"_id":{"$oid":"507f1f77bcf86cd799439011"}}'
mongo-cli document find orders --filter '{"createdAt":{"$gte":{"$date":"2026-01-01T00:00:00Z"}}}'
mongo-cli document find orders --filter '{"sequence":{"$numberLong":"9223372036854775807"}}'

# 复杂输入来自文件或 stdin；每次只能有一个输入读取 stdin
mongo-cli document aggregate orders --pipeline-file pipeline.json
cat filter.json | mongo-cli document find orders --filter-file -
```

输入支持 JSON / Extended JSON，查询中的 `ObjectId(...)` 等 JavaScript 写法不支持。输出保留 ObjectId、Date、Long、Decimal128 等特殊 BSON 类型，避免大整数变成不精确的 JS number。普通 Int32 和 Double 以普通 JSON number 输出。日期输出为 canonical Extended JSON，例如 `{"$date":{"$numberLong":"1767225600000"}}`。

文档查询默认取 20 条，最多 1000 条；使用 `--limit` 与 `--skip` 翻页。find 默认按 `_id` 升序，自定义 sort 自动补 `_id` 作为相同排序值的区分项。聚合排序由调用者通过 `$sort` 指定。偏移分页不是快照，并发写入可能使页面移动。

```json
{"items":[{"status":"pending"}],"has_more":true,"next":20}
```

下一页保留相同过滤和排序，并传 `--skip 20`。支持 `--format ndjson`，每行一条记录，分页通知放在 stderr。`--fields _id,status` 在输出端投影；`--projection` 是 MongoDB 服务端投影。`--pretty` 格式化 JSON。

`--timeout` 是 mongosh 整个进程的超时毫秒数，默认 30000；`--max-time-ms` 是服务端查询时间限制，默认不超过 10000 且不大于进程超时。每次输出最多 16 MiB。启动一个 mongosh 通常有约一秒开销，适合交互式排查和自动化查询，不适合高频业务访问。

## 写入与预览

默认禁止写入。所有支持的写操作都可以先用 `--dry-run` 离线预览，再用 `--allow-writes` 执行用户已授权的修改。

```sh
mongo-cli document insert scratch --document '{"name":"demo"}' --dry-run
mongo-cli document insert scratch --document-file documents.json --allow-writes

mongo-cli document update orders --filter '{"_id":{"$oid":"507f1f77bcf86cd799439011"}}' \
  --update '{"$set":{"status":"processed"}}' --dry-run
# 确认预览符合已授权的修改后，替换 --dry-run 为 --allow-writes

mongo-cli document replace scratch --filter '{"name":"demo"}' \
  --document '{"name":"renamed"}' --allow-writes
mongo-cli document delete scratch --filter '{"name":"renamed"}' --allow-writes
mongo-cli index create orders --keys '{"status":1,"createdAt":-1}' --name status_date --dry-run
mongo-cli index drop orders status_date --dry-run
mongo-cli collection create scratch --dry-run
mongo-cli collection drop scratch --confirm scratch --dry-run
```

update/delete 默认只修改一条，`--many` 修改所有匹配项；update/replace 可加 `--upsert`。update 必须使用 `$set` 等更新操作符，替换文档用 replace。修改、替换和删除必须显式传入 filter；空对象 filter 还需要 `--all`。这只拦截显式空 filter，不证明一个非空 filter 不会匹配全表。删除集合要求 `--confirm` 精确匹配集合名；不支持通配符删除索引。

`--read-only` 或 `MONGO_CLI_READ_ONLY=1` 是严格锁，即使加上 `--allow-writes` 也不能写入；预览仍可使用。聚合始终只读，不支持 `$out` / `$merge`，包括嵌套 pipeline。不开放任意 JavaScript、`$where` / `$function` / `$accumulator`、原始数据库命令、用户管理、备份恢复和事务。这里的只读规则是 CLI 级限制；需要数据库级约束时，请配置 MongoDB 只读账号。

写入在网络中断或超时后可能已执行或部分完成；不要盲目重试。CLI 和连接参数均关闭自动重试，错误会提示先检查受影响的数据。

## Skill

```sh
mongo-cli skill install                       # 检测已有代理目录
mongo-cli skill install --agent codex,claude
mongo-cli skill install --agent codex --project
mongo-cli skill install --dir /path/to/skills  # 安装到该目录下的 mongodb/
mongo-cli skill status --agent codex
mongo-cli skill path --agent codex
mongo-cli skill show
```

支持 Codex、Claude Code、Cursor 与共享 Agents 目录。安装时会拒绝覆盖非本工具管理的 MongoDB skill；检查后可用 `--force` 明确覆盖。升级 CLI 后重新运行 `skill install`，并重新加载代理上下文。skill 文件随 npm 包一起发布，不依赖源码目录以外的文件。

## 错误与退出码

stdout 只输出结果；错误是 stderr 中的 JSON，例如：

```json
{"error":{"category":"permission","code":"WRITE_BLOCKED","message":"Writes require --allow-writes.","hint":"Preview with --dry-run, then add --allow-writes for an authorized operation.","next_steps":[],"retryable":false}}
```

| 退出码 | 类别 |
| --- | --- |
| 0 | 成功 |
| 2 | 参数或 JSON 输入错误 |
| 3 | 配置错误 |
| 4 | 认证或凭据访问错误 |
| 5 | 写入拦截 / MongoDB 权限不足 |
| 6 | 集合不存在 |
| 7 | 网络 / 服务器选择失败 |
| 8 | 进程或查询超时 |
| 9 | mongosh 不可用 |
| 10 | 本地或执行协议错误 |
| 11 | MongoDB 查询、重复键等操作错误 |

服务端原始错误可能包含连接串或数据，因此 CLI 只输出分类、稳定错误码、恢复提示和服务器数字错误码，不直接透传错误正文。mongosh 本身也会对日志中的凭据脱敏，见 [MongoDB 官方说明](https://www.mongodb.com/docs/mongodb-shell/write-scripts/)。

## 开发与验证

```sh
npm ci
npm run check
npm run test:integration
npm pack --dry-run
```

端到端测试用 `mongodb-memory-server` 启动独立的本机 MongoDB，启用认证，再通过真实 mongosh 调用 CLI。首次安装/测试会下载 MongoDB 测试二进制；不使用真实业务连接、账号或数据。测试涵盖认证、发现、BSON 精度、分页、读写、预览、索引、脱敏和退出登录。

架构、参考源码和设计取舍见 [docs/design.md](docs/design.md)。命令完整参数由 `mongo-cli <noun> <verb> --help` 提供。

维护者发布流程见 [docs/releasing.md](docs/releasing.md)。
