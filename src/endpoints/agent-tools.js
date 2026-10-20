import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import express from 'express';

import { MemoryStore } from '../agent/memory-store.js';
import { SkillStore } from '../agent/skill-store.js';
import { registerBuiltinTools } from '../agent/builtin-tools.js';
import { registerSkillTools } from '../agent/skill-tools.js';
import { toolRegistry } from '../agent/tool-registry.js';

registerBuiltinTools();
registerSkillTools();

export const router = express.Router();

const MAX_REQUEST_BYTES = 16 * 1024;
const memoryStores = new Map();
const skillStores = new Map();

function getSafeContextId(value) {
    return typeof value === 'string' && value.trim().length > 0 && value.length <= 256
        ? value.trim()
        : null;
}

function getScopedChatId(chatId, characterId) {
    const safeChatId = getSafeContextId(chatId);
    if (!safeChatId) return null;
    const safeCharacterId = getSafeContextId(characterId);
    if (!safeCharacterId) return safeChatId;
    // Chat IDs can be filenames and may collide between characters. Hash both
    // IDs so even chat-scoped memories are isolated by character.
    return 'character-chat-' + createHash('sha256')
        .update(safeCharacterId + '\0' + safeChatId)
        .digest('hex');
}

function getEnvironmentBoolean(name, fallback) {
    const value = process.env[name];
    if (value === undefined) return fallback;
    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
    return fallback;
}

async function getMemoryStore(request) {
    const root = request.user?.directories?.root ?? globalThis.DATA_ROOT;
    if (typeof root !== 'string' || !root) throw new Error('Could not determine the current user data directory.');

    const directory = path.join(root, 'sillyagent');
    const databasePath = path.join(directory, 'memory.sqlite');

    if (!memoryStores.has(databasePath)) {
        const opening = MemoryStore.open(databasePath);
        memoryStores.set(databasePath, opening);
        opening.catch(() => memoryStores.delete(databasePath));
    }
    return await memoryStores.get(databasePath);
}

async function getSkillStore(request) {
    const root = request.user?.directories?.root ?? globalThis.DATA_ROOT;
    if (typeof root !== 'string' || !root) throw new Error('Could not determine the current user data directory.');

    const directory = path.join(root, 'sillyagent');
    const databasePath = path.join(directory, 'skills.sqlite');

    if (!skillStores.has(databasePath)) {
        const opening = SkillStore.open(databasePath);
        skillStores.set(databasePath, opening);
        opening.catch(() => skillStores.delete(databasePath));
    }
    return await skillStores.get(databasePath);
}

function getEffectiveSkillSettings(store) {
    const settings = store.getSettings();
    const environmentOverride = process.env.SILLYTAVERN_AGENTTOOLS_SKILLSREQUIRESAPPROVAL;
    return {
        ...settings,
        requireApproval: environmentOverride === undefined
            ? settings.requireApproval
            : getEnvironmentBoolean('SILLYTAVERN_AGENTTOOLS_SKILLSREQUIRESAPPROVAL', settings.requireApproval),
    };
}

function getEffectiveMemorySettings(store, { migratePending = false } = {}) {
    // Memory is autonomous by design. Normalize legacy user settings once so
    // capture, retrieval, and dreaming do not depend on UI toggles.
    const current = store.getSettings();
    const autonomousSettings = {
        autoRetrieveEnabled: true,
        autoCaptureEnabled: true,
        autoDreamEnabled: true,
        requireApproval: false,
    };
    const legacyOverrides = Object.fromEntries(
        Object.entries(autonomousSettings).filter(([key, value]) => current[key] !== value),
    );
    if (Object.keys(legacyOverrides).length) {
        store.updateSettings(legacyOverrides);
    }
    if (migratePending || current.requireApproval) {
        store.autoApprovePendingProposals();
    }
    return { ...store.getSettings(), ...autonomousSettings };
}

async function sendSkillError(response, error) {
    console.error('[SillyAgent skills]', error);
    return response.status(503).json({
        ok: false,
        error: {
            code: 'skills_unavailable',
            message: error?.message || 'Persistent agent skills are unavailable.',
        },
    });
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
        tools: toolRegistry.getFunctionDefinitions({ toolsets: ['roleplay', 'memory', 'skills'] }),
    });
});

router.get('/skills', async (request, response) => {
    const query = typeof request.query.query === 'string' ? request.query.query : '';
    const limit = Number.parseInt(request.query.limit, 10);
    try {
        const store = await getSkillStore(request);
        return response.json({
            skills: store.listSkills({ query, limit }),
            settings: getEffectiveSkillSettings(store),
            disclosure: 'metadata-only; fetch a selected skill to load its instructions',
        });
    } catch (error) {
        return sendSkillError(response, error);
    }
});

