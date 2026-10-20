import { afterEach, describe, test, expect } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { MemoryStore } from '../src/agent/memory-store.js';

let stores = [];

async function createMemoryStore(databasePath = ':memory:') {
    const store = await MemoryStore.open(databasePath);
    stores.push(store);
    return store;
}

afterEach(() => {
    for (const store of stores) store.close();
    stores = [];
});

describe('MemoryStore', () => {
    test('keeps proposals out of retrieval until approved', async () => {
        const store = await createMemoryStore();
        const proposal = store.proposeMemory({
            scope: 'user',
            content: 'The user prefers concise technical explanations.',
            kind: 'preference',
            importance: 5,
        });

        expect(proposal.status).toBe('pending');
        expect(store.searchMemories({ query: 'concise technical', scope: 'user' })).toHaveLength(0);
        expect(store.getSummary()).toEqual({ events: 1, acceptedMemories: 0, pendingProposals: 1 });

        const reviewed = store.reviewProposal(proposal.id, 'approve');
        expect(reviewed.proposal.status).toBe('approved');
        expect(reviewed.memory.content).toBe('The user prefers concise technical explanations.');
        expect(store.searchMemories({ query: 'concise technical', scope: 'user' })).toHaveLength(1);
        expect(store.getSummary()).toEqual({ events: 1, acceptedMemories: 1, pendingProposals: 0 });
    });

    test('rejects proposals and never indexes rejected content', async () => {
        const store = await createMemoryStore();
        const proposal = store.proposeMemory({
            scope: 'user',
            content: 'This is only a speculative detail.',
        });

        const reviewed = store.reviewProposal(proposal.id, 'reject');
        expect(reviewed.proposal.status).toBe('rejected');
        expect(reviewed.memory).toBeNull();
        expect(store.searchMemories({ query: 'speculative detail', scope: 'user' })).toHaveLength(0);
    });

    test('limits character and chat search to the active scope', async () => {
        const store = await createMemoryStore();
        const character = store.proposeMemory({
            scope: 'character',
            scopeId: 'julia-card.png',
            content: 'Julia keeps a silver key in the desk.',
            kind: 'fact',
        });
        const chat = store.proposeMemory({
            scope: 'chat',
            scopeId: 'chapter-one.jsonl',
            content: 'The hidden attic contains a brass telescope.',
            kind: 'event',
        });
        store.reviewProposal(character.id, 'approve');
        store.reviewProposal(chat.id, 'approve');

        expect(store.searchMemories({
            query: 'silver key',
            scope: 'relevant',
            activeCharacterId: 'julia-card.png',
            activeChatId: 'chapter-two.jsonl',
        })).toHaveLength(1);
        expect(store.searchMemories({
            query: 'hidden attic',
            scope: 'relevant',
            activeCharacterId: 'julia-card.png',
            activeChatId: 'chapter-two.jsonl',
        })).toHaveLength(0);
        expect(store.searchMemories({
            query: 'hidden attic',
            scope: 'relevant',
            activeChatId: 'chapter-one.jsonl',
        })).toHaveLength(1);
    });

    test('deduplicates identical pending proposals', async () => {
        const store = await createMemoryStore();
        const first = store.proposeMemory({ scope: 'user', content: 'User likes green tea.' });
        const second = store.proposeMemory({ scope: 'user', content: 'User likes green tea.' });

        expect(second.id).toBe(first.id);
        expect(second.duplicate).toBe(true);
        expect(store.getSummary().pendingProposals).toBe(1);
        expect(store.getSummary().events).toBe(1);
    });

    test('persists accepted memories across reopen and records source events', async () => {
        const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'sillyagent-memory-'));
        const databasePath = path.join(folder, 'memory.sqlite');
        const firstStore = await createMemoryStore(databasePath);
        const proposal = firstStore.proposeMemory({
            scope: 'user',
            content: 'User is learning Japanese.',
            kind: 'goal',
        });
        const eventId = proposal.sourceEventId;
        firstStore.reviewProposal(proposal.id, 'approve');
        firstStore.close();
        stores = stores.filter(store => store !== firstStore);

        const reopened = await createMemoryStore(databasePath);
        const results = reopened.searchMemories({ query: 'learning Japanese', scope: 'user' });
        expect(results).toHaveLength(1);
        expect(results[0].sourceEventId).toBe(eventId);
        expect(reopened.getSummary()).toEqual({ events: 1, acceptedMemories: 1, pendingProposals: 0 });

        await fs.rm(folder, { recursive: true, force: true });
    });

    test('rejects invalid scopes and memory content', async () => {
        const store = await createMemoryStore();
        expect(() => store.proposeMemory({ scope: 'chat', content: 'A memory' })).toThrow(/scope ID/);
        expect(() => store.proposeMemory({ scope: 'user', content: '   ' })).toThrow(/characters/);
        expect(() => store.proposeMemory({ scope: 'user', content: 'A memory', importance: 6 })).toThrow(/importance/);
    });

    test('searches CJK memories by substring, including short queries', async () => {
        const store = await createMemoryStore();
        const proposal = store.proposeMemory({
            scope: 'user',
            content: '前に行った喫茶店は渋谷にある。',
            kind: 'event',
        });
        store.reviewProposal(proposal.id, 'approve');

        expect(store.searchMemories({ query: '喫茶店', scope: 'user' })).toHaveLength(1);
        expect(store.searchMemories({ query: '前に行った', scope: 'user' })).toHaveLength(1);
        expect(store.searchMemories({ query: '渋谷', scope: 'user' })).toHaveLength(1);
    });

    test('handles punctuation-only searches without malformed FTS queries', async () => {
        const store = await createMemoryStore();
        expect(store.searchMemories({ query: '!!! ???', scope: 'user' })).toEqual([]);
    });
    test('persists opt-in settings and deduplicates captured turns', async () => {
        const store = await createMemoryStore();
        expect(store.getSettings()).toEqual({
            autoRetrieveEnabled: true,
            autoCaptureEnabled: false,
            autoDreamEnabled: false,
        });
        store.updateSettings({ autoCaptureEnabled: true, autoDreamEnabled: true });
        expect(store.getSettings().autoCaptureEnabled).toBe(true);
        expect(store.getSettings().autoDreamEnabled).toBe(true);
        expect(() => store.updateSettings({ autoCaptureEnabled: 'yes' })).toThrow(/must be a boolean/);

        const first = store.captureTurn({
            scopeId: 'chat-1',
            role: 'user',
            content: 'We keep returning to the silver key mystery.',
            captureKey: 'message-1',
        });
        const second = store.captureTurn({
            scopeId: 'chat-1',
            role: 'user',
            content: 'We keep returning to the silver key mystery.',
            captureKey: 'message-1',
        });
        expect(first.duplicate).toBe(false);
        expect(second.duplicate).toBe(true);
        expect(store.countCapturedTurns('chat-1')).toBe(1);
        expect(store.listEvents({ scope: 'chat', scopeId: 'chat-1', eventTypes: ['chat.user_turn'] })).toHaveLength(1);
        expect(store.clearCapturedTurns('chat-1')).toBe(1);
        expect(store.countCapturedTurns('chat-1')).toBe(0);
        expect(store.listEvents({ scope: 'chat', scopeId: 'chat-1', eventTypes: ['chat.user_turn'] })).toHaveLength(0);

        const memoryProposal = store.proposeMemory({
            scope: 'chat',
            scopeId: 'chat-1',
            content: 'The silver key remains important to the story.',
            kind: 'world_state',
        });
        store.reviewProposal(memoryProposal.id, 'approve');
        store.captureTurn({
            scopeId: 'chat-1',
            role: 'assistant',
            content: 'This new captured turn should also be removed.',
            captureKey: 'message-2',
        });
        expect(store.clearCapturedTurns('chat-1')).toBe(1);
        expect(store.searchMemories({
            query: 'silver key',
            scope: 'chat',
            activeChatId: 'chat-1',
        }).some(memory => memory.content === 'The silver key remains important to the story.')).toBe(true);
    });

    test('lists and deletes accepted memories from both search indexes', async () => {
        const store = await createMemoryStore();
        const proposal = store.proposeMemory({ scope: 'user', content: 'The silver key is in a desk.' });
        const reviewed = store.reviewProposal(proposal.id, 'approve');
        expect(store.listMemories({ scope: 'user' })).toHaveLength(1);
        expect(store.deleteMemory(reviewed.memory.id)).toBe(true);
        expect(store.deleteMemory(reviewed.memory.id)).toBe(false);
        expect(store.listMemories({ scope: 'user' })).toHaveLength(0);
        expect(store.searchMemories({ query: 'silver key', scope: 'user' })).toHaveLength(0);
    });

    test('purges same-scope memory copies, proposals, and source events on deletion', async () => {
        const store = await createMemoryStore();
        const content = 'The user prefers jasmine tea.';

        const accepted = store.proposeMemory({
            scope: 'user',
            content,
            kind: 'preference',
        });
        store.reviewProposal(accepted.id, 'approve');

        const rejected = store.proposeMemory({
            scope: 'user',
            content,
            kind: 'preference',
        });
        store.reviewProposal(rejected.id, 'reject');

        const pending = store.proposeMemory({
            scope: 'user',
            content,
            kind: 'fact',
        });

        const otherScope = store.proposeMemory({
            scope: 'chat',
            scopeId: 'chat-keep',
            content,
            kind: 'fact',
        });
        store.reviewProposal(otherScope.id, 'approve');

        const acceptedMemory = store.listMemories({ scope: 'user' }).find(memory => memory.content === content);
        expect(acceptedMemory).toBeDefined();
        expect(store.deleteMemory(acceptedMemory.id)).toBe(true);

        expect(store.listMemories({ scope: 'user' }).some(memory => memory.content === content)).toBe(false);
        expect(store.searchMemories({ query: 'jasmine tea', scope: 'user' }).some(memory => memory.content === content)).toBe(false);
        for (const status of ['pending', 'approved', 'rejected']) {
            expect(store.listProposals({ status }).some(proposal =>
                proposal.scope === 'user' && proposal.content === content)).toBe(false);
        }
        expect(store.listEvents({
            scope: 'user',
            scopeId: '',
            eventTypes: ['memory.proposal_created'],
        }).some(event => event.content === content)).toBe(false);

        // The exact same text in another scope is an independent record.
        expect(store.searchMemories({
            query: 'jasmine tea',
            scope: 'chat',
            activeChatId: 'chat-keep',
        }).some(memory => memory.content === content)).toBe(true);
        expect(store.listEvents({
            scope: 'chat',
            scopeId: 'chat-keep',
            eventTypes: ['memory.proposal_created'],
        }).some(event => event.content === content)).toBe(true);

        const audit = store.listEvents({
            scope: 'user',
            scopeId: '',
            eventTypes: ['memory.deleted'],
        });
        expect(audit).toHaveLength(1);
        expect(audit[0].content).not.toContain(content);
        expect(audit[0].metadata.purgedProposals).toBe(3);
        expect(audit[0].metadata.purgedSourceEvents).toBe(3);
        expect(pending.status).toBe('pending');
    });

    test('hybrid ranking favors exact phrases and multi-term coverage', async () => {
        const store = await createMemoryStore();
        const partial = store.proposeMemory({
            scope: 'user',
            content: 'Silver details were written down, then the key was moved.',
            kind: 'fact',
            importance: 5,
        });
        const exact = store.proposeMemory({
            scope: 'user',
            content: 'The silver key is beneath the floorboards.',
            kind: 'fact',
            importance: 2,
        });
        store.reviewProposal(partial.id, 'approve');
        store.reviewProposal(exact.id, 'approve');

        const results = store.searchMemories({ query: 'silver key', scope: 'user', limit: 2 });
        expect(results).toHaveLength(2);
        expect(results[0].content).toBe('The silver key is beneath the floorboards.');
        expect(results[0].retrievalScore).toBeGreaterThan(results[1].retrievalScore);
        expect(results[0].matchedTerms).toEqual(['silver', 'key']);
    });

});
