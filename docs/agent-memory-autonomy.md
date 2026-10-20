# Autonomous persistent memory and dreaming

SillyAgent's memory loop is autonomous by default. Each SillyTavern user has a persistent SQLite store at `data/sillyagent/memory.sqlite`.

## Automatic lifecycle

- User and assistant turns are captured automatically into the active chat's event history.
- Relevant approved memories are retrieved and injected before a response.
- Dreaming runs automatically every 12 newly captured turns. It scans the active chat and a bounded window of recent captured turns across chats.
- Native function calling is enabled by the SillyAgent Memory extension for supported Chat Completion providers. The registered SillyAgent tools are offered automatically with `tool_choice: "auto"`.
- The model is instructed to search memory when relevant and call `sillyagent_memory_propose` proactively for durable facts, preferences, goals, relationship continuity, and other useful information.
- The model determines scope without user intervention. Every durable memory, including facts/preferences about the user, is stored inside the active character's own partition. Character identity/backstory/relationship continuity uses that same character partition; transient task/session context stays in the current chat. No global user memory is used in automatic retrieval.
- New memory writes are accepted automatically. Legacy pending proposals are automatically accepted when the autonomous lifecycle initializes.

The memory panel does not expose toggles for automation, an approval queue, a manual dreaming button, or a scope picker. It automatically lists accepted memories for the active character and current chat only. Refresh only reloads the display; it does not trigger dreaming.

Captured raw turns and accepted memories remain separate. Clearing captured history removes only captured user/assistant turn events for the active chat; it keeps accepted memories. Dreaming v2 detects recurring topics in the active chat plus a bounded cross-chat history window restricted to the active character ID. A topic repeated only within one chat stays chat-scoped; repetition across several chats belonging to the same character becomes character-scoped. Evidence from any other character is excluded before consolidation, and dreaming never writes to a global user scope. The model-driven memory tools store durable user facts/preferences and character canon/continuity inside that active character's partition, while task-local context stays chat-scoped. The engine does not yet perform independent factual verification or rewrite its own source code.

## Legacy memory migration

Opening an existing SQLite store automatically migrates old global `user` memories into character partitions. The migrator first uses saved character metadata, then correlates the original memory write timestamp with captured chat turns. If the database only identifies one character, it assigns the legacy record to that character. Matching memories are merged without duplication and the full-text indexes are refreshed.

If a legacy memory has no reliable character provenance, it remains marked as unresolved legacy data and is excluded from every automatic retrieval path. The migrator does not clone uncertain memories into every character or guess an owner, because either choice can leak one character's history into another. It retries on subsequent store opens, so importing matching chat history later can make additional records migratable. No manual migration trigger is required.

## Provider compatibility

Automatic native function calling applies when SillyTavern is using Chat Completion with a provider/model supported by its ToolManager, including Google AI Studio/MakerSuite and compatible OpenAI-style endpoints that implement tool calls. On a provider or completion mode without native tool-call support, automatic capture, retrieval, and periodic dreaming still run, but the model cannot execute the registered function tools.

## API compatibility

The memory settings and proposal review endpoints remain for compatibility with existing installs. The effective lifecycle forces capture, retrieval, and dreaming on and disables human approval; stored legacy opt-outs do not disable these features. The `SILLYTAVERN_AGENTTOOLS_MEMORYPROPOSALSENABLED=false` environment variable can still disable memory write tools for an operator who explicitly wants writes disabled.
