import { afterEach, beforeEach, describe, test, expect, jest } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { MemoryStore } from '../src/agent/memory-store.js';
import { SkillStore } from '../src/agent/skill-store.js';
import { runReflectionWorkerOnce } from '../src/agent/reflection-worker.js';
import { saveReflectionProviderConfig } from '../src/agent/reflection-provider.js';

let root;
let store;
let skills;
let originalFetch;

async function captureTurns() {
    const inputs = [
        ['user', 'I am learning Rust to build a file-management CLI.'],
        ['assistant', 'Start by checking the Rust toolchain and reproducing the compiler error.'],
        ['user', 'The compiler says the import is unresolved.'],
        ['assistant', 'That worked, the import error is gone after correcting the module path.'],
    ];
    const events = [];
    for (let index = 0; index < inputs.length; index++) {
        const [role, content] = inputs[index];
        const result = store.captureTurn({
            scopeId: 'character-chat-fixture',
            role,
            content,
            captureKey: 'worker-test-' + index,
            metadata: { characterId: 'julia.png', messageKey: String(index) + ':' + role },
        });
        events.push(result.event);
    }
    store.enqueueReflectionJob({
        scopeId: 'character-chat-fixture',
        chatId: 'chat-fixture.jsonl',
        characterId: 'julia.png',
        mode: 'extract',
        triggerEventId: events.at(-1).id,
        triggerCount: events.length,
    });
    return events;
}

beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'sillyagent-reflection-worker-'));
    store = await MemoryStore.open(':memory:');
    skills = await SkillStore.open(':memory:');
    originalFetch = globalThis.fetch;
    saveReflectionProviderConfig(root, {
        enabled: true,
        endpoint: 'https://reflection.example/v1/chat/completions',
        model: 'fixture-model',
        secretKey: 'none',
    });
});

afterEach(async () => {
    globalThis.fetch = originalFetch;
    store?.close();
    skills?.close();
    store = null;
    skills = null;
    if (root) await fs.rm(root, { recursive: true, force: true });
    root = null;
});

