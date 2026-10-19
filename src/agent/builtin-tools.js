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
                    notation: `${input.count}d${input.sides}`,
                    rolls,
                    total: rolls.reduce((sum, value) => sum + value, 0),
                };
            },
        });
    }

    return registry;
}

export { DICE_SCHEMA };
