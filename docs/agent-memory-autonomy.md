# Native autonomous memory and reflection

SillyAgent's memory system is a first-party fork feature. The capture and retrieval hooks are initialized from `public/script.js`; the settings drawer is part of `public/index.html`; storage, the job queue, reflection provider, and worker run in the Node server. There is no SillyAgent memory extension manifest or extension-loader dependency.

## Scope and isolation

Each SillyTavern data root has a `sillyagent/memory.sqlite` event/memory database plus a separate procedural-skill database per character at `sillyagent/skills/<sha256-character-id>.sqlite`. Skill database filenames are derived from the character identifier rather than using one shared global skill pool. A legacy root-level `sillyagent/skills.sqlite` is not copied into character partitions or used by the native runtime. Persistent memory candidates are restricted to the active character or the exact active chat. Chat IDs are namespaced with the character ID when one is selected. Relevant retrieval searches only the current chat and active character, and long-horizon dreaming filters captured evidence to the active character. The agent tools map legacy `user` scope requests into the active character or chat; the automatic reflection worker never writes a global user memory.

Older installations may contain legacy global-user records. The migration moves a record into a character partition only when stored provenance or nearby captured turns identify one owner. Ambiguous records remain quarantined in legacy scope and are excluded from automatic retrieval. They are never cloned across characters.

## Capture, queue, and background work

Core message lifecycle events capture user and assistant turns as bounded, deduplicated evidence events. Captured raw turns are not memories by themselves. Each newly captured assistant reply automatically creates or refreshes a durable review job; there is no "remember this" phrase, tool-call requirement, slash command, or turn-count milestone. Pending jobs coalesce within the same chat/character partition so a busy roleplay does not build an unbounded queue while the model is reviewing an earlier snapshot. Queue rows, claim tokens, leases, retries, completion, and failures live in SQLite.

The worker starts with the server process for the default data root and starts lazily for any additional user data root when its native API is accessed. It keeps polling without a browser tab, and abandoned work becomes claimable again after its lease expires. If the server process itself is stopped, no code can execute while it is stopped; pending jobs remain persisted and resume when that server starts again.

Configure the background provider once in the native SillyAgent Agent Core panel. The worker calls an explicitly configured OpenAI-compatible `/chat/completions` endpoint and loads the selected credential from SillyTavern's server-side Secrets store. Non-loopback providers must use HTTPS; plain HTTP is allowed only for local loopback endpoints such as `localhost` for local inference. This avoids sending prompts or API credentials over cleartext remote connections. Only the endpoint, model ID, and secret-key identifier are persisted in `reflection-provider.json`; API key values are not stored in the agent config or queued jobs. Background reflection is disabled until a valid endpoint and model have been configured.

## Dreaming-inspired synthesis and self-improvement

Each automatic post-assistant-turn review includes a bounded recent window from the active chat plus bounded prior-chat evidence belonging to the same character. Transcript records mark current-chat evidence so a chat-scoped memory cannot be written from another chat's evidence; durable character memories may draw on continuity across that character's chats. Existing legacy dreaming jobs remain processable after upgrade. The configured model is asked for structured candidates with evidence event IDs. Candidate counts, field lengths, scope, event provenance, duplicates, credential-like strings, and memory-kind values are checked before persistence. Invalid model output is treated as a failed job, not as an empty success. A no-op is valid when the conversation does not support durable changes.

Memory updates are temporal: each evidence event carries a timestamp, the reflection prompt includes existing memory IDs and update times, and an update may supersede an active memory only when it names an existing memory in the same scope and links the replacement to new captured evidence. Superseded records are removed from active retrieval indexes and lineage IDs are retained in audit events.

This event-driven background review follows the public design direction described by Hermes Agent's after-turn background self-improvement review and OpenAI's public Dreaming V3 announcement: curating useful information from natural conversation, accounting for stale facts and time, and synthesizing cross-conversation context. OpenAI has not published the private implementation, so SillyAgent implements these as design principles rather than claiming to reproduce OpenAI's internals. See [Hermes persistent memory docs](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory) and [OpenAI: Dreaming](https://openai.com/index/chatgpt-memory-dreaming/).

The same reflection pass may propose reusable procedural skills. Skills are activated without per-item human approval only when the captured evidence includes a successful outcome or a user correction; unresolved failures, unsupported speculation, and one-off actions do not qualify. Skills use the versioned `SkillStore`, and are stored separately from factual/episodic memory.

Provider errors leave the durable job available for bounded retries, up to three attempts. Credentials and raw upstream response bodies are not written into worker errors. Provider configuration is explicit, but there is no per-memory or per-skill approval step.

## Tool harness

The built-in server tool registry is exposed through `/api/agent/tools`, while `SillyAgentRunner` owns each logical assistant turn. The provider adapter normalizes vendor-specific function calls, but the runner executes SillyAgent tools directly through `/api/agent/tools/execute`, persists the result, and controls continuation and tool budgets. Automatic capture, retrieval, and reflection do not depend on the model remembering to call a memory tool. See [native agent harness architecture](agent-tool-harness.md) for the runner's turn loop, scopes, permissions, and budgets. See [native agent harness architecture](agent-tool-harness.md) for tool lifecycle, state scopes, permissions, and concurrency behavior.

## Runtime requirement

Persistent storage uses Node's built-in `node:sqlite` API and SQLite FTS5, requiring Node.js 22.5 or later. The repository's general engine floor remains Node.js 20 so the rest of SillyTavern can still run on older versions, but SillyAgent's persistent memory and worker cannot. The server logs a feature-specific warning instead of preventing ordinary SillyTavern startup.
