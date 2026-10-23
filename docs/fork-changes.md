# SillyAgent Fork Change Inventory

**Project:** SillyAgent, a community-maintained fork of [SillyTavern](https://github.com/SillyTavern/SillyTavern)  
**Modification notice date:** 2026-10-23  
**License:** [GNU Affero General Public License v3.0](../LICENSE)

This file summarizes the major fork-specific additions and the principal upstream integration points in the `main` branch as of the date above. It is a practical change inventory, not a claim that upstream authorship has transferred to this fork. Existing upstream notices remain applicable. New commits may add to or change this inventory.

## Functional changes

### Native harness and structured tool execution

Added `src/agent/tool-registry.js`, `src/agent/builtin-tools.js`, `src/endpoints/agent-tools.js`, `src/middleware/agent-tools-body-limit.js`, and `public/scripts/agent-runner.js`.

These components provide a native endpoint and execution path for structured model tool calls, registry/schema validation, allowed toolsets, write permissions, bounded rounds and call counts, and tool-result handling. The harness is integrated into the fork's core flow rather than being distributed as a browser extension.

### Memory, reflection, and procedural skills

Major added core modules include:

- `src/agent/memory-store.js`: persistent event, memory, proposal, and scoped retrieval storage backed by SQLite.
- `src/agent/runtime.js`: runtime initialization, store access, scoped identifiers, and chat/character lifecycle coordination.
- `src/agent/dreaming.js`, `src/agent/reflection-provider.js`, and `src/agent/reflection-worker.js`: background reflection jobs, provider handling, and structured candidate validation.
- `src/agent/skill-store.js` and `src/agent/skill-tools.js`: persistent procedural skill storage and tools.
- `src/agent/roleplay-state-store.js` and `src/agent/roleplay-tools.js`: persistent roleplay state and related tools.
- `public/scripts/sillyagent-memory.js` and `public/scripts/sillyagent-memory-context.js`: browser-side memory/context integration.

The runtime captures turns from internal message lifecycle events and scopes data to chats and/or characters. Background reflection is queued automatically but runs only when its provider is configured and enabled. It does not rely on users typing a special trigger word.

### Roleplay state and built-in tool families

Native tool families include memory search and proposals, procedural skill search/management, world state, character state, scene state and advancement, lore search, and dice tools. The registry validates tool requests before execution.

### Principal upstream integration points modified

The following upstream areas are modified to connect SillyAgent to SillyTavern's application flow:

- `src/server-main.js` and `src/server-startup.js`: backend route/runtime integration and startup initialization.
- `src/endpoints/backends/chat-completions.js`: integration with the supported generation/tool-calling path.
- `src/endpoints/chats.js` and `src/endpoints/characters.js`: chat/character lifecycle and associated state cleanup/reactivation.
- `src/prompt-converters.js`: prompt/context integration.
- `public/script.js`, `public/index.html`, `public/style.css`, and `public/css/sillyagent-agent.css`: UI integration and styling.
- `public/scripts/openai.js` and `public/scripts/tool-calling.js`: model tool-call handling integration.
- `default/config.yaml` and `package.json`: fork configuration and package metadata.
- `.github/workflows/pr-check-merge-conflicts.yaml`: workflow adjustment.

## Documentation and project maintenance

Fork-specific docs and maintenance files include:

- `docs/sillyagent-architecture.md`: architecture and execution flow.
- `docs/installation.md`: installation and updates for desktop/server environments and Android Termux.
- `docs/agent-tool-harness.md`: harness and tool execution.
- `docs/agent-memory-autonomy.md`: automatic capture, memory, and reflection.
- `docs/agent-managed-skills.md`: procedural skills.
- `docs/README.md`: documentation index.
- `NOTICE`: fork attribution, modification notice, date, and summary of major changes.
- `THIRD_PARTY_NOTICES.md`: dependency inventory based on the checked-in `package-lock.json`.
- `.github/workflows/sillyagent-ci.yml`: lint and test workflow for the fork.
- `tests/agent-*.test.js` and `tests/prompt-converters.test.js`: tests covering agent modules and integration points.

## Corresponding source and license

The source code for this fork is available at no charge from the public repository:
https://github.com/Bulldogshot10/SillyAgent

The running application's options menu links directly to this source, the AGPL-3.0 license, this modification notice, and the third-party notices.

## Provenance and licensing

SillyAgent retains the upstream AGPL-3.0 license in `LICENSE`. Original upstream copyright and license notices should remain intact. The fork notice and this inventory supplement them and do not replace the upstream notices or the individual licenses of bundled third-party packages.
