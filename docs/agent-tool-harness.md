# Native SillyAgent agent harness

SillyAgent is wired into SillyTavern's core and owns the model/tool loop. It does not invoke SillyTavern's recursive `ToolManager.invokeFunctionTools` path. SillyTavern's provider adapters remain responsible for transport-specific request formatting and response normalization; the SillyAgent runner owns the logical assistant turn, dispatch policy, budgets, tool result persistence, and continuation.

## Execution lifecycle

1. The core prompt-building path assembles the conversation. For supported models, the provider adapter obtains the registered function schemas and includes them in the outbound request only while the SillyAgent turn policy allows tool calls.
2. The one-step generation function, `generateStep`, performs exactly one provider round. If it receives a function-call response, it returns a structured handoff to `SillyAgentRunner`; it does not execute tools or recursively call `Generate`.
3. `SillyAgentRunner` normalizes provider-specific tool-call shapes, executes calls sequentially, collects success/error results, persists tool results into the conversation, and starts the next model step. It owns a per-turn budget of eight tool rounds and 24 calls, then requests a final tool-free generation. The legacy SillyTavern recursive-tool limit does not control this budget. The allow/deny decision is passed as a request-scoped policy through prompt budgeting, response handling, and provider payload construction, so overlapping generations cannot alter each other’s tool availability.
4. SillyAgent server tools are dispatched directly to `POST /api/agent/tools/execute` with the model-supplied name and arguments plus current chat/character/lore context. Non-SillyAgent user tools retain a compatibility dispatch adapter, but they are also executed under the SillyAgent-owned loop.
5. Tool results become part of the conversation before the next step, so the model can observe the result, revise its plan, and decide whether another call is useful. Budget exhaustion leads to a final response instead of unbounded recursion.

This separates the agent controller from provider transport. We intentionally reuse SillyTavern's vendor-specific request/response adapters rather than duplicating every upstream API's authentication, streaming, reasoning-signature, and tool-call wire format.

The native harness has its own `sillyagent_harness_enabled` setting. It does not depend on SillyTavern's legacy `function_calling` toggle or `tool_call_recurse_limit`; per-turn budgets are enforced by `SillyAgentRunner`. The selected provider/model must still implement the function-call protocol. When a request advertises tools, the server converts incompatible legacy prompt post-processing presets to tool-preserving equivalents and preserves assistant tool-call / tool-result pairing across rounds.

## Registered tool surface

| Server tool | Purpose | Access |
| --- | --- | --- |
| `memory_search` / `memory_propose` | Read relevant memory and persist durable facts/preferences/events | Read / write |
| `skill_search` / `skill_read` | Progressive disclosure of procedural skills | Read |
| `skill_propose` / `skill_rollback` | Versioned skill improvement and rollback | Write |
| `world_get_state` / `world_update_state` | Read or patch shared setting state for the active World Info book set, falling back to the active chat when no books are selected | Read / write |
| `character_get_state` / `character_update_state` | Read or patch persistent dynamic state for the active character | Read / write |
| `scene_get_state` / `scene_advance` | Read current scene metadata and commit meaningful scene transitions | Read / write |
| `lore_search` | Search only World Info books active for the current SillyTavern context | Read |
| `dice_roll` / `roleplay_roll_dice` | Cryptographically fair, bounded random rolls | Read |

The model-facing descriptions tell it when tools are useful, when to read before writing, and not to advance a scene on every ordinary message. Tool names are reserved under `sillyagent_` in the browser so server functions cannot overwrite user-registered tools.

## Durable state and scope

`src/agent/roleplay-state-store.js` owns `sillyagent/roleplay-state.sqlite` under each SillyTavern data root. State is stored as versioned JSON partitions with a separate append-only change history. The schema distinguishes `world`, `character`, and `scene` state types.

World state is scoped to a stable hash of the active World Info book-name set, so chats using the same world share world facts; with no active books it falls back to the active chat scope. Scene state is chat-scoped. Chat-scoped state and captured memories hash the character/chat pair when a single character is active, so two characters using similarly named chat files cannot read each other's state. Character state uses the active character's ID and is kept separate from the character card's static description and from memory reflection. Group chats do not silently inherit the last individually selected character's state.

State changes use JSON Merge Patch semantics: nested objects merge, arrays replace, and `null` removes a key. Each successful update increments a version and records the patch, source tool, and timestamp. Writers can pass the version returned by a read as `expectedVersion`; stale writes return a conflict instead of silently overwriting newer state. State keys, nesting depth, array lengths, string length, patch size, and total partition size are bounded. Credential-like secret strings are rejected.

`scene_advance` is a specialized commit operation. It increments `sceneNumber`, saves a concise summary and transition timestamp, and can update location, time, participants, open threads, and resolved threads. If no explicit open-thread list is supplied, resolved thread names are removed from the stored list. This is a structured checkpoint, not an automatic summary after every reply.

## Lore access

The browser passes active World Info book names from SillyTavern's current context; the model cannot select arbitrary filesystem paths. `lore_search` reads only those books under the user's World Info directory, skips symlinks and malformed/oversized files, applies a total read budget, ranks entries by query-term matches, and truncates returned entry content. Lore entries are untrusted reference data, not instructions. The tool is read-only and never edits a lorebook.

## Permissions and failure behavior

All tool definitions are server-owned and schema-validated. The runtime applies per-tool read/write/external permissions, toolset allow-lists, bounded timeouts, and a 32 KiB maximum JSON result. Write operations for the world, character, and scene toolsets can be disabled with `SILLYTAVERN_AGENTTOOLS_ROLEPLAYSTATEWRITESENABLED=false`. Memory and skill write policies retain their existing `SILLYTAVERN_AGENTTOOLS_MEMORYPROPOSALSENABLED` and `SILLYTAVERN_AGENTTOOLS_SKILLWRITESENABLED` switches.

Character state tools require an active single character. World and scene tools require an active chat. Lore search returns no matches when no active books are available. A state conflict asks the model to re-read and retry; an unavailable store or failed tool becomes a tool result so the model can recover. Arbitrary shell execution, arbitrary JavaScript evaluation, unrestricted filesystem tools, or provider credentials are not exposed.

## Relationship to automatic memory

Automatic user/assistant turn capture, relevance-based memory retrieval, and post-assistant background reflection are separate from explicit tools. They work even if the model never calls `memory_search` or `memory_propose`. Reflection uses evidence IDs, scope checks, duplicate detection, bounded structured output, and same-character history; it does not write the roleplay state tables. Conversely, state tools handle immediate explicit state transitions while the conversation is in progress.

See [native autonomous memory and reflection](agent-memory-autonomy.md) for the event-driven memory pipeline.

## Verification

Unit and endpoint tests cover runner round budgets, tool-free final responses, registry contracts, permission denials, tool execution, isolated character/chat state, JSON merge patches, version conflicts, scene advancement, active-lorebook filtering, dice bounds, autonomous memory, durable reflection jobs, and skill revisions.
