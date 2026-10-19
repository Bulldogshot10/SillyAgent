# SillyAgent tool harness (initial implementation)

This document describes the first server-side slice of the built-in tool harness. It is intentionally small and does not yet wire tool calls into every LLM provider's generation loop.

## API

The API is mounted under `/api/agent/tools`.

- `GET /api/agent/tools` returns enabled roleplay tools in OpenAI-compatible function-calling format.
- `POST /api/agent/tools/execute` executes a registered roleplay tool. The JSON request shape is `{"name":"roleplay.roll_dice","arguments":{"count":2,"sides":20}}`.

The execute endpoint only allows the `roleplay` toolset. Tool inputs are checked against their registered schema. Requests are limited to 16 KiB; serialized tool results are limited to 32 KiB; each tool has a bounded timeout.

## Built-in tool

### `roleplay.roll_dice`

Inputs:
- `count`: integer from 1 through 20.
- `sides`: integer from 2 through 1000.

Returns the dice notation, individual rolls, and total. The implementation uses Node's cryptographic `randomInt`, so callers do not control or predict the result by supplying a seed.

## Adding a tool

Register trusted application code with `ToolRegistry.registerTool` and provide a JSON Schema object input schema, toolset, permission level, bounded timeout, and an async handler. The handler receives `input`, `context`, and an `AbortSignal`.

Permission levels are:
- `read`: allowed by default.
- `write`: requires the caller to explicitly set `allowWrites: true`.
- `external`: requires the caller to explicitly set `allowExternal: true`.

Both privileged permissions are denied by default. Keep the HTTP endpoint scoped to roleplay tools. Do not add shell execution, arbitrary JavaScript, or unrestricted file access as built-in tools; these require a separate permission and isolation design.

The registry returns structured success/error envelopes and does not expose handler functions in function definitions. The current schema validator intentionally supports a small JSON Schema subset used by first-party tools.

## Tests and CI

Unit and endpoint tests live under `tests/`. The `SillyAgent CI` GitHub Actions workflow runs on pushes to `release` and `feat/**`, pull requests, and manual dispatch. It installs application and test dependencies, lints the harness integration, and runs the unit-test suite.

## Next integration steps

1. Connect model tool-call parsing to this registry through provider adapters while keeping ordinary text generation working.
2. Add a persistent roleplay state store with explicit world/chat/character scoping.
3. Add episodic memory search (SQLite FTS5) and local vector retrieval.
4. Add a background memory-consolidation worker only after persistence, scope, and audit history are tested.
