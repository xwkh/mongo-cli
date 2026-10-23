# 设计与调研

## 可行性与选择

MongoDB 需要的是 AI 可稳定调用的命令协议，以及独立于聊天的凭据管理。从 0.2.0 起，CLI 将 MongoDB 官方 Node.js 驱动作为运行依赖，由 npm 自动安装，不要求用户安装 mongosh。

现有功能都是固定的结构化数据库操作，不需要完整 shell 的交互解释器或任意 JavaScript 执行能力。驱动直接承担连接、认证、BSON 和数据库协议。保留独立 Node.js worker，以便整体超时和信号中断时可靠终止本地操作；父进程通过 process.execPath 使用同一个 Node.js 运行时，不通过 PATH 寻找其他程序。

驱动以 promoteLongs:false 解码，避免安全整数范围内的 Long 也被隐式转换为普通 number；输入和输出通过驱动自带的 BSON/EJSON 处理。运行依赖随版本锁定并纳入发布验证，当前驱动支持的最低服务端版本为 MongoDB 4.4。

## 已检查的公开项目

2026-10-23 阅读了四个官网，克隆公开源码到工程外临时目录，并检查了以下设计和实现：

| 项目 | 研究版本（短 SHA） | 检查内容 |
| --- | --- | --- |
| [openobserve-cli](https://github.com/AngelMsger/openobserve-cli) | `372b427` | `docs/technical-design.md`、`internal/app/stream.go`；发现后查询、JSON 列表、配置层次 |
| [jenkins-cli](https://github.com/AngelMsger/jenkins-cli) | `da518b0` | `docs/technical-design.md`、`internal/app/root.go`、`skill.go`、`internal/auth/keychain.go`；结构化错误、凭据后端、skill 安装 |
| [bitbucket-cli](https://github.com/AngelMsger/bitbucket-cli) | `17db2a4` | `pkg/apiclient/readonly.go` 与本机 companion skill；写入门控与调用约定 |
| [confluence-cli](https://github.com/AngelMsger/confluence-cli) | `3f45402` | `pkg/apiclient/readonly.go` 与官网；预览和只读模式 |

沿用的产品约定：名词/动词命令、命名连接、JSON stdout、结构化 stderr、`items/has_more/next`、本地交互配置、钥匙串/受限文件、`doctor`、随包 skill 和 `--dry-run`。

明确不同的行为：本项目默认阻止写入；显式 read-only 锁优先于 allow-writes；只允许结构化操作，不提供任意脚本；不自动读取 `.env`；不复制参考项目的实现代码。此项目独立维护，npm 包名使用 `@xwkh/mongo-cli`。

## 模块

```text
bin/mongo-cli.js
  → src/cli.js           命令路由与运行上下文
    → specs.js           命令定义及 help
    → config.js          命名连接、验证、配置存储
    → credentials.js     私密凭据与连接绑定
    → plan.js            查询/写入计划、输入及只读检查
    → runner.js          子进程超时、缓冲、输出协议
      → worker.js        官方驱动与固定操作分派
        → connection.js    种子地址、认证、TLS 和驱动选项
    → io.js / errors.js  JSON、投影、文件权限、错误分类
    → skills.js          随包 skill 的安装和检查
```

## 凭据链路

1. 用户在本机执行 config init/auth login；密码不回显。
2. 账号密码整体保存到 macOS 钥匙串，或显式/后备的 0600 文件。
3. 配置只保存非敏感参数和存储后端名。
4. 凭据键绑定配置目录、连接别名、服务器和认证/TLS 参数，防止修改目标后自动沿用旧凭据；业务库可切换。
5. runner 使用 `process.execPath` 启动固定 Node.js worker。请求与凭据经匿名 stdin 管道传递；继承环境中的凭据变量会被剔除。
6. worker 生成不含凭据的连接 URI，将解码后的账号密码单独传入驱动 auth 选项，执行支持的操作，只返回预定结果或错误类型/代码。关闭驱动日志，runner 从不透传原始 worker stdout/stderr。

`config init --from-uri` 使用终端隐藏粘贴，`--uri-stdin` 使用私密管道。URI 在本机解析为允许的连接参数和独立凭据，原始 URI 不落盘、不回显；未知或重复参数报错。多节点地址不使用不支持 MongoDB seed list 的 WHATWG URL 直接解析。支持显式 SCRAM/PLAIN 和 `$external`，worker 重建连接时保留对应机制；PLAIN 的 LDAP 服务端认证仍需在目标环境验证。显式机制参与凭据键，未指定机制的旧配置继续使用原来的键。

`config init` 先展示配置方式选择，URI 在第一项并作为回车默认值；第二项逐项输入。`--from-uri`、`--step-by-step` 和 `--uri-stdin` 可跳过选择，三者互斥。

包名统一使用 `@xwkh/mongo-cli`，默认配置目录为 `~/.xwkh/mongo`。`locations.js` 只在兼容迁移逻辑中识别历史目录：默认目录首次解析时，将找到的旧目录整体 rename 到新位置；已有目标目录不会被覆盖，自定义配置目录不迁移。默认目录的新旧路径作为同一凭据命名空间，散列保留原有身份输入，因此 file 后端文件名、macOS keychain 的 account 均保持可用；无需提取或重写密码。兼容映射只影响散列输入，不会在旧路径继续读写文件。

macOS 保存凭据时同样通过 `security -i` 的 stdin 传递 base64 编码的数据，没有密码命令行参数。base64 只服务于命令解析，不是加密。保存时如果钥匙串存在但访问失败，会保留失败，不静默写入文件。Windows 不实现文件凭据存储，自动化环境可注入私密环境变量；Windows 全链路未经验证。

MongoDB 官方资料：[Node.js 驱动](https://www.mongodb.com/docs/drivers/node/current/)、[BSON 数据](https://www.mongodb.com/docs/drivers/node/current/data-formats/bson/)、[PLAIN 认证](https://www.mongodb.com/docs/drivers/node/current/security/authentication/ldap/)。

## 只读与边界

不接受任意 JS/eval/raw command。聚合使用已知读取 stage 的允许列表，递归检查 facet/lookup/unionWith pipeline，拒绝 out/merge 和服务器 JS。写入计划先验证再查凭据；dry-run 只构造计划、不连接服务器。

读操作同时受服务端 maxTimeMS、父进程 deadline、单页数量和输出字节上限约束。操作失败不自动重试，连接的 retryWrites/retryReads 也显式关闭。网络/超时不能证明写入失败，错误会说明结果可能不确定或部分完成。

第一版不覆盖事务、批量任意命令、集群运维、用户管理、备份恢复、SSH 隧道、客户端字段加密或 OAuth/X.509 等认证方式。TLS、SRV 和副本集配置已提供；当前自动化集成测试在无外部可执行文件 PATH 下验证本机单实例 SCRAM 认证及所有命令。单元测试验证 PLAIN/$external、IPv6、多节点、TLS 和 SRV 的驱动参数；未连接实际 LDAP、远端 TLS、SRV 或副本集拓扑。