describe('server-owned reflection worker', () => {
    test('processes a persisted job, writes evidence-linked memory, and improves a reusable skill', async () => {
        const events = await captureTurns();
        const modelResult = {
            memories: [{
                content: 'The user is learning Rust to build a file-management CLI.',
                kind: 'goal',
                importance: 4,
                scope: 'character',
                evidenceIds: [events[0].id, events[2].id],
            }],
            skills: [{
                slug: 'rust-cli-import-recovery',
                name: 'Rust CLI import recovery',
                description: 'A repeatable process for debugging unresolved imports in a Rust CLI.',
                content: 'Check the toolchain version, reproduce the failure with the smallest command, read the exact compiler diagnostic, verify the module path and crate imports, apply the smallest correction, then rerun the command to confirm the error is gone before recording the procedure.',
                changeReason: 'The captured workflow shows a correction followed by a confirmed successful result.',
                evidenceIds: [events[1].id, events[3].id],
            }],
        };
        globalThis.fetch = jest.fn(async (_url, options) => {
            const request = JSON.parse(options.body);
            const transcript = JSON.parse(request.messages[1].content).transcript;
            expect(transcript).toHaveLength(4);
            expect(options.headers.Authorization).toBeUndefined();
            return {
                ok: true,
                status: 200,
                text: async () => JSON.stringify({
                    choices: [{ message: { content: JSON.stringify(modelResult) } }],
                }),
            };
        });

        const processed = await runReflectionWorkerOnce({
            store,
            directories: { root },
            getSkillStore: async () => skills,
        });

        expect(processed).toBe(true);
        expect(globalThis.fetch).toHaveBeenCalledTimes(1);
        expect(store.listReflectionJobs({ status: 'completed' })).toHaveLength(1);
        const memories = store.listMemories({ scope: 'character', scopeId: 'julia.png' });
        expect(memories.some(memory => memory.content === modelResult.memories[0].content)).toBe(true);
        expect(memories.find(memory => memory.content === modelResult.memories[0].content).metadata.evidenceEventIds).toEqual([events[0].id, events[2].id]);
        expect(skills.listSkills({ query: 'Rust CLI' })).toHaveLength(1);
        expect(skills.readSkill('rust-cli-import-recovery').source).toBe('self_improvement');
    });

    test('supersedes a stale memory only with current same-scope evidence', async () => {
        const oldProposal = store.proposeMemory({
            scope: 'character',
            scopeId: 'julia.png',
            kind: 'goal',
            content: 'The user is learning JavaScript for a file-management CLI.',
            importance: 3,
            metadata: { origin: 'test-fixture' },
            requireApproval: false,
        });
        const events = await captureTurns();
        globalThis.fetch = jest.fn(async (_url, options) => {
            const request = JSON.parse(options.body);
            const input = JSON.parse(request.messages[1].content);
            expect(input.existingMemories.some(memory => memory.id === oldProposal.memory.id)).toBe(true);
            return {
                ok: true,
                status: 200,
                text: async () => JSON.stringify({
                    choices: [{
                        message: {
                            content: JSON.stringify({
                                memories: [{
                                    content: 'The user is learning Rust to build a file-management CLI.',
                                    kind: 'goal',
                                    importance: 4,
                                    scope: 'character',
                                    evidenceIds: [events[0].id, events[2].id],
                                    supersedesMemoryIds: [oldProposal.memory.id],
                                    updateReason: 'The newer direct statement names Rust as the active language for this CLI.',
                                }],
                                skills: [],
                            }),
                        },
                    }],
                }),
            };
        });

        await runReflectionWorkerOnce({ store, directories: { root }, getSkillStore: async () => skills });

        const active = store.listMemories({ scope: 'character', scopeId: 'julia.png' });
        expect(active.map(memory => memory.content)).toEqual([
            'The user is learning Rust to build a file-management CLI.',
        ]);
        const supersession = store.listEvents({
            scope: 'character',
            scopeId: 'julia.png',
            eventTypes: ['memory.superseded'],
            limit: 10,
        });
        expect(supersession).toHaveLength(1);
        expect(supersession[0].metadata.previousMemoryId).toBe(oldProposal.memory.id);
        expect(supersession[0].metadata.evidenceEventIds).toEqual([events[0].id, events[2].id]);
    });

    test('dreaming never sends another character\'s turns to the reflection model', async () => {
        const a = store.captureTurn({
            scopeId: 'julia-chat',
            role: 'user',
            content: 'CHARACTER_A_PRIVATE memory: the silver key belongs to Julia.',
            captureKey: 'a-user',
            metadata: { characterId: 'julia.png', role: 'user' },
        }).event;
        store.captureTurn({
            scopeId: 'bella-chat',
            role: 'user',
            content: 'CHARACTER_B_PRIVATE memory: the silver key belongs to Bella.',
            captureKey: 'b-user',
            metadata: { characterId: 'bella.png', role: 'user' },
        });
        store.enqueueReflectionJob({
            scopeId: 'julia-chat',
            chatId: 'julia-chat.jsonl',
            characterId: 'julia.png',
            mode: 'dream',
            triggerEventId: a.id,
            triggerCount: 1,
        });
        globalThis.fetch = jest.fn(async (_url, options) => {
            const request = JSON.parse(options.body);
            const input = JSON.parse(request.messages[1].content);
            const transcript = JSON.stringify(input.transcript);
            expect(transcript).toContain('CHARACTER_A_PRIVATE');
            expect(transcript).not.toContain('CHARACTER_B_PRIVATE');
            return {
                ok: true,
                status: 200,
                text: async () => JSON.stringify({ choices: [{ message: { content: '{"memories":[],"skills":[]}' } }] }),
            };
        });

        await runReflectionWorkerOnce({ store, directories: { root }, getSkillStore: async () => skills });
        expect(store.listReflectionJobs({ status: 'completed' })).toHaveLength(1);
    });

    test('leaves a failed provider attempt pending for durable retry', async () => {
        await captureTurns();
        globalThis.fetch = jest.fn(async () => ({
            ok: false,
            status: 503,
            text: async () => 'private upstream detail',
        }));

        await runReflectionWorkerOnce({
            store,
            directories: { root },
            getSkillStore: async () => skills,
        });

        const pending = store.listReflectionJobs({ status: 'pending' });
        expect(pending).toHaveLength(1);
        expect(pending[0].attempts).toBe(1);
        expect(pending[0].lastError).toContain('HTTP 503');
        expect(pending[0].lastError).not.toContain('private upstream detail');
    });

describe('reflection provider configuration', () => {
    test('never persists an API secret and rejects embedded URL credentials', async () => {
        saveReflectionProviderConfig(root, {
            enabled: false,
            endpoint: 'http://127.0.0.1:11434/v1/chat/completions',
            model: 'local-fixture',
            secretKey: 'none',
            apiKey: 'must-never-be-saved',
        });
        const raw = await fs.readFile(path.join(root, 'sillyagent', 'reflection-provider.json'), 'utf8');
        expect(raw).not.toContain('must-never-be-saved');
        expect(() => saveReflectionProviderConfig(root, {
            enabled: true,
            endpoint: 'https://user:password@example.com/v1/chat/completions',
            model: 'remote-fixture',
            secretKey: 'api_key_openai',
        })).toThrow(/must use HTTP or HTTPS and must not include embedded credentials/u);
    });
});
});
