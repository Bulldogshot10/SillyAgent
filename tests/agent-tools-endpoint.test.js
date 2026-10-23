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
    const charactersDirectory = path.join(userRoot, 'characters');
    const chatsDirectory = path.join(userRoot, 'chats');
    const groupChatsDirectory = path.join(userRoot, 'groupChats');
    await Promise.all([
        fs.mkdir(charactersDirectory, { recursive: true }),
        fs.mkdir(chatsDirectory, { recursive: true }),
        fs.mkdir(groupChatsDirectory, { recursive: true }),
    ]);
    await fs.writeFile(path.join(charactersDirectory, 'harness-character.png'), 'test character');
    await fs.writeFile(path.join(charactersDirectory, 'character-a.png'), 'test character');
    await fs.writeFile(path.join(charactersDirectory, 'character-b.png'), 'test character');
    await fs.writeFile(path.join(charactersDirectory, 'julia-card.png'), 'test character');
    await fs.writeFile(path.join(charactersDirectory, 'character-auto-review.png'), 'test character');
    await fs.writeFile(path.join(charactersDirectory, 'bella-card.png'), 'test character');
    await fs.writeFile(path.join(charactersDirectory, 'auto-memory-character.png'), 'test character');
    const userDirectories = {
        root: userRoot,
        characters: charactersDirectory,
        chats: chatsDirectory,
        groupChats: groupChatsDirectory,
    };
    const app = express();
    app.use(express.json());
    app.use((request, _response, next) => {
        request.user = { directories: userDirectories };
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
        for (const toolName of [
            'world_get_state',
            'world_update_state',
            'character_get_state',
            'character_update_state',
            'scene_get_state',
            'scene_advance',
            'lore_search',
            'dice_roll',
        ]) {
            expect(body.tools.some(tool => tool.function.name === toolName)).toBe(true);
        }
    });

    test('persists world, character, and scene changes through the native tool endpoint', async () => {
        const context = { activeCharacterId: 'harness-character.png', activeChatId: 'harness-chat' };
        const worldWrite = await postJson(baseUrl + '/execute', {
            ...context,
            name: 'world_update_state',
            arguments: { patch: { location: 'North greenhouse', weather: 'rain' }, expectedVersion: 0 },
        });
        const worldWritten = await worldWrite.json();
        expect(worldWrite.status).toBe(200);
        expect(worldWritten.ok).toBe(true);
        expect(worldWritten.result.version).toBe(1);

        const worldRead = await postJson(baseUrl + '/execute', {
            ...context,
            name: 'world_get_state',
            arguments: {},
        });
        expect((await worldRead.json()).result.state.location).toBe('North greenhouse');

        const characterWrite = await postJson(baseUrl + '/execute', {
            ...context,
            name: 'character_update_state',
            arguments: { patch: { condition: 'bruised wrist' }, expectedVersion: 0 },
        });
        expect(characterWrite.status).toBe(200);
        const characterRead = await postJson(baseUrl + '/execute', {
            ...context,
            name: 'character_get_state',
            arguments: {},
        });
        expect((await characterRead.json()).result.state.condition).toBe('bruised wrist');

        const sceneAdvance = await postJson(baseUrl + '/execute', {
            ...context,
            name: 'scene_advance',
            arguments: {
                summary: 'The characters leave the greenhouse for the station.',
                location: 'Station',
                openThreads: ['Who left the key?'],
                expectedVersion: 0,
            },
        });
        expect(sceneAdvance.status).toBe(200);
        expect((await sceneAdvance.json()).result.state.sceneNumber).toBe(1);

        const sceneRead = await postJson(baseUrl + '/execute', {
            ...context,
            name: 'scene_get_state',
            arguments: {},
        });
        expect((await sceneRead.json()).result.state.location).toBe('Station');
    });

    test('scopes world state by the active lorebook set across chats', async () => {
        const sharedWorld = ['North Kingdom', 'Royal Archive'];
        const write = await postJson(baseUrl + '/execute', {
            activeCharacterId: 'character-a.png',
            activeChatId: 'chat-one',
            activeWorldNames: sharedWorld,
            name: 'world_update_state',
            arguments: { patch: { capital: 'Veyr' }, expectedVersion: 0 },
        });
        expect(write.status).toBe(200);
        expect((await write.json()).result.state.capital).toBe('Veyr');

        const sameWorldOtherChat = await postJson(baseUrl + '/execute', {
            activeCharacterId: 'character-b.png',
            activeChatId: 'chat-two',
            activeWorldNames: ['Royal Archive', 'North Kingdom'],
            name: 'world_get_state',
            arguments: {},
        });
        expect((await sameWorldOtherChat.json()).result.state.capital).toBe('Veyr');

        const differentWorld = await postJson(baseUrl + '/execute', {
            activeCharacterId: 'character-a.png',
            activeChatId: 'chat-three',
            activeWorldNames: ['South Isles'],
            name: 'world_get_state',
            arguments: {},
        });
        expect((await differentWorld.json()).result.state).toEqual({});
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
    test('queues automatic review on an assistant reply without turn-count thresholds and coalesces pending work', async () => {
        const context = {
            activeChatId: 'natural-roleplay-chat',
            activeCharacterId: 'character-auto-review.png',
        };
        const userResponse = await postJson(baseUrl + '/capture-turn', {
            ...context,
            role: 'user',
            content: 'I prefer quiet scenes and natural conversation.',
            messageKey: '0:user',
        });
        const user = await userResponse.json();
        expect(userResponse.status).toBe(200);
        expect(user.queuedReflection).toBeNull();

        const firstResponse = await postJson(baseUrl + '/capture-turn', {
            ...context,
            role: 'assistant',
            content: 'The room settles into a quiet evening scene.',
            messageKey: '1:assistant',
        });
        const first = await firstResponse.json();
        expect(firstResponse.status).toBe(200);
        expect(first.capturedCount).toBe(2);
        expect(first.queuedReflection.job.mode).toBe('extract');
        expect(first.queuedReflection.created).toBe(true);

        const secondResponse = await postJson(baseUrl + '/capture-turn', {
            ...context,
            role: 'assistant',
            content: 'Outside, rain begins tapping against the window.',
            messageKey: '2:assistant',
        });
        const second = await secondResponse.json();
        expect(secondResponse.status).toBe(200);
        expect(second.capturedCount).toBe(3);
        expect(second.queuedReflection.coalesced).toBe(true);
        expect(second.queuedReflection.job.id).toBe(first.queuedReflection.job.id);
        expect(second.queuedReflection.job.triggerEventId).not.toBe(first.queuedReflection.job.triggerEventId);

        const params = new URLSearchParams(context);
        const statusResponse = await fetch(baseUrl + '/memory/reflection-jobs/status?' + params.toString());
        const status = await statusResponse.json();
        expect(status.jobs.pending).toBe(1);
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

    test('enforces autonomous settings and queues post-assistant-turn reviews without count triggers', async () => {
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
        expect(finalCapture.queuedReflection.coalesced).toBe(true);
        expect(finalCapture.queuedReflection.job.mode).toBe('extract');
        expect(finalCapture.queuedReflection.job.status).toBe('pending');
        const queueStatusResponse = await fetch(baseUrl
            + '/memory/reflection-jobs/status?activeCharacterId=julia-card.png&activeChatId=dream-test-chat');
        const queueStatus = await queueStatusResponse.json();
        expect(queueStatus.jobs.pending).toBeGreaterThan(0);

        const juliaPendingBefore = queueStatus.jobs.pending;
        for (let index = 0; index < 4; index++) {
            const role = index % 2 ? 'assistant' : 'user';
            const response = await fetch(baseUrl + '/capture-turn', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    activeChatId: 'bella-queue-test-chat',
                    activeCharacterId: 'bella-card.png',
                    role,
                    content: 'An unrelated reflection queue item for Bella.',
                    messageKey: 'bella-' + index + ':' + role,
                }),
            });
            expect(response.status).toBe(200);
        }
        const juliaQueueAfter = await fetch(baseUrl + '/memory/reflection-jobs/status?activeCharacterId=julia-card.png');
        expect((await juliaQueueAfter.json()).jobs.pending).toBe(juliaPendingBefore);
        const unscopedQueue = await fetch(baseUrl + '/memory/reflection-jobs/status');
        expect((await unscopedQueue.json()).jobs).toEqual({ pending: 0, running: 0, completed: 0, failed: 0 });

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

        const summaryBefore = await fetch(baseUrl + '/memory/proposals?activeCharacterId=julia-card.png&activeChatId=chat-attic-test');
        const juliaSummaryBefore = (await summaryBefore.json()).summary;

        const otherProposalResponse = await postJson(baseUrl + '/execute', {
            activeChatId: 'bella-chat-test',
            activeCharacterId: 'bella-card.png',
            name: 'memory_propose',
            arguments: { content: 'A crystal orb belongs to Bella.', kind: 'fact' },
        });
        const otherProposal = await otherProposalResponse.json();
        expect(otherProposal.result.memory.scope).toBe('character');
        expect(otherProposal.result.memory.scopeId).toBe('bella-card.png');

        const summaryAfter = await fetch(baseUrl + '/memory/proposals?activeCharacterId=julia-card.png&activeChatId=chat-attic-test');
        const juliaSummaryAfter = (await summaryAfter.json()).summary;
        expect(juliaSummaryAfter).toEqual(juliaSummaryBefore);

        const crossCharacterDelete = await fetch(
            baseUrl + '/memory/' + encodeURIComponent(otherProposal.result.memory.id)
                + '?activeCharacterId=julia-card.png&activeChatId=chat-attic-test',
            { method: 'DELETE' },
        );
        expect(crossCharacterDelete.status).toBe(404);
        const bellaList = await fetch(baseUrl + '/memory/list?scope=character&scopeId=bella-card.png&activeCharacterId=bella-card.png');
        const bellaMemories = await bellaList.json();
        expect(bellaMemories.memories.some(item => item.id === otherProposal.result.memory.id)).toBe(true);

        const deleteResponse = await fetch(
            baseUrl + '/memory/' + memory.id + '?activeCharacterId=julia-card.png&activeChatId=chat-attic-test',
            { method: 'DELETE' },
        );
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

    test('coalesces persisted post-turn reviews for the native server worker only', async () => {
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

        expect(captureResults[1].queuedReflection.created).toBe(true);
        expect(captureResults[3].queuedReflection.coalesced).toBe(true);
        expect(captureResults[3].queuedReflection.job.mode).toBe('extract');
        expect(captureResults[7].queuedReflection.coalesced).toBe(true);
        expect(captureResults[7].queuedReflection.job.mode).toBe('extract');
        expect(captureResults[11].queuedReflection.coalesced).toBe(true);
        expect(captureResults[11].queuedReflection.job.mode).toBe('extract');

        const queueStatusResponse = await fetch(baseUrl
            + '/memory/reflection-jobs/status?activeCharacterId=' + encodeURIComponent(characterId)
            + '&activeChatId=' + encodeURIComponent(chatId));
        const queueStatus = await queueStatusResponse.json();
        expect(queueStatus.jobs.pending).toBe(1);

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
