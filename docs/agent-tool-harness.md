# SillyAgent tool harness (initial implementation)

This document describes the first server-side slice of the built-in tool harness. It is intentionally small and does not yet wire tool calls into every LLM provider's generation loop.

## API

The API is mounted under `/api/agent/tools`.

- `GET /api/agent/tools` returns enabled roleplay and memory tools in OpenAI-compatible function-calling format.
- `POST /api/agent/tools/execute` executes a registered roleplay tool. The JSON request shape is `{"name":"roleplay_roll_dice","arguments":{"count":2,"sides":20}}`.

The execute endpoint only allows the `roleplay` and `memory` toolsets. Tool inputs are checked against their registered schema. Requests are limited to 16 KiB; serialized tool results are limited to 32 KiB; each tool has a bounded timeout.

## Built-in tool

### `roleplay_roll_dice`

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

1. Add a model-backed dreaming/reflection provider that returns evidence-linked candidates and still requires review.
2. Evaluate embeddings against the current deterministic hybrid lexical ranking using a small retrieval benchmark.
3. Add prompt-hook integration tests across text and chat completion provider paths.
4. Consider cross-chat and character-level consolidation only with explicit scope and provenance controls.


## Persistent memory engine (initial vertical slice)

The memory store uses Node's built-in SQLite API plus SQLite FTS5. Each user's database lives under that user's data root at `sillyagent/memory.sqlite`. This feature requires Node.js 22.5+ with `node:sqlite` and SQLite FTS5. The repository's general Node.js engine requirement remains `>=20`, so Node.js 20 and Node.js 22 versions older than 22.5 can still run the rest of SillyTavern, but persistent memory is unavailable on those runtimes. The memory store checks the runtime before creating its database directory and reports the exact feature requirement; ordinary chat remains independent of this feature.

Memories are scoped to a user, character, or chat. Relevant retrieval includes user-level memories plus memories for the active chat and character supplied by the browser. It does not search other chats or characters by default. Only approved memories are indexed.

- `memory_search` searches approved memories using FTS5.
- `memory_propose` creates a pending candidate and a source event. It never writes directly to accepted memory.
- `GET /api/agent/tools/memory/proposals` lists pending candidates.
- `POST /api/agent/tools/memory/proposals/:id/review` accepts `{"decision":"approve"}` or `{"decision":"reject"}`.

Proposal creation can be disabled with `agentTools.memoryProposalsEnabled: false` in server configuration. Reviewing proposals uses the authenticated application endpoint. This slice establishes durable storage, scoped search, proposal review, automated retrieval, opt-in capture, and deterministic dreaming v1. Embedding retrieval and model-backed reflection remain follow-up work.

## Memory lifecycle v1

The memory API also exposes settings at `/api/agent/tools/memory/settings`, accepted memories at `/api/agent/tools/memory/list`, and `DELETE /api/agent/tools/memory/:id`. Automatic retrieval can be enabled in the UI and only injects approved memories from the user, active chat, and active character scopes.

Automatic capture is disabled by default. When enabled, user and assistant turns are recorded as chat-scoped events with deduplication keys. Captured turns are not directly indexed as memories. Dreaming v1 uses captured events to detect recurring topics and creates reviewable proposals with evidence event IDs; it never auto-approves proposals. Manual dreaming is available at `POST /api/agent/tools/dream`. Optional automatic dreaming runs every 12 newly captured turns in the active chat.

The initial dreaming algorithm is deterministic and model-independent. It deliberately proposes topic observations rather than asserting inferred facts. A later milestone can add a model-backed reflection provider while retaining evidence references, review gates, per-chat scope isolation, and idempotency.


## Hybrid memory ranking

Retrieval combines Unicode FTS5, trigram substring search, and a short-CJK substring fallback. It over-fetches a bounded candidate set and ranks results using exact phrase matching, query-term coverage, lexical rank, importance, and recency. Results remain scope-filtered before returning to the caller. Embedding-based semantic search is not enabled yet; the hybrid lexical layer remains deterministic and works without a separate embedding model or index.


The Memory Control Panel can clear captured raw turns for the active chat. This action removes only captured `chat.user_turn` and `chat.assistant_turn` events plus their deduplication keys; accepted memories and existing proposals remain, so users can intentionally manage them separately.