router.get('/skills/settings', async (request, response) => {
    try {
        const store = await getSkillStore(request);
        return response.json({ settings: getEffectiveSkillSettings(store) });
    } catch (error) {
        return sendSkillError(response, error);
    }
});

router.post('/skills/settings', async (request, response) => {
    try {
        const store = await getSkillStore(request);
        store.updateSettings(request.body ?? {});
        return response.json({ ok: true, settings: getEffectiveSkillSettings(store) });
    } catch (error) {
        return response.status(400).json({
            ok: false,
            error: { code: 'invalid_skill_settings', message: error?.message || 'Skill settings were invalid.' },
        });
    }
});

router.get('/skills/pending', async (request, response) => {
    try {
        const store = await getSkillStore(request);
        return response.json({ revisions: store.listPendingRevisions({ limit: 100 }) });
    } catch (error) {
        return sendSkillError(response, error);
    }
});

router.get('/skills/:slug/history', async (request, response) => {
    try {
        const store = await getSkillStore(request);
        return response.json({
            slug: request.params.slug,
            revisions: store.getHistory(request.params.slug, { limit: 100 }),
            events: store.getEvents({ slug: request.params.slug, limit: 100 }),
        });
    } catch (error) {
        return response.status(400).json({
            ok: false,
            error: { code: 'invalid_skill_history_query', message: error?.message || 'Skill history could not be read.' },
        });
    }
});

router.get('/skills/:slug/revisions/:version', async (request, response) => {
    const version = Number(request.params.version);
    if (!Number.isSafeInteger(version) || version < 1) {
        return response.status(400).json({
            ok: false,
            error: { code: 'invalid_skill_version', message: 'A positive skill version is required.' },
        });
    }
    try {
        const store = await getSkillStore(request);
        const revision = store.getRevision(request.params.slug, version);
        if (!revision) {
            return response.status(404).json({
                ok: false,
                error: { code: 'skill_revision_not_found', message: 'No revision exists for that skill version.' },
            });
        }
        return response.json({ revision });
    } catch (error) {
        return response.status(400).json({
            ok: false,
            error: { code: 'invalid_skill_revision', message: error?.message || 'Skill revision could not be read.' },
        });
    }
});

router.post('/skills/:slug/revisions/:version/review', async (request, response) => {
    const version = Number.parseInt(request.params.version, 10);
    const decision = request.body?.decision;
    if (!Number.isInteger(version) || version < 1 || !['approve', 'reject'].includes(decision)) {
        return response.status(400).json({
            ok: false,
            error: { code: 'invalid_skill_review', message: 'A positive version and approve/reject decision are required.' },
        });
    }
    try {
        const store = await getSkillStore(request);
        const revision = store.reviewRevision(request.params.slug, version, decision);
        if (!revision) {
            return response.status(404).json({
                ok: false,
                error: { code: 'skill_revision_not_pending', message: 'No pending revision exists for that skill version.' },
            });
        }
        return response.json({ ok: true, revision, activeSkill: store.readSkill(request.params.slug) });
    } catch (error) {
        return response.status(400).json({
            ok: false,
            error: { code: 'skill_review_failed', message: error?.message || 'Skill revision could not be reviewed.' },
        });
    }
});

router.post('/skills/:slug/rollback', async (request, response) => {
    const targetVersion = request.body?.targetVersion;
    if (!Number.isInteger(targetVersion) || targetVersion < 1) {
        return response.status(400).json({
            ok: false,
            error: { code: 'invalid_rollback_target', message: 'targetVersion must be a positive integer.' },
        });
    }
    try {
        const store = await getSkillStore(request);
        const settings = getEffectiveSkillSettings(store);
        const result = store.rollbackSkill(request.params.slug, targetVersion, {
            requireApproval: settings.requireApproval,
            reason: request.body?.reason,
        });
        const revision = store.getHistory(request.params.slug, { limit: 100 })
            .find(item => item.version === result.revision.version);
        return response.json({
            ok: true,
            created: result.created,
            duplicate: result.duplicate,
            requiresApproval: result.requiresApproval,
            revision,
        });
    } catch (error) {
        return response.status(400).json({
            ok: false,
            error: { code: 'skill_rollback_failed', message: error?.message || 'Skill rollback failed.' },
        });
    }
});

router.get('/skills/:slug', async (request, response) => {
    try {
        const store = await getSkillStore(request);
        const skill = store.readSkill(request.params.slug);
        if (!skill) {
            return response.status(404).json({
                ok: false,
                error: { code: 'active_skill_not_found', message: 'No active skill exists with that slug.' },
            });
        }
        return response.json({ skill });
    } catch (error) {
        return response.status(400).json({
            ok: false,
            error: { code: 'invalid_skill_slug', message: error?.message || 'The skill slug was invalid.' },
        });
    }
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
        return response.json({ settings: getEffectiveMemorySettings(store, { migratePending: true }) });
    } catch (error) {
        return sendMemoryError(response, error);
    }
});

