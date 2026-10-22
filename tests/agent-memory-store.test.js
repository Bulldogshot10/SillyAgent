import { afterEach, describe, test, expect } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { MemoryStore, supportsPersistentMemoryRuntime } from '../src/agent/memory-store.js';

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
    test('detects the persistent-memory Node.js runtime requirement', () => {
        expect(supportsPersistentMemoryRuntime('20.19.0')).toBe(false);
        expect(supportsPersistentMemoryRuntime('22.4.1')).toBe(false);
        expect(supportsPersistentMemoryRuntime('22.5.0')).toBe(true);
        expect(supportsPersistentMemoryRuntime('v22.5.0')).toBe(true);
        expect(supportsPersistentMemoryRuntime('24.0.0')).toBe(true);
        expect(supportsPersistentMemoryRuntime('not-a-version')).toBe(false);
        expect(supportsPersistentMemoryRuntime(null)).toBe(false);
    });

    test('secures persistent memory storage with private POSIX permissions', async () => {
        if (process.platform === 'win32') return;

        const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'sillyagent-memory-permissions-'));
        const databasePath = path.join(folder, 'memory.sqlite');
        let store;

        try {
            await fs.chmod(folder, 0o755);
            store = await createMemoryStore(databasePath);

            expect((await fs.stat(folder)).mode & 0o777).toBe(0o700);
            expect((await fs.stat(databasePath)).mode & 0o777).toBe(0o600);

            for (const sidecar of [databasePath + '-wal', databasePath + '-shm']) {
                try {
                    expect((await fs.stat(sidecar)).mode & 0o777).toBe(0o600);
                } catch (error) {
                    if (error?.code !== 'ENOENT') throw error;
                }
            }
        } finally {
            if (store) {
                store.close();
                stores = stores.filter(item => item !== store);
            }
            await fs.rm(folder, { recursive: true, force: true });
        }
    });

    test('rejects a symbolic link as the persistent memory database', async () => {
        if (process.platform === 'win32') return;

        const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'sillyagent-memory-symlink-'));
        const targetPath = path.join(folder, 'target.sqlite');
        const linkPath = path.join(folder, 'memory.sqlite');

        try {
            await fs.writeFile(targetPath, 'leave this target untouched');
            await fs.symlink(targetPath, linkPath);
            await expect(MemoryStore.open(linkPath)).rejects.toThrow(/symbolic link/);
            expect(await fs.readFile(targetPath, 'utf8')).toBe('leave this target untouched');
        } finally {
            await fs.rm(folder, { recursive: true, force: true });
        }
    });

    test('accepts durable memories immediately by default and makes them retrievable', async () => {
        const store = await createMemoryStore();
        expect(store.getSettings().requireApproval).toBe(false);

        const memory = store.proposeMemory({
            scope: 'user',
            content: 'The user prefers autonomous memory with optional review.',
            kind: 'preference',
            importance: 4,
        });

        expect(memory.status).toBe('approved');
        expect(memory.requiresReview).toBe(false);
        expect(memory.memory.content).toBe('The user prefers autonomous memory with optional review.');
        const duplicate = store.proposeMemory({
            scope: 'user',
            content: 'The user prefers autonomous memory with optional review.',
            kind: 'preference',
            importance: 4,
        });
        expect(duplicate.duplicate).toBe(true);
        expect(store.listProposals({ status: 'pending' })).toHaveLength(0);
        expect(store.searchMemories({ query: 'autonomous memory', scope: 'user' })).toHaveLength(1);
        expect(store.getSummary()).toEqual({ events: 1, acceptedMemories: 1, pendingProposals: 0 });
    });

    test('automatically migrates a legacy global memory to its originating character on reopen', async () => {
        const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'sillyagent-memory-migration-'));
        const databasePath = path.join(folder, 'memory.sqlite');
        let store;
        try {
            store = await createMemoryStore(databasePath);
            const sourceTime = 1700000000000;
            store.captureTurn({
                scopeId: 'legacy-chat.jsonl',
                role: 'user',
                content: 'I prefer practical explanations when working with this character.',
                captureKey: 'legacy-turn',
                metadata: { characterId: 'julia-card.png' },
                createdAt: sourceTime,
            });
            store.proposeMemory({
                scope: 'user',
                content: 'The user prefers practical explanations.',
                kind: 'preference',
                importance: 4,
                createdAt: sourceTime + 10000,
            });
            store.close();
            stores = stores.filter(item => item !== store);
            store = await createMemoryStore(databasePath);

            expect(store.listMemories({ scope: 'user' })).toHaveLength(0);
            expect(store.listMemories({ scope: 'character', scopeId: 'julia-card.png' })
                .some(memory => memory.content === 'The user prefers practical explanations.')).toBe(true);
            expect(store.searchMemories({
                query: 'practical explanations',
                scope: 'relevant',
                activeCharacterId: 'julia-card.png',
            }).some(memory => memory.content === 'The user prefers practical explanations.')).toBe(true);
        } finally {
            if (store) {
                store.close();
                stores = stores.filter(item => item !== store);
            }
            await fs.rm(folder, { recursive: true, force: true });
        }
    });

    test('keeps legacy global memory out of retrieval when character ownership is ambiguous', async () => {
        const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'sillyagent-memory-unresolved-'));
        const databasePath = path.join(folder, 'memory.sqlite');
        let store;
        try {
            store = await createMemoryStore(databasePath);
            store.captureTurn({
                scopeId: 'julia-chat.jsonl',
                role: 'user',
                content: 'This conversation belongs to Julia.',
                captureKey: 'julia-turn',
                metadata: { characterId: 'julia-card.png' },
                createdAt: 1700000000000,
            });
            store.captureTurn({
                scopeId: 'bella-chat.jsonl',
                role: 'user',
                content: 'This conversation belongs to Bella.',
                captureKey: 'bella-turn',
                metadata: { characterId: 'bella-card.png' },
                createdAt: 1700000010000,
            });
            store.proposeMemory({
                scope: 'user',
                content: 'An old memory with no reliable character owner.',
                kind: 'fact',
                createdAt: 1700000005000,
            });
            store.close();
            stores = stores.filter(item => item !== store);
            store = await createMemoryStore(databasePath);

            expect(store.listMemories({ scope: 'user' })
                .some(memory => memory.content === 'An old memory with no reliable character owner.')).toBe(true);
            expect(store.searchMemories({
                query: 'reliable character owner',
                scope: 'relevant',
                activeCharacterId: 'julia-card.png',
            })).toHaveLength(0);
            expect(store.searchMemories({
                query: 'reliable character owner',
                scope: 'relevant',
                activeCharacterId: 'bella-card.png',
            })).toHaveLength(0);
        } finally {
            if (store) {
                store.close();
                stores = stores.filter(item => item !== store);
            }
            await fs.rm(folder, { recursive: true, force: true });
        }
    });

    test('keeps proposals out of retrieval until approved', async () => {
        const store = await createMemoryStore();
        store.updateSettings({ requireApproval: true });
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

    test('auto-accepts older pending proposals when autonomous mode resumes', async () => {
        const store = await createMemoryStore();
        store.updateSettings({ requireApproval: true });
        const pending = store.proposeMemory({
            scope: 'user',
            content: 'A pending idea should become retrievable when review is disabled.',
            kind: 'fact',
        });
        expect(pending.status).toBe('pending');

        store.updateSettings({ requireApproval: false });
        expect(store.autoApprovePendingProposals()).toBe(1);
        expect(store.listProposals({ status: 'pending' })).toHaveLength(0);
        expect(store.searchMemories({ query: 'pending idea retrievable', scope: 'user' })).toHaveLength(1);
    });

    test('rejects proposals and never indexes rejected content', async () => {
        const store = await createMemoryStore();
        store.updateSettings({ requireApproval: true });
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
        store.updateSettings({ requireApproval: true });
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

    test('relevant retrieval never exposes legacy global memory to a character', async () => {
        const store = await createMemoryStore();
        store.updateSettings({ requireApproval: true });
        const legacy = store.proposeMemory({
            scope: 'user',
            content: 'Global legacy phrase from an unrelated character.',
        });
        const local = store.proposeMemory({
            scope: 'character',
            scopeId: 'julia-card.png',
            content: 'Julia character-only memory phrase.',
        });
        store.reviewProposal(legacy.id, 'approve');
        store.reviewProposal(local.id, 'approve');

        const retrieved = store.searchMemories({
            query: 'Global legacy phrase',
            scope: 'relevant',
            activeCharacterId: 'julia-card.png',
            activeChatId: 'julia-chat',
        });
        expect(retrieved.some(memory => memory.content.includes('Global legacy phrase'))).toBe(false);
        expect(store.searchMemories({
            query: 'Julia character-only',
            scope: 'relevant',
            activeCharacterId: 'julia-card.png',
            activeChatId: 'julia-chat',
        }).some(memory => memory.content.includes('Julia character-only'))).toBe(true);
    });

    test('deduplicates identical pending proposals', async () => {
        const store = await createMemoryStore();
        store.updateSettings({ requireApproval: true });
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
        firstStore.updateSettings({ requireApproval: true });
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
        expect(() => store.proposeMemory({
            scope: 'user',
            content: 'Use this API key sk-12345678901234567890 for the integration.',
        })).toThrow(/credential-like secrets/);
        expect(() => store.proposeMemory({
            scope: 'user',
            content: 'A safe description of an API integration.',
            metadata: { updateReason: 'Leaked key: sk-12345678901234567890' },
        })).toThrow(/credential-like secrets/);
    });

    test('searches CJK memories by substring, including short queries', async () => {
        const store = await createMemoryStore();
        store.updateSettings({ requireApproval: true });
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
            autoCaptureEnabled: true,
            autoDreamEnabled: true,
            requireApproval: false,
        });
        store.updateSettings({ autoCaptureEnabled: true, autoDreamEnabled: true, requireApproval: true });
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
        store.updateSettings({ requireApproval: true });
        const proposal = store.proposeMemory({ scope: 'user', content: 'The silver key is in a desk.' });
        const reviewed = store.reviewProposal(proposal.id, 'approve');
        expect(store.listMemories({ scope: 'user' })).toHaveLength(1);
        expect(store.deleteMemory(reviewed.memory.id)).toBe(true);
        expect(store.deleteMemory(reviewed.memory.id)).toBe(false);
        expect(store.listMemories({ scope: 'user' })).toHaveLength(0);
        expect(store.searchMemories({ query: 'silver key', scope: 'user' })).toHaveLength(0);
    });

    test('prevents background reflection from recreating explicitly deleted memory content', async () => {
        const store = await createMemoryStore();
        const accepted = store.proposeMemory({
            scope: 'chat',
            scopeId: 'forget-chat',
            content: 'The user prefers jasmine tea.',
            kind: 'preference',
            requireApproval: false,
        });
        expect(accepted.memory).not.toBeNull();
        expect(store.deleteMemory(accepted.memory.id)).toBe(true);

        const reflected = store.proposeMemory({
            scope: 'chat',
            scopeId: 'forget-chat',
            content: 'The user prefers jasmine tea.',
            kind: 'preference',
            metadata: { origin: 'background_reflection' },
            requireApproval: false,
        });

        expect(reflected.forgotten).toBe(true);
        expect(reflected.memory).toBeNull();
        expect(store.listMemories({ scope: 'chat', scopeId: 'forget-chat' })).toHaveLength(0);
    });

    test('prevents deleted memory from being reconstructed from its original evidence', async () => {
        const store = await createMemoryStore();
        const captured = store.captureTurn({
            scopeId: 'forget-evidence-chat',
            role: 'user',
            content: 'I prefer jasmine tea.',
            captureKey: 'forget-evidence-turn',
        });
        const accepted = store.proposeMemory({
            scope: 'chat',
            scopeId: 'forget-evidence-chat',
            content: 'The user prefers jasmine tea.',
            kind: 'preference',
            metadata: {
                origin: 'background_reflection',
                evidenceEventIds: [captured.event.id],
            },
            requireApproval: false,
            requireCurrentEvidenceIds: [captured.event.id],
        });
        expect(accepted.memory).not.toBeNull();
        expect(store.deleteMemory(accepted.memory.id)).toBe(true);

        const paraphrase = store.proposeMemory({
            scope: 'chat',
            scopeId: 'forget-evidence-chat',
            content: 'Jasmine tea is the user’s preferred tea.',
            kind: 'preference',
            metadata: {
                origin: 'background_reflection',
                evidenceEventIds: [captured.event.id],
            },
            requireApproval: false,
            requireCurrentEvidenceIds: [captured.event.id],
        });

        expect(paraphrase.forgottenEvidence).toBe(true);
        expect(paraphrase.memory).toBeNull();
        expect(store.listMemories({ scope: 'chat', scopeId: 'forget-evidence-chat' })).toHaveLength(0);
    });

    test('rejects a proposal whose captured-turn evidence was cleared before persistence', async () => {
        const store = await createMemoryStore();
        const captured = store.captureTurn({
            scopeId: 'cleared-chat',
            role: 'user',
            content: 'I prefer jasmine tea.',
            captureKey: 'cleared-chat-turn',
            metadata: { characterId: 'julia.png' },
        });
        expect(store.clearCapturedTurns('cleared-chat')).toBe(1);

        const stale = store.proposeMemory({
            scope: 'chat',
            scopeId: 'cleared-chat',
            content: 'The user prefers jasmine tea.',
            kind: 'preference',
            metadata: { origin: 'background_reflection' },
            requireApproval: false,
            requireCurrentEvidenceIds: [captured.event.id],
        });

        expect(stale.staleEvidence).toBe(true);
        expect(stale.memory).toBeNull();
        expect(store.listMemories({ scope: 'chat', scopeId: 'cleared-chat' })).toHaveLength(0);
        expect(store.listProposals({ status: 'approved' })).toHaveLength(0);
    });

    test('purges same-scope memory copies, proposals, and source events on deletion', async () => {
        const store = await createMemoryStore();
        store.updateSettings({ requireApproval: true });
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
            kind: 'relationship',
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
        store.updateSettings({ requireApproval: true });
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

    test('filters the cross-chat dreaming window by character before applying its limit', async () => {
        const store = await createMemoryStore();
        const julia = store.captureTurn({
            scopeId: 'julia-chat',
            role: 'user',
            content: 'Older Julia turn should remain available to Julia dreaming.',
            captureKey: 'julia-old-turn',
            metadata: { characterId: 'julia.png' },
            createdAt: 1000,
        }).event;
        store.captureTurn({
            scopeId: 'bella-chat',
            role: 'user',
            content: 'Newer Bella turn must not occupy Julia dreaming capacity.',
            captureKey: 'bella-new-turn',
            metadata: { characterId: 'bella.png' },
            createdAt: 2000,
        });
        const current = store.captureTurn({
            scopeId: 'julia-current-chat',
            role: 'assistant',
            content: 'Current Julia turn stays in the active-chat slice.',
            captureKey: 'julia-current-turn',
            metadata: { characterId: 'julia.png' },
            createdAt: 3000,
        }).event;

        const rows = store.listCapturedTurnsAcrossChats({
            limit: 10,
            characterId: 'julia.png',
            excludeScopeId: 'julia-current-chat',
        });
        expect(rows).toHaveLength(1);
        expect(rows[0].id).toBe(julia.id);
        expect(rows[0].id).not.toBe(current.id);
        expect(rows[0].metadata.characterId).toBe('julia.png');
    });

    test('persists and claims autonomous reflection jobs only within the active character', async () => {
        const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'sillyagent-reflection-jobs-'));
        const databasePath = path.join(folder, 'memory.sqlite');
        let firstStore;
        let reopened;
        try {
            firstStore = await createMemoryStore(databasePath);
            const enqueued = firstStore.enqueueReflectionJob({
                scopeId: 'character-chat-a',
                chatId: 'chat-a',
                characterId: 'char-a.png',
                mode: 'extract',
                triggerEventId: 'event-a',
                triggerCount: 4,
                createdAt: 1000,
            });
            expect(enqueued.created).toBe(true);
            expect(enqueued.job.status).toBe('pending');
            expect(firstStore.enqueueReflectionJob({
                scopeId: 'character-chat-a',
                chatId: 'chat-a',
                characterId: 'char-a.png',
                mode: 'extract',
                triggerEventId: 'event-a',
                triggerCount: 4,
                createdAt: 1000,
            }).created).toBe(false);

            const coalesced = firstStore.enqueueReflectionJob({
                scopeId: 'character-chat-a',
                chatId: 'chat-a',
                characterId: 'char-a.png',
                mode: 'extract',
                triggerEventId: 'event-b',
                triggerCount: 5,
                createdAt: 2000,
            });
            expect(coalesced.created).toBe(false);
            expect(coalesced.coalesced).toBe(true);
            expect(coalesced.job.id).toBe(enqueued.job.id);
            expect(coalesced.job.triggerEventId).toBe('event-b');
            expect(firstStore.listReflectionJobs({ status: 'pending' })).toHaveLength(1);

            firstStore.close();
            stores = stores.filter(store => store !== firstStore);
            reopened = await createMemoryStore(databasePath);
            expect(reopened.listReflectionJobs({ status: 'pending' })).toHaveLength(1);
            expect(reopened.getReflectionJobSummary()).toEqual({
                pending: 1,
                running: 0,
                completed: 0,
                failed: 0,
            });
            expect(reopened.claimReflectionJob({
                scopeId: 'character-chat-b',
                characterId: 'char-b.png',
                claimToken: 'claim-b',
                now: 2000,
            })).toBeNull();

            const claimed = reopened.claimReflectionJob({
                scopeId: 'character-chat-b',
                characterId: 'char-a.png',
                claimToken: 'claim-a',
                now: 2000,
            });
            expect(claimed.id).toBe(enqueued.job.id);
            expect(claimed.chatId).toBe('chat-a');
            expect(claimed.attempts).toBe(1);
            expect(reopened.completeReflectionJob(claimed.id, 'wrong-token', 3000)).toBe(false);
            expect(reopened.completeReflectionJob(claimed.id, 'claim-a', 3000)).toBe(true);
            expect(reopened.listReflectionJobs({ status: 'completed' })).toHaveLength(1);
        } finally {
            if (firstStore && stores.includes(firstStore)) firstStore.close();
            if (reopened) reopened.close();
            stores = stores.filter(store => store !== firstStore && store !== reopened);
            await fs.rm(folder, { recursive: true, force: true });
        }
    });

    test('retries failed autonomous reflection jobs and marks exhausted jobs failed', async () => {
        const store = await createMemoryStore();
        store.enqueueReflectionJob({
            scopeId: 'character-chat-a',
            chatId: 'chat-a',
            characterId: 'char-a.png',
            mode: 'dream',
            triggerEventId: 'dream-event',
            triggerCount: 12,
            createdAt: 1000,
        });

        const first = store.claimReflectionJob({
            scopeId: 'character-chat-a',
            characterId: 'char-a.png',
            claimToken: 'claim-1',
            now: 1000,
        });
        expect(store.failReflectionJob(first.id, 'claim-1', 'temporary provider failure', 1001)).toBe(true);
        expect(store.listReflectionJobs({ status: 'pending' })[0].attempts).toBe(1);

        const second = store.claimReflectionJob({
            scopeId: 'character-chat-a',
            characterId: 'char-a.png',
            claimToken: 'claim-2',
            now: 20000,
        });
        expect(second.attempts).toBe(2);
        expect(store.failReflectionJob(second.id, 'claim-2', 'temporary provider failure', 20001)).toBe(true);

        const third = store.claimReflectionJob({
            scopeId: 'character-chat-a',
            characterId: 'char-a.png',
            claimToken: 'claim-3',
            now: 50001,
        });
        expect(third.attempts).toBe(3);
        expect(store.failReflectionJob(third.id, 'claim-3', 'persistent provider failure', 50002)).toBe(true);
        expect(store.listReflectionJobs({ status: 'failed' })).toHaveLength(1);
    });

});
