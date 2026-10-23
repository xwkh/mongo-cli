# 发布

源码仓库：[xwkh/mongo-cli](https://github.com/xwkh/mongo-cli)。npm 包名：`@xwkh/mongo-cli`，发布到 npm 公共仓库。

## 账号

本机需具备 GitHub 仓库写权限和 npm `@xwkh` 命名空间发布权限。npm 用户 scope 必须与用户名一致，或者使用有权限的组织 scope；GitHub 用户名与 npm 用户名可以不同。

```sh
npm login --registry=https://registry.npmjs.org/
npm whoami --registry=https://registry.npmjs.org/
```

密码、令牌和二次验证只在本机终端或官方网页输入，不提交 `.npmrc`、`.env` 或数据库连接配置。

## 版本与验证

更新 `package.json` / `package-lock.json` 的版本，并同步 `skills/mongodb/SKILL.md` 的版本标记与 README 中相关版本。不要复用已经发布过的版本号。

```sh
npm ci
npm run check
npm run test:integration
npm pack --dry-run
npm publish --dry-run --access public --registry=https://registry.npmjs.org/
```

集成测试使用独立的本机临时 MongoDB，不需要 mongosh，CLI 测试子进程的 PATH 中没有外部可执行文件。首次运行会下载测试用 MongoDB 二进制。打包内容使用 `package.json` 的 `files` 白名单，只包含入口、实现、skill、文档、包元数据和许可证，不包含个人配置、测试数据库或 `node_modules`。

## 上传与发布

先提交并推送已验证的源码，再发布同一份内容：

```sh
git push origin main
npm publish --access public --registry=https://registry.npmjs.org/
npm view @xwkh/mongo-cli version dist.integrity --registry=https://registry.npmjs.org/
```

首次发布需要 `--access public`（也已写入 `publishConfig`）。npm 可能要求在网页或终端完成二次验证。后续可配置 npm trusted publishing，通过 GitHub Actions OIDC 发布，避免长期 npm 令牌；此仓库当前不自动发布。

发布后检查：

```sh
npm install -g @xwkh/mongo-cli --registry=https://registry.npmjs.org/
mongo-cli version
mongo-cli skill install --agent codex
```

全局安装和升级只使用 npm 官方仓库中的已发布版本，不安装本地目录或 tgz，也不使用 `npm link`。未发布的修改直接从源码运行测试，发布成功后再从 npm 升级。

升级后重新加载代理会话以使用新版 skill。
