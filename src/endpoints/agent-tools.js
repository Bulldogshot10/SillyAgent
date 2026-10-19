import path from 'node:path';
import { createHash } from 'node:crypto';
import { promises as fsPromises } from 'node:fs';
import express from 'express';

import { getConfigValue } from '../util.js';
import { MemoryStore } from '../agent/memory-store.js';
import { DreamingEngine } from '../agent/dreaming.js';
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

router.get('/memory/settings', async (request, response) => {
    try {
        const store = await getMemoryStore(request);
        return response.json({ settings: store.getSettings() });
    } catch (error) {
        return sendMemoryError(response, error);
    }
});

router.post('/memory/settings', async (request, response) => {
    try {
        const store = await getMemoryStore(request);
        const settings = store.updateSettings(request.body ?? {});
        return response.json({ ok: true, settings });
    } catch (error) {
        return response.status(400).json({
            ok: false,
            error: { code: 'invalid_settings', message: error?.message || 'Memory settings were invalid.' },
        });
    }
});

router.get('/memory/list', async (request, response) => {
    const scope = typeof request.query.scope === 'string' ? request.query.scope : 'user';
    const scopeId = scope === 'user' ? '' : getSafeContextId(request.query.scopeId);
    const query = typeof request.query.query === 'string' ? request.query.query : '';
    const limit = Number.parseInt(request.query.limit, 10);
    if (scope !== 'user' && !scopeId) {
        return response.status(400).json({
            ok: false,
            error: { code: 'missing_scope_id', message: 'Character and chat lists require an active scope ID.' },
        });
    }
    try {
        const store = await getMemoryStore(request);
        return response.json({
            memories: store.listMemories({ scope, scopeId, query, limit }),
            summary: store.getSummary(),
        });
    } catch (error) {
        return response.status(400).json({
            ok: false,
            error: { code: 'invalid_memory_query', message: error?.message || 'Memory query was invalid.' },
        });
    }
});

router.delete('/memory/:id', async (request, response) => {
    try {
        const store = await getMemoryStore(request);
        const deleted = store.deleteMemory(request.params.id);
        if (!deleted) {
            return response.status(404).json({
                ok: false,
                error: { code: 'memory_not_found', message: 'No accepted memory exists with that ID.' },
            });
        }
        return response.json({ ok: true, summary: store.getSummary() });
    } catch (error) {
        return sendMemoryError(response, error);
    }
});

router.post('/retrieve-context', async (request, response) => {
    const query = request.body?.query;
    if (typeof query !== 'string' || !query.trim() || query.length > 300) {
        return response.status(400).json({
            ok: false,
            error: { code: 'invalid_query', message: 'A search query of 1-300 characters is required.' },
        });
    }
    try {
        const store = await getMemoryStore(request);
        if (!store.getSettings().autoRetrieveEnabled) return response.json({ enabled: false, memories: [] });
        const results = store.searchMemories({
            query,
            scope: 'relevant',
            activeChatId: getSafeContextId(request.body?.activeChatId),
            activeCharacterId: getSafeContextId(request.body?.activeCharacterId),
            limit: Math.max(1, Math.min(3, Number.isInteger(request.body?.limit) ? request.body.limit : 3)),
        }).map(memory => ({
            scope: memory.scope,
            kind: memory.kind,
            importance: memory.importance,
            content: Array.from(memory.content).length > 800 ? Array.from(memory.content).slice(0, 797).join('') + '...' : memory.content,
        }));
        return response.json({ enabled: true, memories: results });
    } catch (error) {
        return sendMemoryError(response, error);
    }
});

router.post('/capture-turn', async (request, response) => {
    const body = request.body ?? {};
    const activeChatId = getSafeContextId(body.activeChatId);
    const activeCharacterId = getSafeContextId(body.activeCharacterId);
    if (!activeChatId || !['user', 'assistant'].includes(body.role)
        || typeof body.content !== 'string' || !body.content.trim()
        || body.content.length > 12000
        || typeof body.messageKey !== 'string' || !body.messageKey.trim() || body.messageKey.length > 128) {
        return response.status(400).json({
            ok: false,
            error: { code: 'invalid_capture', message: 'A chat ID, user/assistant role, bounded content, and message key are required.' },
        });
    }

    try {
        const store = await getMemoryStore(request);
        const settings = store.getSettings();
        if (!settings.autoCaptureEnabled) return response.json({ captured: false, disabled: true });
        const captureKey = createHash('sha256')
            .update(activeChatId + '\0' + body.role + '\0' + body.messageKey + '\0' + body.content)
            .digest('hex');
        const captured = store.captureTurn({
            scopeId: activeChatId,
            role: body.role,
            content: body.content,
            captureKey,
            metadata: { characterId: activeCharacterId, messageKey: body.messageKey },
        });
        const capturedCount = store.countCapturedTurns(activeChatId);
        let dreaming = null;
        if (!captured.duplicate && settings.autoDreamEnabled && capturedCount > 0 && capturedCount % 12 === 0) {
            dreaming = new DreamingEngine(store).run({ scopeId: activeChatId });
        }
        return response.json({ captured: true, duplicate: captured.duplicate, capturedCount, dreaming });
    } catch (error) {
        return sendMemoryError(response, error);
    }
});

router.post('/dream', async (request, response) => {
    const activeChatId = getSafeContextId(request.body?.activeChatId);
    if (!activeChatId) {
        return response.status(400).json({
            ok: false,
            error: { code: 'missing_chat_id', message: 'Dreaming requires an active chat.' },
        });
    }
    try {
        const store = await getMemoryStore(request);
        const result = new DreamingEngine(store).run({ scope: 'chat', scopeId: activeChatId });
        return response.json({ ok: true, ...result, summary: store.getSummary() });
    } catch (error) {
        return response.status(400).json({
            ok: false,
            error: { code: 'dream_failed', message: error?.message || 'Dreaming could not be completed.' },
        });
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
