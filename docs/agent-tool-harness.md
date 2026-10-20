# Native SillyAgent tool harness

The tool harness is part of the SillyAgent fork, not an extension. Trusted server-side tool definitions are registered with `ToolRegistry`; SillyTavern's existing `public/scripts/tool-calling.js` is the provider adapter for supported Chat Completion models. The native memory module initializes the relevant lifecycle and settings UI from the main application source.

## Server contract

The API is mounted under `/api/agent/tools`. `GET /` returns registered roleplay, memory, and skills tools in OpenAI-compatible function-calling format. `POST /execute` validates the tool name and schema, applies toolset/write permissions, enforces request/result size limits, and calls trusted server-side handlers. The browser-facing tool names are namespaced by SillyTavern's `ToolManager` and mapped back to server registry names on execution.

## Current built-in toolsets

The roleplay toolset includes `roleplay_roll_dice`, which uses Node's cryptographic `randomInt` and bounded integer inputs. The memory toolset includes `memory_search` and `memory_propose`. The skills toolset provides metadata search, selected-skill retrieval, and evidence-driven versioned skill proposals. Active character/chat context is supplied by native core lifecycle code and validated by the server.

The memory tool never exposes a global cross-character search to the model. Relevant searches are constrained to the active character and exact active chat. Memory writes are scoped to the active character or chat, accepted automatically by the autonomous reflection path, and checked for scope consistency. Skill writes use versioned records and retain source/reason/evaluation metadata. Skill stores are separate SQLite databases keyed by a one-way hash of the active character ID; the server refuses skill access without active-character context, and legacy unscoped skills are not merged into any character.

## Autonomous runtime

The same backend process owns the persistent SQLite reflection queue and worker. Every newly captured assistant reply queues or refreshes an automatic review without an explicit phrase, tool invocation, slash command, or turn-count threshold. Pending jobs coalesce per chat/character/mode to keep load bounded. Reviews combine recent active-chat evidence with bounded prior-chat context from the same character, letting one pass extract durable memories, supersede outdated facts with evidence, and improve reusable procedural skills after a verified successful workflow or user correction. A single explicit provider configuration supplies server-side background inference. No extension activation, quiet-generation browser API, manual dreaming action, or per-write human approval is used by this runtime.

## Security and validation

Tool arguments are schema-validated before execution. Privileged tool permissions default to denied unless the registered tool and calling policy allow them. Memory reflection candidates must cite known evidence event IDs, stay within bounded schemas and scopes, and cannot set another character's memory partition. Memory deletion, proposal review, and visible summary counts are constrained to the active character and chat; global `all` listing is rejected. Credentials are resolved server-side from SillyTavern Secrets; non-loopback reflection endpoints must use HTTPS, and neither secrets nor raw upstream response bodies are stored in job payloads. Skills are Markdown procedures, not executable code. Arbitrary shell execution, arbitrary JavaScript evaluation, and unrestricted file access are not built-in tools.

## Verification

The CI workflow lints the native server/frontend implementation and runs unit and endpoint tests for the registry, memory store, character isolation, persistent queues, worker retries, provider configuration, reflection validation, and skill revisions.
