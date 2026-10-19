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

    test('proposes, reviews and retrieves a persisted memory', async () => {
        const proposalResponse = await fetch(baseUrl + '/execute', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name: 'memory_propose',
                arguments: {
                    content: 'The user prefers practical code examples.',
                    scope: 'user',
                    kind: 'preference',
                    importance: 4,
                },
            }),
        });
        const proposed = await proposalResponse.json();
        expect(proposalResponse.status).toBe(200);
        expect(proposed.ok).toBe(true);
        expect(proposed.result.requiresReview).toBe(true);

        const pendingResponse = await fetch(baseUrl + '/memory/proposals');
        const pending = await pendingResponse.json();
        expect(pending.proposals).toHaveLength(1);
        expect(pending.proposals[0].id).toBe(proposed.result.proposal.id);

        const reviewResponse = await fetch(baseUrl + '/memory/proposals/' + proposed.result.proposal.id + '/review', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ decision: 'approve' }),
        });
        const reviewed = await reviewResponse.json();
        expect(reviewResponse.status).toBe(200);
        expect(reviewed.memory.content).toBe('The user prefers practical code examples.');

        const searchResponse = await fetch(baseUrl + '/execute', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name: 'memory_search',
                arguments: { query: 'practical code examples', scope: 'user' },
            }),
        });
        const searched = await searchResponse.json();
        expect(searchResponse.status).toBe(200);
        expect(searched.result.memories).toHaveLength(1);
    });

    test('bounds retrieved memory content before returning it to the model', async () => {
        const content = 'boundedneedle ' + 'x'.repeat(3900);
        const proposalResponse = await fetch(baseUrl + '/execute', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name: 'memory_propose',
                arguments: { content, scope: 'user', kind: 'fact' },
            }),
        });
        const proposed = await proposalResponse.json();
        expect(proposalResponse.status).toBe(200);

        const reviewResponse = await fetch(baseUrl + '/memory/proposals/' + proposed.result.proposal.id + '/review', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ decision: 'approve' }),
        });
        expect(reviewResponse.status).toBe(200);

        const searchResponse = await fetch(baseUrl + '/execute', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
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
    test('manages opt-in settings and deduplicates captured chat turns', async () => {
        const initialResponse = await fetch(baseUrl + '/memory/settings');
        const initial = await initialResponse.json();
        expect(initial.settings.autoRetrieveEnabled).toBe(true);
        expect(initial.settings.autoCaptureEnabled).toBe(false);

        const settingsResponse = await fetch(baseUrl + '/memory/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ autoCaptureEnabled: true, autoDreamEnabled: true }),
        });
        const settings = await settingsResponse.json();
        expect(settingsResponse.status).toBe(200);
        expect(settings.settings.autoCaptureEnabled).toBe(true);

        const captureBody = {
            activeChatId: 'dream-test-chat',
            activeCharacterId: 'julia-card.png',
            role: 'user',
            content: 'We keep returning to the silver key mystery.',
            messageKey: '12:user',
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

        const dreamResponse = await fetch(baseUrl + '/dream', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ activeChatId: 'dream-test-chat' }),
        });
        expect(dreamResponse.status).toBe(200);
        expect((await dreamResponse.json()).eventsReviewed).toBe(1);

        const clearResponse = await fetch(baseUrl + '/memory/capture-history/clear', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ activeChatId: 'dream-test-chat' }),
        });
        const cleared = await clearResponse.json();
        expect(clearResponse.status).toBe(200);
        expect(cleared.clearedTurns).toBe(1);
        expect(cleared.capturedTurnsRemaining).toBe(0);
    });

    test('lists and deletes approved memories through the memory API', async () => {
        const proposalResponse = await fetch(baseUrl + '/execute', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name: 'memory_propose',
                arguments: { content: 'A brass telescope belongs in the attic.', scope: 'user', kind: 'fact' },
            }),
        });
        const proposed = await proposalResponse.json();
        const reviewResponse = await fetch(baseUrl + '/memory/proposals/' + proposed.result.proposal.id + '/review', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ decision: 'approve' }),
        });
        expect(reviewResponse.status).toBe(200);

        const listResponse = await fetch(baseUrl + '/memory/list?scope=user');
        const listed = await listResponse.json();
        const memory = listed.memories.find(item => item.content === 'A brass telescope belongs in the attic.');
        expect(memory).toBeDefined();

        const retrievalResponse = await fetch(baseUrl + '/retrieve-context', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query: 'brass telescope', limit: 3 }),
        });
        const retrieval = await retrievalResponse.json();
        expect(retrievalResponse.status).toBe(200);
        expect(retrieval.enabled).toBe(true);
        expect(retrieval.memories.some(item => item.content === 'A brass telescope belongs in the attic.')).toBe(true);

        const deleteResponse = await fetch(baseUrl + '/memory/' + memory.id, { method: 'DELETE' });
        expect(deleteResponse.status).toBe(200);
        const finalListResponse = await fetch(baseUrl + '/memory/list?scope=user');
        const finalList = await finalListResponse.json();
        expect(finalList.memories.some(item => item.id === memory.id)).toBe(false);
        const afterDeleteRetrievalResponse = await fetch(baseUrl + '/retrieve-context', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query: 'brass telescope', limit: 3 }),
        });
        const afterDeleteRetrieval = await afterDeleteRetrievalResponse.json();
        expect(afterDeleteRetrieval.memories.some(item => item.content === 'A brass telescope belongs in the attic.')).toBe(false);
    });

});
