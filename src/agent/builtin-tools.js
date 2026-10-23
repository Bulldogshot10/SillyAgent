import { randomInt } from 'node:crypto';

import { toolRegistry } from './tool-registry.js';

const DICE_SCHEMA = {
    type: 'object',
    properties: {
        count: { type: 'integer', minimum: 1, maximum: 20 },
        sides: { type: 'integer', minimum: 2, maximum: 1000 },
    },
    required: ['count', 'sides'],
    additionalProperties: false,
};

const MEMORY_SEARCH_SCHEMA = {
    type: 'object',
    properties: {
        query: { type: 'string', minLength: 1, maxLength: 300 },
        scope: { type: 'string', enum: ['relevant', 'user', 'character', 'chat'] },
        limit: { type: 'integer', minimum: 1, maximum: 5 },
    },
    required: ['query'],
    additionalProperties: false,
};

const MEMORY_PROPOSE_SCHEMA = {
    type: 'object',
    properties: {
        content: { type: 'string', minLength: 1, maxLength: 4000 },
        scope: { type: 'string', enum: ['user', 'character', 'chat'] },
        kind: { type: 'string', enum: ['fact', 'preference', 'event', 'relationship', 'goal', 'world_state'] },
        importance: { type: 'integer', minimum: 1, maximum: 5 },
    },
    required: ['content'],
    additionalProperties: false,
};

/**
 * Infer a useful memory scope when the model omits it.
 * The prompt still asks the model to choose a scope deliberately; this is a
 * deterministic fallback so callers never need to choose one manually.
 * @param {object} input Candidate memory fields.
 * @param {object} context Active conversation identifiers.
 * @returns {'user'|'character'|'chat'} Scope.
 */
function inferMemoryScope({ kind = 'fact', content = '' }, context = {}) {
    const text = String(content).normalize('NFKC').toLocaleLowerCase();
    const activeChatId = context.activeChatId;
    const activeCharacterId = context.activeCharacterId;

    if (['preference', 'goal', 'relationship', 'world_state'].includes(kind)) {
        return activeCharacterId ? 'character' : 'chat';
    }

    const characterSpecific = /\b(character|persona|fictional|backstory|appearance|personality|outfit|roleplay)\b/u.test(text);
    if (characterSpecific && activeCharacterId) return 'character';

    const transient = /\b(this chat|this conversation|this session|current session|temporary|right now|currently debugging|current debugging|for this task)\b/u.test(text);
    if (transient && activeChatId) return 'chat';

    // Persistent memory is isolated by character. Never create a global user memory
    // that can leak into unrelated character conversations.
    return activeCharacterId ? 'character' : 'chat';
}

/**
 * Register first-party tools used by roleplay. Safe to call more than once.
 * @param {import('./tool-registry.js').ToolRegistry} registry Registry to extend.
 * @returns {import('./tool-registry.js').ToolRegistry} The registry.
 */
export function registerBuiltinTools(registry = toolRegistry) {
    if (!registry.hasTool('roleplay_roll_dice')) {
        registry.registerTool({
            name: 'roleplay_roll_dice',
            description: 'Roll one or more fair dice for a roleplay or tabletop scene. Returns each roll and the total.',
            toolset: 'roleplay',
            permission: 'read',
            timeoutMs: 1000,
            inputSchema: DICE_SCHEMA,
            execute: async ({ input }) => {
                const rolls = Array.from({ length: input.count }, () => randomInt(1, input.sides + 1));
                return {
                    notation: input.count + 'd' + input.sides,
                    rolls,
                    total: rolls.reduce((sum, value) => sum + value, 0),
                };
            },
        });
    }

    if (!registry.hasTool('memory_search')) {
        registry.registerTool({
            name: 'memory_search',
            description: 'Search memories for the active character and current chat only. Character memory never crosses into another character. Legacy user scope resolves to the active character partition.',
            toolset: 'memory',
            permission: 'read',
            timeoutMs: 2000,
            inputSchema: MEMORY_SEARCH_SCHEMA,
            execute: async ({ input, context }) => {
                const requestedScope = input.scope ?? 'relevant';
                // A model may still request the legacy "user" scope, but tool
                // searches must stay within the active character or current chat.
                const scope = requestedScope === 'user'
                    ? (context.activeCharacterId ? 'character' : 'chat')
                    : requestedScope;
                return {
                    query: input.query,
                    scope,
                    memories: context.memoryStore.searchMemories({
                        query: input.query,
                        scope,
                        activeChatId: context.activeChatId,
                        activeCharacterId: context.activeCharacterId,
                        limit: input.limit ?? 5,
                    }).map(({ scope, kind, content, importance }) => ({
                        scope,
                        kind,
                        importance,
                        content: Array.from(content).length > 800
                            ? Array.from(content).slice(0, 797).join('') + '...'
                            : content,
                    })),
                };
            },
        });
    }

    if (!registry.hasTool('memory_propose')) {
        registry.registerTool({
            name: 'memory_propose',
            description: 'Autonomously store a durable memory from a useful fact, preference, goal, relationship, or event. Call proactively when useful information emerges; never wait for the user to ask. All persistent memories are partitioned by the active character: durable user facts/preferences/goals and this character identity/backstory/relationship continuity belong to this character scope; transient task/session context belongs to the current chat. Never write to a global user pool or combine memory across characters. Scope is optional because the server infers it. Avoid duplicates, transient trivia, secrets, and credentials.',
            toolset: 'memory',
            permission: 'write',
            timeoutMs: 2000,
            inputSchema: MEMORY_PROPOSE_SCHEMA,
            execute: async ({ input, context }) => {
                const kind = input.kind ?? 'fact';
                const requestedScope = input.scope ?? inferMemoryScope({ kind, content: input.content }, context);
                // Compatibility with models that still request "user" scope:
                // preserve the fact only inside the active character's memory.
                const scope = requestedScope === 'user'
                    ? (context.activeCharacterId ? 'character' : 'chat')
                    : requestedScope === 'character' && !context.activeCharacterId
                        ? 'chat'
                        : requestedScope;
                let scopeId = '';
                if (scope === 'chat') scopeId = context.activeChatId;
                if (scope === 'character') scopeId = context.activeCharacterId;

                if (typeof scopeId !== 'string' || !scopeId) {
                    return {
                        created: false,
                        scope,
                        message: 'No active character or chat ID is available, so no memory was written.',
                    };
                }

                const proposal = context.memoryStore.proposeMemory({
                    scope,
                    scopeId,
                    kind,
                    content: input.content,
                    importance: input.importance ?? 3,
                    metadata: {
                        characterId: context.activeCharacterId ?? null,
                        origin: 'tool',
                    },
                    requireApproval: context.requireMemoryApproval,
                });
                return {
                    created: !proposal.duplicate && !proposal.deleted && !proposal.staleEvidence,
                    scope,
                    duplicate: !!proposal.duplicate,
                    requiresReview: proposal.requiresReview,
                    memory: proposal.memory ?? null,
                    proposal,
                };
            },
        });
    }

    return registry;
}

export { DICE_SCHEMA, MEMORY_SEARCH_SCHEMA, MEMORY_PROPOSE_SCHEMA };
