# Project Goal and Handoff

Last reviewed: 2026-10-25. Feature inventory is based on the current `main` README, architecture docs, and source/test layout.

## Goal
Maintain SillyAgent as a native, core-integrated SillyTavern fork with a bounded agent tool loop, durable scoped memory, reflection, procedural skills, and roleplay state. The harness belongs in the core backend flow, not as a required browser extension.

## Feature inventory

### Implemented / present in docs and source
- Core-integrated tool registry and runner, schema validation, toolset and write-permission checks, structured tool-call dispatch, tool-result persistence, and bounded per-turn execution.
- Persistent SQLite stores for captured events, memories, proposals, procedural skills, and roleplay state.
- Automatic capture/deduplication from internal chat/message lifecycle events; chat/character-scoped retrieval and lifecycle cleanup.
- Optional background reflection/dreaming worker with provider integration and structured-output validation.
- Native memory search/proposal, skill search/read/proposal/rollback, world state, character state, scene state/advance, active lore search, and dice tools.
- Core UI/backend integration and fork-specific architecture, installation, security, and attribution documentation.
- Dedicated SillyAgent CI and tests for agent modules/integration are present in the repository.

### Partial / configuration-dependent
- Automatic reflection only produces model-generated candidates when a reflection provider is configured, enabled, and has a valid credential. Capture and tool execution do not themselves require this provider.
- Tool use depends on the selected provider/model supporting the required structured function-call protocol.
- Check current CI and integration test results on the active branch; file presence is not a fresh passing result.

### Not supported without additional work
- Structured tool execution on providers/models that do not support the expected function-call protocol.
- Model-backed reflection with no configured/working reflection provider.

## Handoff notes for the next agent
1. Read `docs/sillyagent-architecture.md`, `docs/agent-tool-harness.md`, `docs/agent-memory-autonomy.md`, and `docs/agent-managed-skills.md` before modifying the runtime.
2. Preserve the separation between provider-specific transport normalization and the SillyAgent-owned logical turn/tool loop.
3. Preserve scoped storage, deduplication, deletion/tombstone behavior, permission checks, and execution budgets.
4. Add or update regression tests alongside runtime/lifecycle changes. Inspect the exact failing CI step before fixing it.
5. Update this document whenever tools, persistence rules, budgets, provider support, or lifecycle behavior changes.

## Validation
Use the repo's current CI and test scripts. No fresh passing CI claim is made here.
