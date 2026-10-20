import { toolRegistry } from './tool-registry.js';

const SEARCH_SCHEMA = {
    type: 'object',
    properties: {
        query: { type: 'string', minLength: 1, maxLength: 200 },
        limit: { type: 'integer', minimum: 1, maximum: 10 },
    },
    required: ['query'],
    additionalProperties: false,
};

const READ_SCHEMA = {
    type: 'object',
    properties: { slug: { type: 'string', minLength: 1, maxLength: 80 } },
    required: ['slug'],
    additionalProperties: false,
};

const PROPOSE_SCHEMA = {
    type: 'object',
    properties: {
        slug: { type: 'string', minLength: 1, maxLength: 80 },
        name: { type: 'string', minLength: 2, maxLength: 120 },
        description: { type: 'string', minLength: 8, maxLength: 500 },
        content: { type: 'string', minLength: 80, maxLength: 12000 },
        changeReason: { type: 'string', minLength: 1, maxLength: 1000 },
    },
    required: ['name', 'description', 'content'],
    additionalProperties: false,
};

const HISTORY_SCHEMA = {
    type: 'object',
    properties: {
        slug: { type: 'string', minLength: 1, maxLength: 80 },
        limit: { type: 'integer', minimum: 1, maximum: 20 },
    },
    required: ['slug'],
    additionalProperties: false,
};

const ROLLBACK_SCHEMA = {
    type: 'object',
    properties: {
        slug: { type: 'string', minLength: 1, maxLength: 80 },
        targetVersion: { type: 'integer', minimum: 1, maximum: 1000000 },
        reason: { type: 'string', minLength: 1, maxLength: 1000 },
    },
    required: ['slug', 'targetVersion'],
    additionalProperties: false,
};

function requireStore(context) {
    if (!context?.skillStore) throw new Error('Persistent skill storage is unavailable.');
    return context.skillStore;
}

function summarizeRevision(revision) {
    if (!revision) return null;
    return {
        slug: revision.slug,
        version: revision.version,
        name: revision.name,
        description: revision.description,
        checksum: revision.checksum,
        status: revision.status,
        source: revision.source,
        changeReason: revision.changeReason,
        parentVersion: revision.parentVersion,
        evaluation: revision.evaluation,
        createdAt: revision.createdAt,
        activatedAt: revision.activatedAt,
    };
}

/**
 * Register first-party agent-managed skill tools. The model sees a compact skill
 * catalog first and must call skill_read to load a full skill on demand.
 */
export function registerSkillTools(registry = toolRegistry) {
    if (!registry.hasTool('skill_search')) {
        registry.registerTool({
            name: 'skill_search',
            description: 'Search the active procedural-skill catalog by name, slug, or description. Returns metadata only; call skill_read for the full instructions when a skill is relevant.',
            toolset: 'skills',
            permission: 'read',
            timeoutMs: 2000,
            inputSchema: SEARCH_SCHEMA,
            execute: async ({ input, context }) => ({
                query: input.query,
                skills: requireStore(context).searchSkills({
                    query: input.query,
                    limit: input.limit ?? 10,
                }),
                disclosure: 'metadata-only; read a selected skill explicitly',
            }),
        });
    }

    if (!registry.hasTool('skill_read')) {
        registry.registerTool({
            name: 'skill_read',
            description: 'Load the full Markdown instructions for one active skill after skill_search identifies it as relevant. Reads active versions only.',
            toolset: 'skills',
            permission: 'read',
            timeoutMs: 2000,
            inputSchema: READ_SCHEMA,
            execute: async ({ input, context }) => {
                const skill = requireStore(context).readSkill(input.slug);
                return skill
                    ? { found: true, skill }
                    : { found: false, slug: input.slug, message: 'No active skill exists with that slug.' };
            },
        });
    }

    if (!registry.hasTool('skill_propose')) {
        registry.registerTool({
            name: 'skill_propose',
            description: 'Create or improve a reusable procedural skill from a successful workflow, a discovered technique, or a task failure analysis. Write actionable Markdown instructions, include when to use the skill and concrete steps, preserve useful existing behavior, and explain the change. Revisions are versioned and validated. They activate automatically by default; if the owner enabled approval, the revision remains pending instead.',
            toolset: 'skills',
            permission: 'write',
            timeoutMs: 5000,
            inputSchema: PROPOSE_SCHEMA,
            execute: async ({ input, context }) => {
                const result = requireStore(context).proposeSkill({
                    slug: input.slug,
                    name: input.name,
                    description: input.description,
                    content: input.content,
                    changeReason: input.changeReason ?? 'Agent synthesized a reusable procedure from task experience.',
                    source: 'agent',
                    requireApproval: context.requireSkillApproval,
                });
                return {
                    created: result.created,
                    duplicate: result.duplicate,
                    requiresApproval: result.requiresApproval,
                    revision: summarizeRevision(result.revision),
                    message: result.requiresApproval
                        ? 'Revision staged for review; the current active version is unchanged until approval.'
                        : 'Revision validated and activated. The previous version remains available for rollback.',
                };
            },
        });
    }

    if (!registry.hasTool('skill_history')) {
        registry.registerTool({
            name: 'skill_history',
            description: 'Inspect version metadata, checksums, activation status, and change reasons for a skill. Use this before revising or rolling back a procedure.',
            toolset: 'skills',
            permission: 'read',
            timeoutMs: 2000,
            inputSchema: HISTORY_SCHEMA,
            execute: async ({ input, context }) => ({
                slug: input.slug,
                revisions: requireStore(context).getHistory(input.slug, { limit: input.limit ?? 20 }),
            }),
        });
    }

    if (!registry.hasTool('skill_rollback')) {
        registry.registerTool({
            name: 'skill_rollback',
            description: 'Restore the content of an older skill revision by creating a new, auditable version. Never deletes history. The restored version activates automatically unless the owner enabled approval.',
            toolset: 'skills',
            permission: 'write',
            timeoutMs: 5000,
            inputSchema: ROLLBACK_SCHEMA,
            execute: async ({ input, context }) => {
                const result = requireStore(context).rollbackSkill(input.slug, input.targetVersion, {
                    requireApproval: context.requireSkillApproval,
                    reason: input.reason,
                });
                return {
                    created: result.created,
                    duplicate: result.duplicate,
                    requiresApproval: result.requiresApproval,
                    revision: summarizeRevision(result.revision),
                    message: result.requiresApproval
                        ? 'Rollback staged for review; the active version has not changed.'
                        : 'Rollback content activated as a new version; earlier history was preserved.',
                    reason: input.reason ?? null,
                };
            },
        });
    }

    return registry;
}

export {
    SEARCH_SCHEMA,
    READ_SCHEMA,
    PROPOSE_SCHEMA,
    HISTORY_SCHEMA,
    ROLLBACK_SCHEMA,
};
