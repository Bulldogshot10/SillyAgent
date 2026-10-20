# Autonomous persistent memory and dreaming

SillyAgent's persistent-memory loop is autonomous by default. Each user's memory store lives at `data/sillyagent/memory.sqlite`.

## Default behavior

- Automatic retrieval is enabled.
- User and assistant turns are captured into the active chat's event history.
- Dreaming runs every 12 newly captured turns and looks for recurring topics.
- New memory proposals are accepted immediately and become searchable by retrieval.
- Human review is optional and disabled by default.

Captured raw turns and accepted long-term memories are separate. Clearing captured history removes the raw turn events for a chat while preserving accepted memories. Memory records remain scoped to user, character, or chat and search respects those boundaries.

## Optional human review

Enable review for new memories with:

`POST /api/agent/tools/memory/settings`

JSON body:

`{"requireApproval": true}`

When enabled, new memory and dreaming proposals remain pending and are excluded from retrieval until approved. Return to autonomous mode with `{"requireApproval": false}`. Pending proposals created under the earlier review-only behavior are automatically accepted when the settings endpoint observes that review is disabled, including a settings change back to autonomous mode.

The effective setting can be checked with `GET /api/agent/tools/memory/settings`. A global override can be set with `SILLYTAVERN_AGENTTOOLS_MEMORYREQUIRESAPPROVAL=true` or `false`. When unset, the per-user setting applies.

The separate `SILLYTAVERN_AGENTTOOLS_MEMORYPROPOSALSENABLED=false` environment variable disables memory write tools while leaving retrieval available.

## Dreaming flow

The deterministic v1 dreaming engine analyzes captured turns within a single chat, identifies recurring topics, and stores reviewable/accepted memory candidates through the same policy as regular agent memory writes. It does not mix evidence across chats. Repeated dreams do not create duplicates when the same candidate is already accepted or pending.

Dreaming currently consolidates recurring topics into memories. It does not yet autonomously rewrite the agent's own source code or run model-based evaluations of whether a memory is factually correct. That can be layered onto this lifecycle separately.
