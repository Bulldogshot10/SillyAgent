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

    if (['preference', 'goal'].includes(kind)) return 'user';
    if (kind === 'relationship') return activeCharacterId ? 'character' : 'user';
    if (kind === 'world_state') return activeCharacterId ? 'character' : (activeChatId ? 'chat' : 'user');

    const characterSpecific = /\b(character|persona|fictional|backstory|appearance|personality|outfit|roleplay)\b/u.test(text);
    if (characterSpecific && activeCharacterId) return 'character';

    const transient = /\b(this chat|this conversation|this session|current session|temporary|right now|currently debugging|current debugging|for this task)\b/u.test(text);
    if (transient && activeChatId) return 'chat';

    // Facts and durable events default to user scope unless explicitly tied to a character
    // or a transient session. The model can always specify another scope when appropriate.
    return 'user';
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
            description: 'Search persistent memories relevant to the current roleplay, character, chat, or user.',
            toolset: 'memory',
            permission: 'read',
            timeoutMs: 2000,
            inputSchema: MEMORY_SEARCH_SCHEMA,
            execute: async ({ input, context }) => ({
                query: input.query,
                scope: input.scope ?? 'relevant',
                memories: context.memoryStore.searchMemories({
                    query: input.query,
                    scope: input.scope ?? 'relevant',
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
            }),
        });
    }

    if (!registry.hasTool('memory_propose')) {
        registry.registerTool({
            name: 'memory_propose',
            description: 'Autonomously store a durable memory from a useful fact, preference, goal, relationship, or event. Call this proactively when the user reveals something worth remembering; do not wait for the user to ask. Choose scope automatically: user for durable user facts/preferences/goals, character for this character’s identity/backstory or character-specific relationship continuity, chat for temporary task/session context. Avoid duplicates, transient trivia, secrets, and credentials. Memories are saved and made retrievable immediately by default.',
            toolset: 'memory',
            permission: 'write',
            timeoutMs: 2000,
            inputSchema: MEMORY_PROPOSE_SCHEMA,
            execute: async ({ input, context }) => {
                const kind = input.kind ?? 'fact';
                const scope = input.scope ?? inferMemoryScope({ kind, content: input.content }, context);
                let scopeId = '';
                if (scope === 'chat') scopeId = context.activeChatId;
                if (scope === 'character') scopeId = context.activeCharacterId;

                if (scope !== 'user' && (typeof scopeId !== 'string' || !scopeId)) {
                    return {
                        created: false,
                        scope,
                        message: 'Automatic scope resolution selected a contextual scope, but no active context ID is available. Retry with user scope or wait for a chat/character context.',
                    };
                }

                const proposal = context.memoryStore.proposeMemory({
                    scope,
                    scopeId,
                    kind,
                    content: input.content,
                    importance: input.importance ?? 3,
                    requireApproval: context.requireMemoryApproval,
                });
                return {
                    created: !proposal.duplicate,
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
