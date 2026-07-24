# Tool Contract Baseline

`workbridge-codex-tool-schema.json` records the stable model-visible MCP
contract. It is generated through an in-memory MCP client/server exchange and
contains:

- the exact seven tool names
- one SHA-256 digest per tool, calculated from the complete canonical tool
  contract returned by `tools/list`
- the fixed surface configuration

The digest covers the full model-visible contract, including descriptions,
input and output schemas, nested types and enums, annotations, execution hints,
and public `_meta` values. Any model-visible change updates the affected tool's
digest without storing a very large duplicated schema document.

Print the current contract:

```bash
npm run baseline:tools:print
```

Verify the committed contract:

```bash
npm run baseline:tools:check
```

Update it only when a model-visible tool contract change is intentional.
