# Instructions for AI agents

If application code was changed then verify:

```sh
pnpm -r test
pnpm lint
```

Changes to the following files are prohibited unless explicitly consented or applied by `pnpm lint`:

```sh
**/package.json
./README.md
./AGENTS.md
**/ci.yml
```
