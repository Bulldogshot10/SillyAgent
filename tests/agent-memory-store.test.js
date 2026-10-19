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

    test('handles punctuation-only searches without malformed FTS queries', async () => {
        const store = await createMemoryStore();
        expect(store.searchMemories({ query: '!!! ???', scope: 'user' })).toEqual([]);
    });
});
