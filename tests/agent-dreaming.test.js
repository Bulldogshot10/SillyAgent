import { afterEach, describe, test, expect } from '@jest/globals';
import { MemoryStore } from '../src/agent/memory-store.js';
import { DreamingEngine } from '../src/agent/dreaming.js';

let store;

async function createStore() {
    store = await MemoryStore.open(':memory:');
    return store;
}

afterEach(() => {
    if (store) store.close();
    store = null;
});

describe('DreamingEngine', () => {
    test('proposes recurring topics for review without auto-approving them', async () => {
        const memoryStore = await createStore();
        const turns = [
            ['user', 'We keep returning to the silver key mystery.'],
            ['assistant', 'The silver key mystery matters to this chapter.'],
            ['user', 'I still want to solve the silver key mystery.'],
        ];
        turns.forEach(([role, content], index) => memoryStore.captureTurn({
            scopeId: 'chat-1',
            role,
            content,
            captureKey: 'turn-' + index,
        }));

        const dream = new DreamingEngine(memoryStore).run({ scopeId: 'chat-1' });
        expect(dream.eventsReviewed).toBe(3);
        expect(dream.candidatesCreated).toBeGreaterThan(0);
        expect(dream.topics.some(topic => topic.includes('silver key'))).toBe(true);
        expect(memoryStore.listProposals({ status: 'pending' }).some(proposal => proposal.metadata.origin === 'dreaming')).toBe(true);
        expect(memoryStore.searchMemories({ query: 'silver key', scope: 'chat', activeChatId: 'chat-1' })).toHaveLength(0);

        const again = new DreamingEngine(memoryStore).run({ scopeId: 'chat-1' });
        expect(again.candidatesCreated).toBe(0);
    });

    test('does not dream across chat scopes', async () => {
        const memoryStore = await createStore();
        memoryStore.captureTurn({
            scopeId: 'chat-a',
            role: 'user',
            content: 'The silver key opens a hidden room.',
            captureKey: 'a-1',
        });
        memoryStore.captureTurn({
            scopeId: 'chat-b',
            role: 'user',
            content: 'The silver key opens a hidden room.',
            captureKey: 'b-1',
        });

        const dream = new DreamingEngine(memoryStore).run({ scopeId: 'chat-a' });
        expect(dream.eventsReviewed).toBe(1);
        expect(dream.candidatesCreated).toBe(0);
    });
});
