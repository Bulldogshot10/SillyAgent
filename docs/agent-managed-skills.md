# Agent-managed skills

SillyAgent skills are persistent, versioned Markdown procedures that the agent can discover, load on demand, improve, review, and roll back. They are stored separately from durable conversational memories in each user's data/sillyagent/skills.sqlite database.

## Progressive disclosure

- GET /api/agent/tools/skills returns active skill metadata (slug, name, description, version, checksum), not the instruction body.
- skill_search lets the model search the metadata-only catalog.
- skill_read and GET /api/agent/tools/skills/:slug load one active skill only when it is relevant.
- skill_history and GET /api/agent/tools/skills/:slug/history inspect version metadata, checksums, change reasons, and audit events.

Skill content is Markdown instruction text. This feature does not execute skill bodies as code.

## Autonomous updates and optional approval

Writes are autonomous by default. skill_propose validates the proposed name, description, instruction length, and minimum procedural detail, then immediately activates a new revision. The previously active revision is retained as superseded, so the agent can inspect history and restore it later.

Human review is optional and off by default. Set requireApproval to true with POST /api/agent/tools/skills/settings to stage future changes as pending. Pending versions do not replace the active skill until approved. Approve or reject a revision with:

GET /api/agent/tools/skills/:slug/revisions/:version reads a particular revision, including pending content, for review. POST /api/agent/tools/skills/:slug/revisions/:version/review

JSON body: {"decision":"approve"} or {"decision":"reject"}.

Set requireApproval back to false to return to autonomous activation. The optional SILLYTAVERN_AGENTTOOLS_SKILLSREQUIRESAPPROVAL environment override can enforce a global policy independent of per-user settings.

The independent SILLYTAVERN_AGENTTOOLS_SKILLWRITESENABLED environment setting defaults to true. Set it to false to disable skill creation, updates, and rollback without disabling memory writes or read-only skill discovery.

## Rollback

skill_rollback and POST /api/agent/tools/skills/:slug/rollback create a fresh version with the content of an earlier version. They never move the active pointer backward or delete history. When approval is enabled, rollback content is staged like any other revision.

## Operational notes

Persistent storage uses Node's built-in SQLite API and requires Node.js 22.5 or newer. The existing SillyTavern runtime can still start on its supported Node version, but this feature returns a storage error if built-in SQLite is unavailable. The catalog remains compact by design; read skill bodies only when they are useful for the current task.
