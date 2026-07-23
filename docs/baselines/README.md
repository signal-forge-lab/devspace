# Tool Contract Baseline

`workbridge-codex-tool-schema.json` records the stable model-visible MCP
contract. It is generated through an in-memory MCP client/server exchange and
contains:

- the exact seven tool names
- each tool's input properties and required inputs
- each tool's output properties and required outputs
- the fixed surface configuration

The baseline intentionally excludes descriptor byte counts and hashes. Wording
changes should not create noisy baseline churn; tool names and schemas remain
protected.

Print the current contract:

```bash
npm run baseline:tools:print
```

Verify the committed contract:

```bash
npm run baseline:tools:check
```

Update it only when a model-visible tool name or input/output schema change is
intentional.
