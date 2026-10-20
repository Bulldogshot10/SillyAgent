# Autonomous persistent memory and dreaming

SillyAgent's memory loop is autonomous by default. Each SillyTavern user has a persistent SQLite store at `data/sillyagent/memory.sqlite`.

## Automatic lifecycle

- Every user and assistant turn is captured automatically into a durable SQLite event log.
- The backend queues a reflection job after every four captured turns. Every third batch is a deeper dreaming pass; ordinary batches perform low-cost extraction. Queue rows, attempts, leases, completion, and failures persist in SQLite.
- The SillyTavern extension drains the queue in the background using the currently configured model's quiet-generation API. It does not depend on a user saying "remember this" or on the model voluntarily calling a memory tool. If a provider request fails, the job is retried with backoff up to three attempts. Pending jobs survive a browser or backend restart and are drained when the extension next becomes active.
- Routine extraction reviews the latest turns of the job's chat. Dreaming reviews a bounded set of captured turns from the same active character across chats, synthesizing durable patterns rather than simply storing repeated keywords.
- The model returns structured JSON candidates; the extension validates the shape, bounds candidate counts and lengths, skips exact duplicates, rejects obvious credential patterns, and then submits accepted writes through the same scoped memory-store API used by the tool harness.
- Relevant accepted memories are retrieved and injected before a response. Native tool calling is enabled for supported Chat Completion providers, but autonomous extraction and dreaming do not rely on the model choosing to call a memory tool during the user-facing reply.
- The model does not select a global user scope. Durable user facts/preferences/goals and character identity/backstory/relationship continuity live inside the active character partition; temporary task/session context may live in the current chat. Different characters' evidence is filtered before reflection.

The panel reports accepted memories, pending proposals, captured events, and reflection queue state. Refresh only reloads the display; it does not enqueue or execute work. The UI does not expose a manual dreaming button, a scope picker, or ordinary-memory approval actions.

Captured raw turns and accepted memories remain separate. Clearing captured history removes only captured user/assistant turn events for the active chat; it keeps accepted memories. The older deterministic topic detector remains available as a testable engine, but the production auto-consolidation path uses model-generated reflection candidates. The harness currently uses the browser-side SillyTavern provider API to perform inference; while the browser is unavailable, durable jobs wait in SQLite and resume when the extension comes back. A fully headless Node-side inference worker would need an explicit server-side provider adapter and secure provider-credential handling, and is not claimed by this implementation slice.


## Legacy memory migration

Opening an existing SQLite store automatically migrates old global `user` memories into character partitions. The migrator first uses saved character metadata, then correlates the original memory write timestamp with captured chat turns. If the database only identifies one character, it assigns the legacy record to that character. Matching memories are merged without duplication and the full-text indexes are refreshed.

If a legacy memory has no reliable character provenance, it remains marked as unresolved legacy data and is excluded from every automatic retrieval path. The migrator does not clone uncertain memories into every character or guess an owner, because either choice can leak one character's history into another. It retries on subsequent store opens, so importing matching chat history later can make additional records migratable. No manual migration trigger is required.

## Provider compatibility

Automatic native function calling applies when SillyTavern is using Chat Completion with a provider/model supported by its ToolManager, including Google AI Studio/MakerSuite and compatible OpenAI-style endpoints that implement tool calls. On a provider or completion mode without native tool-call support, automatic capture, retrieval, and periodic dreaming still run, but the model cannot execute the registered function tools.

## API compatibility

The memory settings and proposal review endpoints remain for compatibility with existing installs. The effective lifecycle forces capture, retrieval, and dreaming on and disables human approval; stored legacy opt-outs do not disable these features. The `SILLYTAVERN_AGENTTOOLS_MEMORYPROPOSALSENABLED=false` environment variable can still disable memory write tools for an operator who explicitly wants writes disabled.
