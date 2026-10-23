# Project instructions

Global installations and upgrades must use the published package from the official npm registry:

```sh
npm install -g @xwkh/mongo-cli --registry=https://registry.npmjs.org/
```

Do not globally install the working directory, local tarballs, or use `npm link`.
Validate unreleased changes from source with `npm run check`, `npm run test:integration`, and `node bin/mongo-cli.js ...`; these do not replace the installed CLI.
After a release is published, upgrade the global CLI from npm and refresh its skill with `mongo-cli skill install --agent codex`.
Preserve existing configuration and credentials under `~/.xwkh/mongo/` during installation and upgrades.
