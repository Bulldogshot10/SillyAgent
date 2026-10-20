import { afterAll, beforeAll, describe, test, expect } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

import { router } from '../src/endpoints/agent-tools.js';

let server;
let baseUrl;
let userRoot;
const memoryProposalsEnvKey = 'SILLYTAVERN_AGENTTOOLS_MEMORYPROPOSALSENABLED';
let previousMemoryProposalsEnv;

async function postJson(url, body) {
    return fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
}

beforeAll(async () => {
    previousMemoryProposalsEnv = process.env[memoryProposalsEnvKey];
    process.env[memoryProposalsEnvKey] = 'true';
    userRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sillyagent-endpoint-'));
    const app = express();
    app.use(express.json());
    app.use((request, _response, next) => {
        request.user = { directories: { root: userRoot } };
        next();
    });
    app.use('/api/agent/tools', router);
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve, reject) => {
        server.once('listening', resolve);
        server.once('error', reject);
    });
    baseUrl = 'http://127.0.0.1:' + server.address().port + '/api/agent/tools';
});

afterAll(async () => {
    if (server) {
        await new Promise((resolve, reject) => {
            server.close(error => error ? reject(error) : resolve());
        });
    }
    if (userRoot) await fs.rm(userRoot, { recursive: true, force: true });
    if (previousMemoryProposalsEnv === undefined) {
        delete process.env[memoryProposalsEnvKey];
    } else {
        process.env[memoryProposalsEnvKey] = previousMemoryProposalsEnv;
    }
});

