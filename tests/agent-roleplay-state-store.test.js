import { afterEach, describe, expect, test } from '@jest/globals';
import { RoleplayStateStore } from '../src/agent/roleplay-state-store.js';

let store;

afterEach(() => {
    store?.close();
    store = null;
});

describe('RoleplayStateStore', () => {
    test('persists patches with versions and keeps partitions isolated', async () => {
        store = await RoleplayStateStore.open(':memory:');

        const first = store.updateState({
            stateType: 'world',
            scopeId: 'chat-one',
            expectedVersion: 0,
            patch: {
                location: 'Old observatory',
                weather: 'rain',
                clues: ['brass key'],
                facts: { door: 'locked', lights: 'dim' },
            },
        });
        expect(first.version).toBe(1);
        expect(first.state.location).toBe('Old observatory');

        const second = store.updateState({
            stateType: 'world',
            scopeId: 'chat-one',
            expectedVersion: first.version,
            patch: {
                weather: 'clear',
                facts: { door: null, clock: 'stopped' },
            },
        });
        expect(second.version).toBe(2);
        expect(second.state.weather).toBe('clear');
        expect(second.state.facts).toEqual({ lights: 'dim', clock: 'stopped' });
        expect(store.getState({ stateType: 'world', scopeId: 'chat-two' }).state).toEqual({});
        expect(store.getState({ stateType: 'world', scopeId: 'chat-one', keys: ['location'] }).state)
            .toEqual({ location: 'Old observatory' });
    });

    test('rejects stale updates and records a versioned history', async () => {
        store = await RoleplayStateStore.open(':memory:');
        store.updateState({
            stateType: 'character',
            scopeId: 'character-a.png',
            expectedVersion: 0,
            patch: { condition: 'uninjured' },
        });
        store.updateState({
            stateType: 'character',
            scopeId: 'character-a.png',
            expectedVersion: 1,
            patch: { condition: 'injured' },
        });

        let conflict = null;
        try {
            store.updateState({
                stateType: 'character',
                scopeId: 'character-a.png',
                expectedVersion: 1,
                patch: { condition: 'uninjured' },
            });
        } catch (error) {
            conflict = error;
        }
        expect(conflict).toBeInstanceOf(Error);
        expect(conflict.code).toBe('state_conflict');
        expect(conflict.currentVersion).toBe(2);

        const history = store.getHistory({ stateType: 'character', scopeId: 'character-a.png' });
        expect(history.map(item => item.version)).toEqual([2, 1]);
        expect(history[0].patch).toEqual({ condition: 'injured' });
    });

    test('advances scenes and resolves existing threads without losing location', async () => {
        store = await RoleplayStateStore.open(':memory:');
        const first = store.advanceScene({
            scopeId: 'chat-one',
            summary: 'They enter the greenhouse and find the broken lantern.',
            location: 'North greenhouse',
            time: 'midnight',
            participants: ['Mira', 'Jun'],
            openThreads: ['Who broke the lantern?', 'Where is the gardener?'],
        });
        expect(first.state.sceneNumber).toBe(1);
        expect(first.state.openThreads).toHaveLength(2);

        const second = store.advanceScene({
            scopeId: 'chat-one',
            summary: 'The gardener admits the lantern broke during the storm.',
            resolvedThreads: ['Who broke the lantern?'],
            expectedVersion: first.version,
        });
        expect(second.state.sceneNumber).toBe(2);
        expect(second.state.location).toBe('North greenhouse');
        expect(second.state.openThreads).toEqual(['Where is the gardener?']);
        expect(second.state.lastResolvedThreads).toEqual(['Who broke the lantern?']);

        const third = store.advanceScene({
            scopeId: 'chat-one',
            summary: 'They leave the greenhouse and follow the muddy footprints.',
            expectedVersion: second.version,
        });
        expect(third.state.sceneNumber).toBe(3);
        expect(third.state.lastResolvedThreads).toEqual([]);
    });

    test('removes chat-owned scene and fallback world state without deleting shared or character state', async () => {
        store = await RoleplayStateStore.open(':memory:');
        store.updateState({
            stateType: 'scene',
            scopeId: 'chat-to-delete',
            expectedVersion: 0,
            patch: { sceneNumber: 4, summary: 'Private scene recap.' },
        });
        store.updateState({
            stateType: 'world',
            scopeId: 'chat-to-delete',
            expectedVersion: 0,
            patch: { location: 'Chat-local fallback world' },
        });
        store.updateState({
            stateType: 'world',
            scopeId: 'world-shared',
            expectedVersion: 0,
            patch: { location: 'Shared setting' },
        });
        store.updateState({
            stateType: 'character',
            scopeId: 'julia.png',
            expectedVersion: 0,
            patch: { condition: 'rested' },
        });

        expect(store.deleteChatPartition('chat-to-delete')).toEqual({
            deletedStates: 2,
            deletedEvents: 2,
        });
        expect(store.getState({ stateType: 'scene', scopeId: 'chat-to-delete' }).state).toEqual({});
        expect(store.getState({ stateType: 'world', scopeId: 'chat-to-delete' }).state).toEqual({});
        expect(store.getState({ stateType: 'world', scopeId: 'world-shared' }).state)
            .toEqual({ location: 'Shared setting' });
        expect(store.getState({ stateType: 'character', scopeId: 'julia.png' }).state)
            .toEqual({ condition: 'rested' });
        expect(store.getHistory({ stateType: 'scene', scopeId: 'chat-to-delete' })).toHaveLength(0);
    });

    test('requires an expected version at the persistent state write boundary', async () => {
        store = await RoleplayStateStore.open(':memory:');

        expect(() => store.updateState({
            stateType: 'world',
            scopeId: 'chat-one',
            patch: { location: 'New observatory' },
        })).toThrow(/expectedVersion is required/u);
    });

    test('rejects unsafe keys, credential-like strings, oversized patches, and invalid scopes', async () => {
        store = await RoleplayStateStore.open(':memory:');

        expect(() => store.updateState({
            stateType: 'world',
            scopeId: 'chat-one',
            patch: { constructor: 'polluted' },
        })).toThrow(/State keys/);
        expect(() => store.updateState({
            stateType: 'world',
            scopeId: 'chat-one',
            patch: { secret: 'sk-12345678901234567890' },
        })).toThrow(/credential-like/);
        expect(() => store.updateState({
            stateType: 'unknown',
            scopeId: 'chat-one',
            patch: { ok: true },
        })).toThrow(/State type/);
        expect(() => store.updateState({
            stateType: 'world',
            scopeId: 'chat-one',
            patch: Object.fromEntries(Array.from({ length: 33 }, (_, index) => ['k' + index, true])),
        })).toThrow(/32 top-level keys/);
    });
});
