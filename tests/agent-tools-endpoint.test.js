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
});