router.post('/memory/settings', async (request, response) => {
    try {
        const store = await getMemoryStore(request);
        store.updateSettings(request.body ?? {});
        return response.json({ ok: true, settings: getEffectiveMemorySettings(store, { migratePending: true }) });
    } catch (error) {
        return response.status(400).json({
            ok: false,
            error: { code: 'invalid_settings', message: error?.message || 'Memory settings were invalid.' },
        });
    }
});

router.get('/memory/list', async (request, response) => {
    const scope = typeof request.query.scope === 'string' ? request.query.scope : 'all';
    const rawScopeId = getSafeContextId(request.query.scopeId);
    const activeChatId = getSafeContextId(request.query.activeChatId);
    const activeCharacterId = getSafeContextId(request.query.activeCharacterId);
    const scopeId = ['user', 'all'].includes(scope)
        ? ''
        : scope === 'chat' && activeChatId
            ? getScopedChatId(activeChatId, activeCharacterId)
            : rawScopeId;
    const query = typeof request.query.query === 'string' ? request.query.query : '';
    const limit = Number.parseInt(request.query.limit, 10);
    if (!['user', 'all'].includes(scope) && !scopeId) {
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

router.post('/memory/capture-history/clear', async (request, response) => {
    const rawChatId = getSafeContextId(request.body?.activeChatId);
    const activeCharacterId = getSafeContextId(request.body?.activeCharacterId);
    const activeChatId = getScopedChatId(rawChatId, activeCharacterId);
    if (!activeChatId) {
        return response.status(400).json({
            ok: false,
            error: { code: 'missing_chat_id', message: 'Clearing captured history requires an active chat.' },
        });
    }
    try {
        const store = await getMemoryStore(request);
        const clearedTurns = store.clearCapturedTurns(activeChatId);
        return response.json({
            ok: true,
            clearedTurns,
            capturedTurnsRemaining: store.countCapturedTurns(activeChatId),
        });
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
        if (!getEffectiveMemorySettings(store).autoRetrieveEnabled) return response.json({ enabled: false, memories: [] });
        const results = store.searchMemories({
            query,
            scope: 'relevant',
            activeChatId: getScopedChatId(
                getSafeContextId(request.body?.activeChatId),
                getSafeContextId(request.body?.activeCharacterId),
            ),
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

router.get('/memory/reflection-jobs/status', async (request, response) => {
    try {
        const store = await getMemoryStore(request);
        return response.json({ jobs: store.getReflectionJobSummary() });
    } catch (error) {
        return sendMemoryError(response, error);
    }
});

router.post('/memory/reflection-jobs/claim', async (request, response) => {
    const activeChatId = getSafeContextId(request.body?.activeChatId);
    const activeCharacterId = getSafeContextId(request.body?.activeCharacterId);
    if (!activeChatId) {
        return response.status(400).json({
            ok: false,
            error: { code: 'missing_chat_id', message: 'Claiming reflection jobs requires an active chat.' },
        });
    }
    try {
        const store = await getMemoryStore(request);
        const job = store.claimReflectionJob({
            scopeId: getScopedChatId(activeChatId, activeCharacterId),
            characterId: activeCharacterId,
            claimToken: randomUUID(),
        });
        return response.json({ job });
    } catch (error) {
        return sendMemoryError(response, error);
    }
});

router.post('/memory/reflection-jobs/:id/complete', async (request, response) => {
    const claimToken = getSafeContextId(request.body?.claimToken);
    if (!claimToken) {
        return response.status(400).json({
            ok: false,
            error: { code: 'missing_claim_token', message: 'A reflection job claim token is required.' },
        });
    }
    try {
        const store = await getMemoryStore(request);
        const completed = store.completeReflectionJob(request.params.id, claimToken);
        return completed
            ? response.json({ ok: true, completed: true })
            : response.status(409).json({ ok: false, error: { code: 'stale_claim', message: 'The reflection job claim is no longer active.' } });
    } catch (error) {
        return sendMemoryError(response, error);
    }
});

router.post('/memory/reflection-jobs/:id/fail', async (request, response) => {
    const claimToken = getSafeContextId(request.body?.claimToken);
    if (!claimToken) {
        return response.status(400).json({
            ok: false,
            error: { code: 'missing_claim_token', message: 'A reflection job claim token is required.' },
        });
    }
    try {
        const store = await getMemoryStore(request);
        const failed = store.failReflectionJob(
            request.params.id,
            claimToken,
            typeof request.body?.error === 'string' ? request.body.error : 'Autonomous reflection failed.',
        );
        return failed
            ? response.json({ ok: true, retried: true })
            : response.status(409).json({ ok: false, error: { code: 'stale_claim', message: 'The reflection job claim is no longer active.' } });
    } catch (error) {
        return sendMemoryError(response, error);
    }
});

router.post('/memory/reflection-context', async (request, response) => {
    const activeChatId = getSafeContextId(request.body?.activeChatId);
    const activeCharacterId = getSafeContextId(request.body?.activeCharacterId);
    if (!activeChatId) {
        return response.status(400).json({
            ok: false,
            error: { code: 'missing_chat_id', message: 'Autonomous reflection requires an active chat.' },
        });
    }

    try {
        const store = await getMemoryStore(request);
        const scopedChatId = getScopedChatId(activeChatId, activeCharacterId);
        const captured = store.listCapturedTurnsAcrossChats({ limit: 2000 });
        const isolatedTurns = activeCharacterId
            ? captured.filter(event => event.metadata?.characterId === activeCharacterId)
            : captured.filter(event => event.scopeId === scopedChatId);
        const turns = isolatedTurns.slice(-80).map(event => ({
            role: event.metadata?.role,
            content: event.content,
            chatId: event.scopeId,
            createdAt: event.createdAt,
        })).filter(turn => ['user', 'assistant'].includes(turn.role));

        const characterMemories = activeCharacterId
            ? store.listMemories({ scope: 'character', scopeId: activeCharacterId, limit: 50 })
            : [];
        const chatMemories = store.listMemories({ scope: 'chat', scopeId: scopedChatId, limit: 20 });

        return response.json({
            turns,
            memories: [...characterMemories, ...chatMemories].map(memory => ({
                id: memory.id,
                kind: memory.kind,
                scope: memory.scope,
                content: memory.content,
                importance: memory.importance,
            })),
            activeCharacterId,
            activeChatId: scopedChatId,
        });
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
        const settings = getEffectiveMemorySettings(store);
        if (!settings.autoCaptureEnabled) return response.json({ captured: false, disabled: true });
        const scopedChatId = getScopedChatId(activeChatId, activeCharacterId);
        const captureKey = createHash('sha256')
            .update((activeCharacterId ?? '') + '\0' + activeChatId + '\0' + body.role + '\0' + body.messageKey + '\0' + body.content)
            .digest('hex');
        const captured = store.captureTurn({
            scopeId: scopedChatId,
            role: body.role,
            content: body.content,
            captureKey,
            metadata: { characterId: activeCharacterId, messageKey: body.messageKey },
        });
        const capturedCount = store.countCapturedTurns(scopedChatId);
        let queuedReflection = null;
        if (!captured.duplicate && body.role === 'assistant' && settings.autoDreamEnabled
            && capturedCount > 0 && capturedCount % 4 === 0) {
            const mode = capturedCount % 12 === 0 ? 'dream' : 'extract';
            queuedReflection = store.enqueueReflectionJob({
                scopeId: scopedChatId,
                chatId: activeChatId,
                characterId: activeCharacterId,
                mode,
                triggerEventId: captured.event.id,
                triggerCount: capturedCount,
            });
        }
        return response.json({ captured: true, duplicate: captured.duplicate, capturedCount, queuedReflection });
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

    let skillStore = null;
    if (body.name.startsWith('skill_')) {
        try {
            skillStore = await getSkillStore(request);
        } catch (error) {
            return sendSkillError(response, error);
        }
    }

    const memoryWritesEnabled = getEnvironmentBoolean('SILLYTAVERN_AGENTTOOLS_MEMORYPROPOSALSENABLED', true);
    const skillWritesEnabled = getEnvironmentBoolean('SILLYTAVERN_AGENTTOOLS_SKILLWRITESENABLED', true);
    const allowedWriteToolsets = [];
    if (memoryWritesEnabled) allowedWriteToolsets.push('memory');
    if (skillWritesEnabled) allowedWriteToolsets.push('skills');

    const result = await toolRegistry.executeTool(body.name, body.arguments, {
        allowedToolsets: ['roleplay', 'memory', 'skills'],
        allowWrites: allowedWriteToolsets.length > 0,
        allowedWriteToolsets,
        context: {
            source: 'agent-tools-api',
            memoryStore,
            skillStore,
            requireSkillApproval: skillStore ? getEffectiveSkillSettings(skillStore).requireApproval : false,
            requireMemoryApproval: memoryStore ? getEffectiveMemorySettings(memoryStore).requireApproval : false,
            activeChatId: getScopedChatId(
                getSafeContextId(body.activeChatId),
                getSafeContextId(body.activeCharacterId),
            ),
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
