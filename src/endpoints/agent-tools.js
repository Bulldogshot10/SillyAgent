import path from 'node:path';
import { promises as fsPromises } from 'node:fs';
import express from 'express';

import { getConfigValue } from '../util.js';
import { MemoryStore } from '../agent/memory-store.js';
import { registerBuiltinTools } from '../agent/builtin-tools.js';
import { toolRegistry } from '../agent/tool-registry.js';

registerBuiltinTools();

export const router = express.Router();

const MAX_REQUEST_BYTES = 16 * 1024;
const memoryStores = new Map();

function getSafeContextId(value) {
    return typeof value === 'string' && value.trim().length > 0 && value.length <= 256
        ? value.trim()
        : null;
}

async function getMemoryStore(request) {
    const root = request.user?.directories?.root ?? globalThis.DATA_ROOT;
    if (typeof root !== 'string' || !root) throw new Error('Could not determine the current user data directory.');

    const directory = path.join(root, 'sillyagent');
    await fsPromises.mkdir(directory, { recursive: true });
    const databasePath = path.join(directory, 'memory.sqlite');

    if (!memoryStores.has(databasePath)) {
        const opening = MemoryStore.open(databasePath);
        memoryStores.set(databasePath, opening);
        opening.catch(() => memoryStores.delete(databasePath));
    }
    return await memoryStores.get(databasePath);
}

async function sendMemoryError(response, error) {
    console.error('[SillyAgent memory]', error);
    return response.status(503).json({
        ok: false,
        error: {
            code: 'memory_unavailable',
            message: error?.message || 'Persistent memory is unavailable.',
        },
    });
}

router.get('/', (_request, response) => {
    return response.json({
        tools: toolRegistry.getFunctionDefinitions({ toolsets: ['roleplay', 'memory'] }),
    });
});

router.get('/memory/proposals', async (request, response) => {
    try {
        const store = await getMemoryStore(request);
        return response.json({
            proposals: store.listProposals({ status: 'pending', limit: 100 }),
            summary: store.getSummary(),
        });
    } catch (error) {
        return sendMemoryError(response, error);
    }
});

router.post('/memory/proposals/:id/review', async (request, response) => {
    const decision = request.body?.decision;
    if (!['approve', 'reject'].includes(decision)) {
        return response.status(400).json({
            ok: false,
            error: { code: 'invalid_decision', message: 'Decision must be approve or reject.' },
        });
    }

    try {
        const store = await getMemoryStore(request);
        const reviewed = store.reviewProposal(request.params.id, decision);
        if (!reviewed) {
            return response.status(404).json({
                ok: false,
                error: { code: 'proposal_not_found', message: 'No pending proposal exists with that ID.' },
            });
        }
        return response.json({ ok: true, ...reviewed, summary: store.getSummary() });
    } catch (error) {
        return sendMemoryError(response, error);
    }
});

router.post('/execute', async (request, response) => {
    const body = request.body ?? {};
    let requestBytes;
    try {
        requestBytes = Buffer.byteLength(JSON.stringify(body), 'utf8');
    } catch {
        return response.status(400).json({
            ok: false,
            error: { code: 'invalid_request', message: 'Request body must be JSON-serializable.' },
        });
    }

    if (requestBytes > MAX_REQUEST_BYTES) {
        return response.status(413).json({
            ok: false,
            error: { code: 'request_too_large', message: 'Tool requests must be 16 KiB or smaller.' },
        });
    }
    if (typeof body.name !== 'string' || !Object.hasOwn(body, 'arguments')) {
        return response.status(400).json({
            ok: false,
            error: { code: 'invalid_request', message: 'Expected a tool name and an arguments object.' },
        });
    }

    let memoryStore = null;
    if (body.name.startsWith('memory_')) {
        try {
            memoryStore = await getMemoryStore(request);
        } catch (error) {
            return sendMemoryError(response, error);
        }
    }

    const result = await toolRegistry.executeTool(body.name, body.arguments, {
        allowedToolsets: ['roleplay', 'memory'],
        allowWrites: !!getConfigValue('agentTools.memoryProposalsEnabled', true, 'boolean'),
        context: {
            source: 'agent-tools-api',
            memoryStore,
            activeChatId: getSafeContextId(body.activeChatId),
            activeCharacterId: getSafeContextId(body.activeCharacterId),
        },
    });

    if (result.ok) return response.json(result);
    const status = {
        invalid_input: 400,
        unknown_tool: 404,
        tool_disabled: 403,
        toolset_not_allowed: 403,
        permission_denied: 403,
        tool_timeout: 504,
        result_too_large: 500,
        invalid_result: 500,
        tool_failed: 500,
    }[result.error.code] ?? 500;
    return response.status(status).json(result);
});
