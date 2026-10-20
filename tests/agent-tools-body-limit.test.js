import { afterEach, describe, test, expect } from '@jest/globals';
import http from 'node:http';
import express from 'express';

import { agentToolsBodyLimit } from '../src/middleware/agent-tools-body-limit.js';

let server;
let baseUrl;

async function startTestServer() {
    const app = express();
    app.use('/api/agent/tools', agentToolsBodyLimit);
    // Emulate the application's later, permissive parser. It must never see a
    // body that was already rejected by the stricter agent-tools parser.
    app.use(express.json({ limit: '500mb' }));
    app.post('/api/agent/tools/execute', (request, response) => {
        response.json({ ok: true, payloadLength: request.body?.payload?.length ?? 0 });
    });

    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve, reject) => {
        server.once('listening', resolve);
        server.once('error', reject);
    });
    baseUrl = 'http://127.0.0.1:' + server.address().port + '/api/agent/tools/execute';
    return baseUrl;
}

function postChunkedJson(url, chunks) {
    const target = new URL(url);
    return new Promise((resolve, reject) => {
        const request = http.request({
            hostname: target.hostname,
            port: target.port,
            path: target.pathname,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Transfer-Encoding': 'chunked',
            },
        }, response => {
            let body = '';
            response.setEncoding('utf8');
            response.on('data', chunk => { body += chunk; });
            response.on('end', () => resolve({
                status: response.statusCode,
                body: JSON.parse(body),
            }));
        });

        request.on('error', reject);
        for (const chunk of chunks) request.write(chunk);
        request.end();
    });
}

afterEach(async () => {
    if (!server) return;
    await new Promise((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
    });
    server = null;
    baseUrl = null;
});

describe('agent tools request body limit', () => {
    test('rejects oversized JSON before the global parser can consume it', async () => {
        const url = await startTestServer();
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ payload: 'x'.repeat(20 * 1024) }),
        });
        const body = await response.json();

        expect(response.status).toBe(413);
        expect(body.error.code).toBe('request_too_large');
    });

    test('enforces the same limit for chunked requests without Content-Length', async () => {
        const url = await startTestServer();
        const response = await postChunkedJson(url, [
            '{"payload":"',
            'x'.repeat(10 * 1024),
            'x'.repeat(10 * 1024),
            '"}',
        ]);

        expect(response.status).toBe(413);
        expect(response.body.error.code).toBe('request_too_large');
    });

    test('rejects non-JSON request bodies on the agent tools path', async () => {
        const url = await startTestServer();
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain' },
            body: 'x'.repeat(20 * 1024),
        });
        const body = await response.json();

        expect(response.status).toBe(415);
        expect(body.error.code).toBe('unsupported_media_type');
    });

    test('allows valid small JSON bodies and passes the parsed body downstream', async () => {
        const url = await startTestServer();
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ payload: 'small request' }),
        });
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body).toEqual({ ok: true, payloadLength: 13 });
    });
});
