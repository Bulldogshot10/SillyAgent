# Native agent runtime: research and refactor specification

## Scope

SillyAgent is a fork of SillyTavern. Memory capture, retrieval, dreaming/reflection, skill learning, and tool execution belong to the fork's core runtime. They must not require a directory under `public/scripts/extensions/`, an extension manifest, or the extension loader.

This document records source-verified findings on `feat/sillyagent-core` and the target architecture for the native refactor.

## Verified current-state findings

- `public/scripts/extensions/sillyagent-memory/index.js` currently owns turn capture, memory retrieval/injection, autonomous memory instructions, and automatic function-calling setting changes. It listens to `MESSAGE_SENT`, `CHARACTER_MESSAGE_RENDERED`, `CHAT_COMPLETION_PROMPT_READY`, and `GENERATE_AFTER_COMBINE_PROMPTS`.
- Those lifecycle events are emitted by core code in `public/script.js`; chat-completion prompt readiness is also emitted in `public/scripts/openai.js`. Native integration points therefore exist in the core generation lifecycle.
- `src/agent/memory-store.js` implements durable SQLite memory, FTS5/trigram retrieval, captured-turn events, and a persistent `memory_reflection_jobs` queue with claim leases, retry handling, and completion/failure states.
- The queue is not wired into the production lifecycle found in `src/endpoints/agent-tools.js`: `/capture-turn` directly invokes deterministic `DreamingEngine.run()` every 12 captured turns. The endpoint does not expose the queue status route expected by `tests/agent-tools-endpoint.test.js`.
- `src/agent/dreaming.js` is deterministic phrase/topic recurrence detection. It proposes recurring-topic records; it is not model-backed synthesis and does not implement a background review of durable facts and procedural lessons.
- `src/agent/skill-store.js` provides persistent, versioned skill storage, but there is no production background review worker in the inspected source that autonomously evaluates completed turns and improves memory/skills.
- `public/scripts/tool-calling.js` registers the server tool schemas and forwards execution to the server registry. `docs/agent-tool-harness.md` explicitly describes the harness as an initial slice not wired into every provider generation loop.
- `package.json` declares the general runtime as Node.js >=20; the memory implementation specifically requires Node.js >=22.5 for `node:sqlite`. Keep the main application compatible where possible, but fail clearly or disable only the agent-storage feature on unsupported runtimes.

## Research principles adopted

### Hermes-style self-improvement

A completed user-facing turn should enqueue a separate, bounded review after the primary response. The reviewer receives a snapshot and a restricted tool surface, and can make a valid no-op. Memory and skills remain separate stores:

- Declarative memory: durable user preferences, character continuity, facts, goals, and time-sensitive state.
- Procedural memory: reusable workflows, corrections, successful fixes, and pitfalls, stored as versioned skills.
- Episodic history: captured turns with timestamps, chat/character provenance, and full-text search.

The reviewer must search existing entries before writing, patch relevant skills rather than append duplicates, and never convert an unresolved failed attempt into a validated procedure. Autonomous review must not have unrestricted shell, arbitrary JavaScript, or unrestricted filesystem writes. Memory/skill changes need provenance and rollback/audit history.

### OpenAI Dreaming-inspired synthesis

The public OpenAI description establishes behavioral goals, not a disclosed implementation: background synthesis across conversations; carrying forward useful context; respecting preferences and constraints; updating temporal state; and avoiding reliance on explicit remember commands. SillyAgent should evaluate these behaviors directly without claiming to reproduce undisclosed internals.

## Target architecture

1. **Native core lifecycle:** capture user/assistant turns and inject retrieved context from SillyTavern core generation paths. No extension manifest or extension loader dependency.
2. **Durable queue:** every eligible capture writes an idempotent reflection job. A server-side coordinator owns enqueueing, worker startup, claiming, leases, retries, concurrency limits, cancellation, and recovery after server restart. Capture endpoints must not run expensive reflection inline.
3. **Server-side inference adapter:** background work must not depend on an open browser or a client-side quiet-generation callback. Provider/model selection must be explicit and persisted per user; credentials must be resolved server-side through SillyTavern's secret store and never copied into job payloads or logs. Start with provider contracts that can be implemented and tested end-to-end, then add adapters deliberately.
4. **Review pipeline:** a bounded model review reads relevant episodic history, accepted memories, and relevant skills; returns structured candidates/patches with evidence references; validators enforce scope, size, duplicate checks, temporal updates, secret/injection checks, and allowed operation types; validated operations go through the same audited stores/tool registry.
5. **Native tool harness:** keep server-side registry/schema validation as the execution authority. Integrate tool schemas and results into each supported provider's core generation loop; define an explicit fallback for providers without native function calling rather than silently pretending tools ran.
6. **Memory and skill controls:** expose status, history, delete/forget, queue state, and skill revisions through a core SillyAgent panel/API, not an extension-owned UI. Character evidence must never cross character partitions; ambiguous provenance fails closed.
7. **Operational behavior:** pending work survives backend/browser restarts. When the Termux process is not running, no worker can execute; jobs resume when the service starts again. The runtime must not require the browser to remain open for inference.
8. **Observability:** every job records trigger, mode, scope, attempts, provider/model identifier (never credentials), token/cost metadata where available, status, and last error. UI status is read-only and must not be the mechanism that starts work.

## Required verification

- Unit tests for capture idempotency, queue uniqueness, leases, retries, crash recovery, scope isolation, temporal updates, duplicate/conflict handling, and skill revisions/rollback.
- Worker integration tests with a deterministic fake provider: startup drains persisted work; provider failure retries; empty review completes without writes; writes preserve evidence and character scope; worker never blocks the foreground response.
- Core lifecycle tests for user/assistant capture, regeneration/swipe/continue exclusions, chat-completion and text-completion context injection, and absence of any extension loader dependency.
- Provider contract tests for structured output, malformed responses, timeout/abort, authentication failures, unsupported providers, and server-side secret resolution.
- End-to-end learning tests: user correction updates a relevant skill; repeated durable facts consolidate; outdated temporal facts are superseded; existing skills are patched rather than duplicated; unresolved failures are not saved as validated procedures; no-op is accepted.
- CI and Android/Termux runtime verification on a supported Node.js version, including a process restart with pending jobs.

## Current branch status

This is a specification, not a claim that the refactor is implemented. Source changes should be made against this checklist and verified before describing the feature as autonomous or native.
