# Agent-managed skills

SillyAgent skills are persistent, versioned Markdown procedures that the agent can discover, load on demand, improve, inspect, and roll back. They are stored separately from durable conversational memories in each user's data directory at `sillyagent/skills/<sha256-character-id>.sqlite`, with one database per character. The native runtime does not use a shared global skills database.

## Progressive disclosure

- GET /api/agent/tools/skills returns active skill metadata (slug, name, description, version, checksum), not the instruction body.
- skill_search lets the model search the metadata-only catalog.
- skill_read and GET /api/agent/tools/skills/:slug load one active skill only when it is relevant.
- skill_history and GET /api/agent/tools/skills/:slug/history inspect version metadata, checksums, change reasons, and audit events.

Skill content is Markdown instruction text. This feature does not execute skill bodies as code.

## Autonomous updates

The native harness activates validated skill revisions automatically. `skill_propose` validates the proposed name, description, instruction length, and minimum procedural detail, then activates the new revision. The previous active revision is retained as superseded, so the agent can inspect history and restore it later.

The native API deliberately normalizes `requireApproval` to `false`; requesting approval through `POST /api/agent/tools/skills/settings` does not stage new changes. Legacy pending revisions and review endpoints remain available for compatibility, but they are not the native harness's active write path. This keeps procedural learning autonomous instead of silently allowing a setting to disable it.

The `SILLYTAVERN_AGENTTOOLS_SKILLWRITESENABLED` environment setting defaults to `true`. Set it to `false` to disable skill creation, updates, and rollback without disabling memory writes or read-only skill discovery.

## Rollback

skill_rollback and POST /api/agent/tools/skills/:slug/rollback create a fresh version with the content of an earlier version. They never move the active pointer backward or delete history. The native harness validates and activates rollback content as a new revision.

## Operational notes

Persistent storage uses Node's built-in SQLite API and requires Node.js 22.5 or newer. The existing SillyTavern runtime can still start on its supported Node version, but this feature returns a storage error if built-in SQLite is unavailable. The catalog remains compact by design; read skill bodies only when they are useful for the current task.
