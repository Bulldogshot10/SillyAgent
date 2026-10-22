import { afterEach, describe, expect, test } from '@jest/globals';
import { promises as fsPromises } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { RoleplayStateStore } from '../src/agent/roleplay-state-store.js';
import { registerRoleplayTools } from '../src/agent/roleplay-tools.js';
import { ToolRegistry } from '../src/agent/tool-registry.js';

let stateStore;
let tempRoot;

afterEach(async () => {
    stateStore?.close();
    stateStore = null;
    if (tempRoot) await fsPromises.rm(tempRoot, { recursive: true, force: true });
    tempRoot = null;
});

describe('native roleplay harness tools', () => {
    test('registers the state, lore, dice, and scene contracts', () => {
        const registry = new ToolRegistry();
        registerRoleplayTools(registry);
        const names = registry.listTools().map(tool => tool.name);

        expect(names).toEqual(expect.arrayContaining([
            'world_get_state',
            'world_update_state',
            'character_get_state',
            'character_update_state',
            'scene_get_state',
            'lore_search',
            'dice_roll',
            'scene_advance',
        ]));
        expect(registry.listTools().find(tool => tool.name === 'world_update_state').permission).toBe('write');
        expect(registry.listTools().find(tool => tool.name === 'lore_search').permission).toBe('read');
    });

    test('routes versioned world updates and character state through explicit permissions', async () => {
        stateStore = await RoleplayStateStore.open(':memory:');
        const registry = new ToolRegistry();
        registerRoleplayTools(registry);
        const context = {
            roleplayStateStore: stateStore,
            activeChatId: 'chat-scope-a',
            activeCharacterId: 'julia-card.png',
        };

        const denied = await registry.executeTool('world_update_state', {
            patch: { location: 'Old observatory' },
            expectedVersion: 0,
        }, { context, allowedToolsets: ['world'] });
        expect(denied.error.code).toBe('permission_denied');

        const updated = await registry.executeTool('world_update_state', {
            patch: { location: 'Old observatory', weather: 'rain' },
            expectedVersion: 0,
        }, {
            context,
            allowedToolsets: ['world'],
            allowedWriteToolsets: ['world'],
            allowWrites: true,
        });
        expect(updated.ok).toBe(true);
        expect(updated.result.version).toBe(1);

        const read = await registry.executeTool('world_get_state', {}, { context, allowedToolsets: ['world'] });
        expect(read.result.state).toEqual({ location: 'Old observatory', weather: 'rain' });

        const character = await registry.executeTool('character_update_state', {
            patch: { condition: 'has a bruised wrist' },
            expectedVersion: 0,
        }, {
            context,
            allowedToolsets: ['character'],
            allowedWriteToolsets: ['character'],
            allowWrites: true,
        });
        expect(character.ok).toBe(true);
        expect(character.result.state.condition).toBe('has a bruised wrist');
        expect(stateStore.getState({ stateType: 'character', scopeId: 'other-character.png' }).state).toEqual({});
    });

    test('advances a scene through the tool and returns a durable scene version', async () => {
        stateStore = await RoleplayStateStore.open(':memory:');
        const registry = new ToolRegistry();
        registerRoleplayTools(registry);

        const result = await registry.executeTool('scene_advance', {
            summary: 'The investigation moves from the station to the riverside warehouse.',
            location: 'Riverside warehouse',
            time: 'after midnight',
            participants: ['Mira', 'Jun'],
            openThreads: ['Who owns the marked key?'],
            expectedVersion: 0,
        }, {
            context: { roleplayStateStore: stateStore, activeChatId: 'chat-scope-a' },
            allowedToolsets: ['scene'],
            allowedWriteToolsets: ['scene'],
            allowWrites: true,
        });

        expect(result.ok).toBe(true);
        expect(result.result.state.sceneNumber).toBe(1);
        expect(result.result.state.location).toBe('Riverside warehouse');
        expect(stateStore.getHistory({ stateType: 'scene', scopeId: 'chat-scope-a' })[0].source).toBe('scene.advance');
    });

    test('searches only active lorebooks and returns bounded matching entries', async () => {
        tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'sillyagent-lore-'));
        const registry = new ToolRegistry();
        registerRoleplayTools(registry);
        await fsPromises.writeFile(path.join(tempRoot, 'Active World.json'), JSON.stringify({
            entries: {
                1: {
                    uid: 1,
                    comment: 'The brass telescope',
                    key: ['brass', 'telescope'],
                    content: 'The telescope is hidden in the attic above the observatory.',
                },
            },
        }));
        await fsPromises.writeFile(path.join(tempRoot, 'Unrelated World.json'), JSON.stringify({
            entries: {
                2: {
                    uid: 2,
                    comment: 'Forbidden answer',
                    key: ['telescope'],
                    content: 'This text must not be searched because the book is not active.',
                },
            },
        }));

        const result = await registry.executeTool('lore_search', { query: 'brass telescope attic', limit: 5 }, {
            context: { worldsDirectory: tempRoot, activeWorldNames: ['Active World'] },
            allowedToolsets: ['lore'],
        });

        expect(result.ok).toBe(true);
        expect(result.result.searchedWorlds).toEqual(['Active World']);
        expect(result.result.entries).toHaveLength(1);
        expect(result.result.entries[0].content).toContain('hidden in the attic');
        expect(result.result.entries.some(entry => entry.title === 'Forbidden answer')).toBe(false);
    });

    test('dice tool rolls within its declared range', async () => {
        const registry = new ToolRegistry();
        registerRoleplayTools(registry);
        const result = await registry.executeTool('dice_roll', { count: 3, sides: 8 }, { allowedToolsets: ['roleplay'] });

        expect(result.ok).toBe(true);
        expect(result.result.rolls).toHaveLength(3);
        expect(result.result.rolls.every(value => value >= 1 && value <= 8)).toBe(true);
        expect((await registry.executeTool('dice_roll', { count: 0, sides: 8 })).error.code).toBe('invalid_input');
    });
});
