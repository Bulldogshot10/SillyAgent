# SillyAgent

**A community-maintained SillyTavern fork with a native, core-integrated agent harness.**

> **SillyAgent is a fork of [SillyTavern](https://github.com/SillyTavern/SillyTavern).** It retains the upstream application as its foundation and adds fork-specific backend, lifecycle, and agent-runtime changes. This is an independent community fork, not an official SillyTavern release.

SillyTavern continues to provide the conversation UI, provider integrations, and user-data environment. SillyAgent adds agent capabilities directly into the fork's backend and core conversation flow. It is **not a browser extension** and does not require installing a separate SillyTavern extension.

## What SillyAgent adds

- **Native tool harness:** structured model tool calls run through a tool registry that validates tool names, input schemas, toolsets, and write permissions.
- **Persistent memory:** captured conversation turns, memories, and proposals are stored in SQLite with character/chat-scoped retrieval.
- **Automatic lifecycle capture:** internal SillyTavern message events drive capture and deduplication. No trigger word is required.
- **Background reflection:** an optional backend worker can turn bounded conversation context into durable memories and reusable procedural skills when a reflection provider is configured and enabled.
- **Procedural skills:** persistent character-scoped skills can be searched and managed through native tools.
- **Roleplay state tools:** world, character, and scene state, lore search, scene advancement, and dice rolls are available to the model through the harness.
- **Deletion-aware storage:** chat and character lifecycle hooks clean up associated state and guard against late asynchronous work recreating deleted data.

## How the flow works

```mermaid
flowchart TD
    U[User message] --> ST[SillyTavern core conversation flow]
    ST --> LLM[Configured model/provider]
    LLM --> DEC{Structured tool call?}
    DEC -- No --> A[Assistant response]
    DEC -- Yes --> RUN[SillyAgentRunner]
    RUN --> REG[Tool registry validation]
    REG --> TOOL[Execute authorized native tool]
    TOOL --> RESULT[Return tool result to model]
    RESULT --> LLM
    U --> LIFE[Internal message lifecycle]
    A --> LIFE
    LIFE --> CAP[Capture and deduplicate]
    CAP --> DB[(SQLite memory/event store)]
    CAP --> Q[Queue reflection job]
    Q --> WORKER[Background reflection worker]
    WORKER --> PROVIDER[Configured OpenAI-compatible model]
    PROVIDER --> VALID[Validate structured candidates]
    VALID --> DB
    DB --> RET[Scoped memory retrieval]
    RET --> ST
```

The harness has two connected paths: the live generation/tool-call loop and the lifecycle-driven memory path. Capture is driven by SillyTavern's internal events. Tools run when the model emits a supported structured tool call. Reflection jobs are queued automatically after assistant turns, then processed when reflection is enabled and its provider credentials are available.

**No manual trigger word, slash command, or repeated user action is needed.** Background reflection does require a valid provider/model/credential configuration and must be enabled. See the [architecture guide](docs/sillyagent-architecture.md) for the detailed execution flow.

## Quick start

Requirements: Git and Node.js 20 or newer, including npm.

```sh
git clone --single-branch --branch main https://github.com/Bulldogshot10/SillyAgent.git
cd SillyAgent
bash start.sh
```

The startup script installs production dependencies and launches the server. Open the local address printed in the terminal, commonly `http://127.0.0.1:8000`.

- [Installation guide](docs/installation.md), including Android Termux.
- [Architecture and execution flow](docs/sillyagent-architecture.md).
- [Documentation index](docs/README.md).

## Background reflection setup

Background reflection is disabled by default. To enable it, configure an OpenAI-compatible `/chat/completions` endpoint, model identifier, and a credential reference in:

```text
<SillyTavern data root>/sillyagent/reflection-provider.json
```

The credential field refers to a secret already stored in SillyTavern's secret manager. **Do not paste the raw API key into the reflection configuration file.** The [installation guide](docs/installation.md#configuring-background-reflection) documents the settings and network requirements.

## Project status

The `main` branch is the primary development branch for this fork and includes the SillyAgent core integration. APIs and behavior may evolve as development continues. SillyAgent is built around SillyTavern's existing application, provider, and user-data systems; it is not a standalone framework that can be dropped into an unrelated host without adaptation.

## Upstream and support

- Upstream SillyTavern: https://github.com/SillyTavern/SillyTavern
- Upstream documentation: https://docs.sillytavern.app/
- Upstream community: https://discord.gg/sillytavern

Report issues specific to this fork in this repository. For behavior reproduced on an unmodified upstream SillyTavern installation, consult the upstream project and documentation.

## License and third-party notices

This fork retains the repository's **GNU Affero General Public License v3.0 (AGPL-3.0)**. See [LICENSE](LICENSE), [NOTICE](NOTICE), and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). The third-party notice includes the dependency inventory associated with the checked-in `package-lock.json`; each dependency's own license file remains authoritative for its exact terms.
