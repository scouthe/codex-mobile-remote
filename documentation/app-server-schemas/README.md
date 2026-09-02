# Codex App Server schema snapshot

This directory contains the protocol schemas generated from the official
`@openai/codex` CLI package, version `0.152.1`.

The snapshot includes the experimental protocol surface because the project
uses the full app-server contract. Older v1 compatibility files are retained
alongside the current generated v2 schemas so existing consumers do not lose
their previously materialized types.

To refresh the snapshot, generate into a temporary directory and copy the
`json/` and `typescript/` trees into this directory:

```bash
pnpm dlx @openai/codex@<version> app-server generate-json-schema \
  --experimental --out /tmp/codex-schema/json
pnpm dlx @openai/codex@<version> app-server generate-ts \
  --experimental --out /tmp/codex-schema/typescript
```

Do not edit generated schema files by hand. Runtime code should narrow any
server values that are intentionally represented as open strings in the
official protocol.
