import { afterAll, beforeAll, describe, test, expect } from '@jest/globals';
import express from 'express';

import { router } from '../src/endpoints/agent-tools.js';

let server;
let baseUrl;

beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/agent/tools', router);
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve, reject) => {
        server.once('listening', resolve);
        server.once('error', reject);
    });
    baseUrl = `http://127.0.0.1:${server.address().port}/api/agent/tools`;
});

afterAll(async () => {
    if (server) {
        await new Promise((resolve, reject) => {
            server.close(error => error ? reject(error) : resolve());
        });
    }
});

describe('agent tools API', () => {
    test('publishes function-calling tool definitions', async () => {
        const response = await fetch(baseUrl);
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.tools.some(tool => tool.function.name === 'roleplay_roll_dice')).toBe(true);
    });

    test('executes a valid built-in tool request', async () => {
        const response = await fetch(`${baseUrl}/execute`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'roleplay_roll_dice', arguments: { count: 2, sides: 20 } }),
        });
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.ok).toBe(true);
        expect(body.result.rolls).toHaveLength(2);
    });

    test('rejects invalid inputs and unknown tools', async () => {
        const invalid = await fetch(`${baseUrl}/execute`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'roleplay_roll_dice', arguments: { count: 0, sides: 20 } }),
        });
        expect(invalid.status).toBe(400);

        const missing = await fetch(`${baseUrl}/execute`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'unknown.tool', arguments: {} }),
        });
        expect(missing.status).toBe(404);
    });

    test('rejects oversized requests', async () => {
        const response = await fetch(`${baseUrl}/execute`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'roleplay_roll_dice', arguments: { count: 1, sides: 6, extra: 'x'.repeat(20 * 1024) } }),
        });
        expect(response.status).toBe(413);
    });
});
