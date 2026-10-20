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
    test('autonomously stores recurring topics as retrievable memories by default', async () => {
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
        expect(dream.memoriesAccepted).toBeGreaterThan(0);
        expect(dream.proposalsPending).toBe(0);
        expect(memoryStore.listProposals({ status: 'approved' }).some(proposal => proposal.metadata.origin === 'dreaming')).toBe(true);
        expect(memoryStore.searchMemories({ query: 'silver key', scope: 'chat', activeChatId: 'chat-1' }).length).toBeGreaterThan(0);

        const again = new DreamingEngine(memoryStore).run({ scopeId: 'chat-1' });
        expect(again.candidatesCreated).toBe(0);
    });

    test('keeps dreaming proposals pending when human review is enabled', async () => {
        const memoryStore = await createStore();
        memoryStore.updateSettings({ requireApproval: true });
        const turns = [
            ['user', 'We keep returning to the copper moon observatory.'],
            ['assistant', 'The copper moon observatory is central to the mystery.'],
            ['user', 'I want to revisit the copper moon observatory later.'],
        ];
        turns.forEach(([role, content], index) => memoryStore.captureTurn({
            scopeId: 'review-chat',
            role,
            content,
            captureKey: 'review-turn-' + index,
        }));

        const dream = new DreamingEngine(memoryStore).run({ scopeId: 'review-chat' });
        expect(dream.candidatesCreated).toBeGreaterThan(0);
        expect(dream.memoriesAccepted).toBe(0);
        expect(dream.proposalsPending).toBeGreaterThan(0);
        expect(memoryStore.listProposals({ status: 'pending' }).some(proposal => proposal.metadata.origin === 'dreaming')).toBe(true);
        expect(memoryStore.searchMemories({ query: 'copper moon', scope: 'chat', activeChatId: 'review-chat' })).toHaveLength(0);
    });


    test('automatically uses character scope for a repeated topic across that character chats', async () => {
        const memoryStore = await createStore();
        const turns = [
            { chatId: 'julia-chat-1', role: 'user', content: 'We keep returning to the silver key mystery.' },
            { chatId: 'julia-chat-2', role: 'assistant', content: 'The silver key mystery matters to this story.' },
            { chatId: 'julia-chat-2', role: 'user', content: 'I want to solve the silver key mystery next.' },
        ];
        turns.forEach((turn, index) => memoryStore.captureTurn({
            scopeId: turn.chatId,
            role: turn.role,
            content: turn.content,
            captureKey: 'character-cross-chat-' + index,
            metadata: { characterId: 'julia.png' },
        }));

        const dream = new DreamingEngine(memoryStore).run({ scopeId: 'julia-chat-2' });
        const memories = memoryStore.listMemories({ scope: 'all' });
        expect(dream.globalEventsReviewed).toBe(3);
        expect(memories.some(memory => memory.scope === 'character'
            && memory.scopeId === 'julia.png'
            && memory.content.includes('silver key'))).toBe(true);
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