describe('agent tools API', () => {
    test('publishes roleplay and memory tool definitions', async () => {
        const response = await fetch(baseUrl);
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.tools.some(tool => tool.function.name === 'roleplay_roll_dice')).toBe(true);
        expect(body.tools.some(tool => tool.function.name === 'memory_search')).toBe(true);
        expect(body.tools.some(tool => tool.function.name === 'memory_propose')).toBe(true);
        expect(body.tools.some(tool => tool.function.name === 'skill_search')).toBe(true);
        expect(body.tools.some(tool => tool.function.name === 'skill_propose')).toBe(true);
    });

    test('defaults memory capture and dreaming to autonomous mode', async () => {
        const settingsResponse = await fetch(baseUrl + '/memory/settings');
        const settings = await settingsResponse.json();
        expect(settings.settings.autoRetrieveEnabled).toBe(true);
        expect(settings.settings.autoCaptureEnabled).toBe(true);
        expect(settings.settings.autoDreamEnabled).toBe(true);
        expect(settings.settings.requireApproval).toBe(false);

        const proposalResponse = await postJson(baseUrl + '/execute', {
            activeCharacterId: 'julia-card.png',
            name: 'memory_propose',
            arguments: {
                content: 'The user prefers autonomous persistent memory.',
                scope: 'user',
                kind: 'preference',
                importance: 4,
            },
        });
        const proposed = await proposalResponse.json();
        expect(proposalResponse.status).toBe(200);
        expect(proposed.ok).toBe(true);
        expect(proposed.result.requiresReview).toBe(false);
        expect(proposed.result.proposal.status).toBe('approved');
        expect(proposed.result.scope).toBe('character');
        expect(proposed.result.memory.scope).toBe('character');
        expect(proposed.result.memory.scopeId).toBe('julia-card.png');
        expect(proposed.result.memory.content).toBe('The user prefers autonomous persistent memory.');

        const pendingResponse = await fetch(baseUrl + '/memory/proposals');
        expect((await pendingResponse.json()).proposals).toHaveLength(0);

        const searchResponse = await postJson(baseUrl + '/execute', {
            activeCharacterId: 'julia-card.png',
            name: 'memory_search',
            arguments: { query: 'autonomous persistent memory', scope: 'user' },
        });
        const searched = await searchResponse.json();
        expect(searched.result.memories.some(memory => memory.content === 'The user prefers autonomous persistent memory.')).toBe(true);
    });

    test('executes a valid built-in dice tool request', async () => {
        const response = await fetch(baseUrl + '/execute', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'roleplay_roll_dice', arguments: { count: 2, sides: 20 } }),
        });
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.ok).toBe(true);
        expect(body.result.rolls).toHaveLength(2);
    });

    test('automatically accepts and retrieves memories despite legacy review settings', async () => {
        const settingsResponse = await postJson(baseUrl + '/memory/settings', { requireApproval: true });
        const settings = await settingsResponse.json();
        expect(settings.settings.requireApproval).toBe(false);

        const proposalResponse = await fetch(baseUrl + '/execute', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                activeCharacterId: 'julia-card.png',
                name: 'memory_propose',
                arguments: {
                    content: 'The user prefers practical code examples.',
                    kind: 'preference',
                    importance: 4,
                },
            }),
        });
        const proposed = await proposalResponse.json();
        expect(proposalResponse.status).toBe(200);
        expect(proposed.ok).toBe(true);
        expect(proposed.result.scope).toBe('character');
        expect(proposed.result.requiresReview).toBe(false);
        expect(proposed.result.proposal.status).toBe('approved');
        expect(proposed.result.memory.content).toBe('The user prefers practical code examples.');

        const pendingResponse = await fetch(baseUrl + '/memory/proposals');
        const pending = await pendingResponse.json();
        expect(pending.proposals).toHaveLength(0);

        const searchResponse = await fetch(baseUrl + '/execute', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                activeCharacterId: 'julia-card.png',
                name: 'memory_search',
                arguments: { query: 'practical code examples', scope: 'user' },
            }),
        });
        const searched = await searchResponse.json();
        expect(searchResponse.status).toBe(200);
        expect(searched.result.memories).toHaveLength(1);
    });

    test('bounds retrieved memory content before returning it to the model', async () => {
        await postJson(baseUrl + '/memory/settings', { requireApproval: true });
        const content = 'boundedneedle ' + 'x'.repeat(3900);
        const proposalResponse = await fetch(baseUrl + '/execute', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                activeCharacterId: 'julia-card.png',
                name: 'memory_propose',
                arguments: { content, scope: 'user', kind: 'fact' },
            }),
        });
        expect(proposalResponse.status).toBe(200);

        const searchResponse = await fetch(baseUrl + '/execute', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                activeCharacterId: 'julia-card.png',
                name: 'memory_search',
                arguments: { query: 'boundedneedle', scope: 'user' },
            }),
        });
        const searched = await searchResponse.json();
        const memory = searched.result.memories.find(item => item.content.startsWith('boundedneedle'));

        expect(searchResponse.status).toBe(200);
        expect(memory.content.length).toBeLessThanOrEqual(800);
        expect(memory.metadata).toBeUndefined();
        expect(memory.scopeId).toBeUndefined();
    });

    test('rejects invalid inputs and unknown tools', async () => {
        const invalid = await fetch(baseUrl + '/execute', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'roleplay_roll_dice', arguments: { count: 0, sides: 20 } }),
        });
        expect(invalid.status).toBe(400);

        const missing = await fetch(baseUrl + '/execute', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'unknown_tool', arguments: {} }),
        });
        expect(missing.status).toBe(404);
    });

    test('rejects oversized requests', async () => {
        const response = await fetch(baseUrl + '/execute', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'roleplay_roll_dice', arguments: { count: 1, sides: 6, extra: 'x'.repeat(20 * 1024) } }),
        });
        expect(response.status).toBe(413);
    });

    test('rejects invalid proposal-review decisions', async () => {
        const response = await fetch(baseUrl + '/memory/proposals/not-real/review', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ decision: 'maybe' }),
        });
        expect(response.status).toBe(400);
    });
    test('namespaces captured chat IDs by character to prevent collisions', async () => {
        const capture = async characterId => {
            const response = await fetch(baseUrl + '/capture-turn', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    activeChatId: 'same-chat-filename',
                    activeCharacterId: characterId,
                    role: 'user',
                    content: 'This phrase is local to one character only.',
                    messageKey: '0:user',
                }),
            });
            expect(response.status).toBe(200);
            return response.json();
        };

        const first = await capture('character-a.png');
        const second = await capture('character-b.png');
        expect(first.captured).toBe(true);
        expect(first.duplicate).toBe(false);
        expect(first.capturedCount).toBe(1);
        expect(second.captured).toBe(true);
        expect(second.duplicate).toBe(false);
        expect(second.capturedCount).toBe(1);
    });

    test('enforces autonomous settings, deduplicates captures, and dreams automatically', async () => {
        const initialResponse = await fetch(baseUrl + '/memory/settings');
        const initial = await initialResponse.json();
        expect(initial.settings.autoRetrieveEnabled).toBe(true);
        expect(initial.settings.autoCaptureEnabled).toBe(true);
        expect(initial.settings.autoDreamEnabled).toBe(true);
        expect(initial.settings.requireApproval).toBe(false);

        const settingsResponse = await fetch(baseUrl + '/memory/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ autoRetrieveEnabled: false, autoCaptureEnabled: false, autoDreamEnabled: false, requireApproval: true }),
        });
        const settings = await settingsResponse.json();
        expect(settingsResponse.status).toBe(200);
        expect(settings.settings.autoRetrieveEnabled).toBe(true);
        expect(settings.settings.autoCaptureEnabled).toBe(true);
        expect(settings.settings.autoDreamEnabled).toBe(true);
        expect(settings.settings.requireApproval).toBe(false);

        const captureBody = {
            activeChatId: 'dream-test-chat',
            activeCharacterId: 'julia-card.png',
            role: 'user',
            content: 'We keep returning to the silver key mystery.',
            messageKey: '0:user',
        };
        const firstResponse = await fetch(baseUrl + '/capture-turn', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(captureBody),
        });
        const first = await firstResponse.json();
        const duplicateResponse = await fetch(baseUrl + '/capture-turn', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(captureBody),
        });
        const duplicate = await duplicateResponse.json();
        expect(first.captured).toBe(true);
        expect(first.duplicate).toBe(false);
        expect(duplicate.duplicate).toBe(true);

        let finalCapture = first;
        for (let index = 1; index < 12; index++) {
            const role = index % 2 ? 'assistant' : 'user';
            const response = await fetch(baseUrl + '/capture-turn', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    ...captureBody,
                    role,
                    content: 'The silver key mystery remains important in this conversation.',
                    messageKey: String(index) + ':' + role,
                }),
            });
            finalCapture = await response.json();
            expect(response.status).toBe(200);
            expect(finalCapture.captured).toBe(true);
        }
        expect(finalCapture.capturedCount).toBe(12);
        expect(finalCapture.queuedReflection.created).toBe(true);
        expect(finalCapture.queuedReflection.job.mode).toBe('dream');
        expect(finalCapture.queuedReflection.job.status).toBe('pending');
        const queueStatusResponse = await fetch(baseUrl + '/memory/reflection-jobs/status');
        const queueStatus = await queueStatusResponse.json();
        expect(queueStatus.jobs.pending).toBeGreaterThan(0);

        const manualDreamResponse = await fetch(baseUrl + '/dream', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ activeChatId: 'dream-test-chat', activeCharacterId: 'julia-card.png' }),
        });
        expect(manualDreamResponse.status).toBe(404);

        const clearResponse = await fetch(baseUrl + '/memory/capture-history/clear', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ activeChatId: 'dream-test-chat', activeCharacterId: 'julia-card.png' }),
        });
        const cleared = await clearResponse.json();
        expect(clearResponse.status).toBe(200);
        expect(cleared.clearedTurns).toBe(12);
        expect(cleared.capturedTurnsRemaining).toBe(0);
    });

    test('automatically lists, retrieves, and deletes accepted memories across scopes', async () => {
        await postJson(baseUrl + '/memory/settings', { requireApproval: true });
        const proposalResponse = await fetch(baseUrl + '/execute', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                activeChatId: 'chat-attic-test',
                activeCharacterId: 'julia-card.png',
                name: 'memory_propose',
                arguments: { content: 'A brass telescope belongs in the attic.', kind: 'fact' },
            }),
        });
        const proposed = await proposalResponse.json();
        expect(proposalResponse.status).toBe(200);
        expect(proposed.result.requiresReview).toBe(false);
        expect(proposed.result.scope).toBe('character');
        expect(proposed.result.memory.content).toBe('A brass telescope belongs in the attic.');

        const listResponse = await fetch(baseUrl + '/memory/list?scope=character&scopeId=julia-card.png&activeCharacterId=julia-card.png');
        const listed = await listResponse.json();
        const memory = listed.memories.find(item => item.content === 'A brass telescope belongs in the attic.');
        expect(memory).toBeDefined();
        expect(memory.scope).toBe('character');

        const foreignListResponse = await fetch(baseUrl + '/memory/list?scope=character&scopeId=bella-card.png&activeCharacterId=julia-card.png');
        expect(foreignListResponse.status).toBe(403);
        const globalListResponse = await fetch(baseUrl + '/memory/list?scope=all');
        expect(globalListResponse.status).toBe(400);


        const retrievalResponse = await fetch(baseUrl + '/retrieve-context', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query: 'brass telescope', limit: 3, activeChatId: 'chat-attic-test', activeCharacterId: 'julia-card.png' }),
        });
        const retrieval = await retrievalResponse.json();
        expect(retrievalResponse.status).toBe(200);
        expect(retrieval.enabled).toBe(true);
        expect(retrieval.memories.some(item => item.content === 'A brass telescope belongs in the attic.')).toBe(true);

        const deleteResponse = await fetch(baseUrl + '/memory/' + memory.id, { method: 'DELETE' });
        expect(deleteResponse.status).toBe(200);
        const finalListResponse = await fetch(baseUrl + '/memory/list?scope=character&scopeId=julia-card.png&activeCharacterId=julia-card.png');
        const finalList = await finalListResponse.json();
        expect(finalList.memories.some(item => item.id === memory.id)).toBe(false);
        const afterDeleteRetrievalResponse = await fetch(baseUrl + '/retrieve-context', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query: 'brass telescope', limit: 3, activeChatId: 'chat-attic-test', activeCharacterId: 'julia-card.png' }),
        });
        const afterDeleteRetrieval = await afterDeleteRetrievalResponse.json();
        expect(afterDeleteRetrieval.memories.some(item => item.content === 'A brass telescope belongs in the attic.')).toBe(false);
    });

    test('queues persisted extraction and dreaming jobs for the native server worker only', async () => {
        const characterId = 'auto-memory-character.png';
        const chatId = 'auto-memory-chat.jsonl';
        const roles = ['user', 'assistant', 'user', 'assistant', 'user', 'assistant',
            'user', 'assistant', 'user', 'assistant', 'user', 'assistant'];
        const captureResults = [];

        for (let index = 0; index < roles.length; index++) {
            const response = await postJson(baseUrl + '/capture-turn', {
                activeChatId: chatId,
                activeCharacterId: characterId,
                role: roles[index],
                content: index % 2 === 0
                    ? 'I am learning Rust and want to build a practical file management CLI.'
                    : 'The user is learning Rust and plans to build a file management CLI.',
                messageKey: 'autonomous-' + index,
            });
            expect(response.status).toBe(200);
            captureResults.push(await response.json());
        }

        expect(captureResults[3].queuedReflection.created).toBe(true);
        expect(captureResults[3].queuedReflection.job.mode).toBe('extract');
        expect(captureResults[7].queuedReflection.created).toBe(true);
        expect(captureResults[7].queuedReflection.job.mode).toBe('extract');
        expect(captureResults[11].queuedReflection.created).toBe(true);
        expect(captureResults[11].queuedReflection.job.mode).toBe('dream');

        const queueStatusResponse = await fetch(baseUrl + '/memory/reflection-jobs/status');
        const queueStatus = await queueStatusResponse.json();
        expect(queueStatus.jobs.pending).toBeGreaterThanOrEqual(3);

        expect((await postJson(baseUrl + '/memory/reflection-jobs/claim', {
            activeChatId: chatId,
            activeCharacterId: characterId,
        })).status).toBe(404);
        expect((await postJson(baseUrl + '/memory/reflection-context', {
            activeChatId: chatId,
            activeCharacterId: characterId,
        })).status).toBe(404);
        expect((await postJson(baseUrl + '/memory/reflection-jobs/fake-id/complete', {
            claimToken: 'browser-claim',
        })).status).toBe(404);

        const manualDreamResponse = await postJson(baseUrl + '/dream', {
            activeChatId: chatId,
            activeCharacterId: characterId,
        });
        expect(manualDreamResponse.status).toBe(404);

        const clearResponse = await postJson(baseUrl + '/memory/capture-history/clear', {
            activeChatId: chatId,
            activeCharacterId: characterId,
        });
        const cleared = await clearResponse.json();
        expect(clearResponse.status).toBe(200);
        expect(cleared.clearedTurns).toBe(12);
        expect(cleared.capturedTurnsRemaining).toBe(0);
    });

});
