# 设计与调研

## 可行性与选择

MongoDB 需要的是 AI 可稳定调用的命令协议，以及独立于聊天的凭据管理。已有 mongosh 的环境可直接使用其脚本、BSON 和驱动能力，无需再安装另一套数据库连接库。

本工程采用 Node.js 内置 API 实现 CLI，零运行时 npm 依赖，通过 mongosh 执行固定 worker。参考项目用 Go/Cobra，但其面向代理的交互约定与实现语言无关。这一选择让当前已有 Node/mongosh 的本机可以直接运行，无需增加 Go 编译环境。以后如果需要独立二进制或降低每次启动耗时，可将 runner 换成直接驱动；命令与 skill 可以保持兼容。

## 已检查的公开项目

2026-10-23 阅读了四个官网，克隆公开源码到工程外临时目录，并检查了以下设计和实现：

| 项目 | 研究版本（短 SHA） | 检查内容 |
| --- | --- | --- |
| [openobserve-cli](https://github.com/AngelMsger/openobserve-cli) | `372b427` | `docs/technical-design.md`、`internal/app/stream.go`；发现后查询、JSON 列表、配置层次 |
| [jenkins-cli](https://github.com/AngelMsger/jenkins-cli) | `da518b0` | `docs/technical-design.md`、`internal/app/root.go`、`skill.go`、`internal/auth/keychain.go`；结构化错误、凭据后端、skill 安装 |
| [bitbucket-cli](https://github.com/AngelMsger/bitbucket-cli) | `17db2a4` | `pkg/apiclient/readonly.go` 与本机 companion skill；写入门控与调用约定 |
| [confluence-cli](https://github.com/AngelMsger/confluence-cli) | `3f45402` | `pkg/apiclient/readonly.go` 与官网；预览和只读模式 |

沿用的产品约定：名词/动词命令、命名连接、JSON stdout、结构化 stderr、`items/has_more/next`、本地交互配置、钥匙串/受限文件、`doctor`、随包 skill 和 `--dry-run`。

明确不同的行为：本项目默认阻止写入；显式 read-only 锁优先于 allow-writes；只允许结构化操作，不提供任意脚本；不自动读取 `.env`；不复制参考项目的实现代码。此项目独立维护，npm 包名使用 `@zhouping/mongo-cli`。

## 模块

```text
bin/mongo-cli.js
  → src/cli.js           命令路由与运行上下文
    → specs.js           命令定义及 help
    → config.js          命名连接、验证、配置存储
    → credentials.js     私密凭据与连接绑定
    → plan.js            查询/写入计划、输入及只读检查
    → runner.js          子进程超时、缓冲、输出协议
      → worker.cjs       固定 mongosh 操作分派
    → io.js / errors.js  JSON、投影、文件权限、错误分类
    → skills.js          随包 skill 的安装和检查
```

## 凭据链路

1. 用户在本机执行 config init/auth login；密码不回显。
2. 账号密码整体保存到 macOS 钥匙串，或显式/后备的 0600 文件。
3. 配置只保存非敏感参数和存储后端名。
4. 凭据键绑定配置目录、连接别名、服务器和认证/TLS 参数，防止修改目标后自动沿用旧凭据；业务库可切换。
5. runner 启动 `mongosh --nodb --norc --quiet --file <固定worker>`。请求与凭据经匿名 stdin 管道传递。
6. worker 在内存中构造连接串，执行支持的操作，只返回预定结果或错误类型/代码。runner 从不透传原始 shell stdout/stderr。

0.1.1 增加 `config init --from-uri`（终端隐藏粘贴）与 `--uri-stdin`（私密管道）。URI 在本机解析为允许的连接参数和独立凭据，原始 URI 不落盘、不回显；未知或重复参数报错。多节点地址不使用不支持 MongoDB seed list 的 WHATWG URL 直接解析。支持显式 SCRAM/PLAIN 和 `$external`，worker 重建连接时保留对应机制；PLAIN 的 LDAP 服务端认证仍需在目标环境验证。显式机制参与凭据键，未指定机制的旧配置继续使用原来的键。

0.1.2 的 `config init` 先展示配置方式选择，URI 在第一项并作为回车默认值；第二项逐项输入。`--from-uri`、`--step-by-step` 和 `--uri-stdin` 可跳过选择，三者互斥。

0.1.3 统一使用作者命名空间 `~/.zhouping/mongo`。默认目录首次解析时，将尚未迁移的旧 `~/.config/mongo-cli` 整体 rename 到新位置；已有目标目录不会被覆盖。自定义配置目录不迁移。默认目录的新旧路径作为同一凭据命名空间，散列仍保留旧目录的身份输入，因此 file 后端文件名、macOS keychain 的 account 均保持可用；无需提取或重写密码。该兼容映射只影响散列输入，不会在旧路径继续读写文件。

macOS 保存凭据时同样通过 `security -i` 的 stdin 传递 base64 编码的数据，没有密码命令行参数。base64 只服务于命令解析，不是加密。保存时如果钥匙串存在但访问失败，会保留失败，不静默写入文件。Windows 不实现文件凭据存储，自动化环境可注入私密环境变量；Windows 全链路未经验证。

MongoDB 官方资料：[mongosh 选项](https://www.mongodb.com/docs/mongodb-shell/reference/options/)、[脚本与凭据脱敏](https://www.mongodb.com/docs/mongodb-shell/write-scripts/)、[连接方式](https://www.mongodb.com/docs/mongodb-shell/connect/)。

## 只读与边界

不接受任意 JS/eval/raw command。聚合使用已知读取 stage 的允许列表，递归检查 facet/lookup/unionWith pipeline，拒绝 out/merge 和服务器 JS。写入计划先验证再查凭据；dry-run 只构造计划、不连接服务器。

读操作同时受服务端 maxTimeMS、父进程 deadline、单页数量和输出字节上限约束。操作失败不自动重试，连接的 retryWrites/retryReads 也显式关闭。网络/超时不能证明写入失败，错误会说明结果可能不确定或部分完成。

第一版不覆盖事务、批量任意命令、集群运维、用户管理、备份恢复、SSH 隧道、客户端字段加密或 OAuth/X.509 等认证方式。TLS、SRV 和副本集配置已提供；当前自动化集成测试验证的是本机单实例用户名/密码认证，未覆盖远端 TLS、SRV 或副本集拓扑。
