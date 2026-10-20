# Autonomous persistent memory and dreaming

SillyAgent's memory loop is autonomous by default. Each SillyTavern user has a persistent SQLite store at `data/sillyagent/memory.sqlite`.

## Automatic lifecycle

- User and assistant turns are captured automatically into the active chat's event history.
- Relevant approved memories are retrieved and injected before a response.
- Dreaming runs automatically every 12 newly captured turns and scans the current chat for recurring topics.
- Native function calling is enabled by the SillyAgent Memory extension for supported Chat Completion providers. The registered SillyAgent tools are offered automatically with `tool_choice: "auto"`.
- The model is instructed to search memory when relevant and call `sillyagent_memory_propose` proactively for durable facts, preferences, goals, relationship continuity, and other useful information.
- The model determines scope without user intervention: `user` for stable information about the user, `character` for character identity/backstory/continuity, and `chat` for transient session or task context. The server infers a fallback scope when a tool call omits one.
- New memory writes are accepted automatically. Legacy pending proposals are automatically accepted when the autonomous lifecycle initializes.

The memory panel does not expose toggles for automation, an approval queue, a manual dreaming button, or a scope picker. It lists accepted memories from all scopes in one view. Refresh only reloads the display; it does not trigger dreaming.

Captured raw turns and accepted memories remain separate. Clearing captured history removes only captured user/assistant turn events for the active chat; it keeps accepted memories. Dreaming v1 is a deterministic recurring-topic detector scoped to the current chat. Cross-chat user and character memories are created through the autonomous tool-calling path, which uses model judgement and the scope policy above. The engine does not yet perform independent factual verification or rewrite its own source code.

## Provider compatibility

Automatic native function calling applies when SillyTavern is using Chat Completion with a provider/model supported by its ToolManager, including Google AI Studio/MakerSuite and compatible OpenAI-style endpoints that implement tool calls. On a provider or completion mode without native tool-call support, automatic capture, retrieval, and periodic dreaming still run, but the model cannot execute the registered function tools.

## API compatibility

The memory settings and proposal review endpoints remain for compatibility with existing installs. The effective lifecycle forces capture, retrieval, and dreaming on and disables human approval; stored legacy opt-outs do not disable these features. The `SILLYTAVERN_AGENTTOOLS_MEMORYPROPOSALSENABLED=false` environment variable can still disable memory write tools for an operator who explicitly wants writes disabled.
