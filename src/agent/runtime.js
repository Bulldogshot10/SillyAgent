import path from 'node:path';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';

import { MemoryStore } from './memory-store.js';
import { SkillStore } from './skill-store.js';
import { RoleplayStateStore } from './roleplay-state-store.js';
import { startReflectionWorker } from './reflection-worker.js';

const memoryStores = new Map();
const skillStores = new Map();
const roleplayStateStores = new Map();
const workerHandles = new Map();

function normalizeDirectories(input) {
    const directories = typeof input === 'string' ? { root: input } : input;
    if (!directories || typeof directories.root !== 'string' || !directories.root.trim()) {
        throw new TypeError('A user data directory is required for the SillyAgent runtime.');
    }
    return { directories, root: path.resolve(directories.root) };
}

export function getAgentScopedChatId(chatId, characterId = null) {
    const safeChatId = typeof chatId === 'string' && chatId.trim().length > 0 && chatId.length <= 256
        ? chatId.trim()
        : null;
    if (!safeChatId) return null;
    const safeCharacterId = typeof characterId === 'string' && characterId.trim().length > 0 && characterId.length <= 256
        ? characterId.trim()
        : null;
    if (!safeCharacterId) return safeChatId;
    return 'character-chat-' + createHash('sha256')
        .update(safeCharacterId + '\0' + safeChatId)
        .digest('hex');
}

export async function getAgentMemoryStore(input, { startWorker = true } = {}) {
    const { directories, root } = normalizeDirectories(input);
    const databasePath = path.join(root, 'sillyagent', 'memory.sqlite');
    if (!memoryStores.has(databasePath)) {
        const opening = MemoryStore.open(databasePath);
        memoryStores.set(databasePath, opening);
        opening.catch(() => memoryStores.delete(databasePath));
    }
    const store = await memoryStores.get(databasePath);
    if (startWorker && !workerHandles.has(databasePath)) {
        const starting = startReflectionWorker({
            store,
            directories: { ...directories, root },
            getSkillStore: characterId => getAgentSkillStore(directories, characterId),
        });
        workerHandles.set(databasePath, starting);
    }
    return store;
}

export async function deleteAgentChatPartitionIfPresent(input, chatId, characterId = null) {
    const { directories, root } = normalizeDirectories(input);
    const scopeId = getAgentScopedChatId(chatId, characterId);
    if (!scopeId) throw new TypeError('A valid chat ID is required to delete SillyAgent chat data.');

    const memoryDatabasePath = path.join(root, 'sillyagent', 'memory.sqlite');
    const stateDatabasePath = path.join(root, 'sillyagent', 'roleplay-state.sqlite');
    const memoryExists = memoryStores.has(memoryDatabasePath) || existsSync(memoryDatabasePath);
    const stateExists = roleplayStateStores.has(stateDatabasePath) || existsSync(stateDatabasePath);

    let memory = null;
    let roleplayState = null;
    if (memoryExists) {
        const store = await getAgentMemoryStore({ ...directories, root }, { startWorker: false });
        memory = store.deleteChatPartition(scopeId);
    }
    if (stateExists) {
        const store = await getAgentRoleplayStateStore({ ...directories, root });
        roleplayState = store.deleteChatPartition(scopeId);
    }

    return {
        found: memoryExists || stateExists,
        clearedTurns: memory?.clearedTurns ?? 0,
        deletedMemories: memory?.deletedMemories ?? 0,
        deletedProposals: memory?.deletedProposals ?? 0,
        cancelledJobs: memory?.cancelledJobs ?? 0,
        roleplayState,
    };
}

/**
 * Purge all native harness data tied to a deleted character, including its
 * physical chat partitions, character memory/state, and procedural skills.
 * @param {string|object} input User directories.
 * @param {string} characterId Character avatar identifier.
 * @param {string[]} chatIds Existing chat IDs from the character's chat directory.
 * @returns {Promise<object>} Cleanup counts by subsystem.
 */
export async function deleteAgentCharacterPartitionsIfPresent(input, characterId, chatIds = []) {
    const { directories, root } = normalizeDirectories(input);
    if (typeof characterId !== 'string' || !characterId.trim() || characterId.length > 256) {
        throw new TypeError('A valid character ID is required to delete SillyAgent character data.');
    }
    if (!Array.isArray(chatIds) || chatIds.some(id => typeof id !== 'string' || !id.trim() || id.length > 256)) {
        throw new TypeError('Character chat IDs must be an array of valid strings.');
    }

    const normalizedCharacterId = characterId.trim();
    const uniqueChatIds = [...new Set(chatIds.map(id => id.trim()))];
    const chatResults = [];
    for (const chatId of uniqueChatIds) {
        chatResults.push(await deleteAgentChatPartitionIfPresent(
            { ...directories, root },
            chatId,
            normalizedCharacterId,
        ));
    }

    const memoryDatabasePath = path.join(root, 'sillyagent', 'memory.sqlite');
    const stateDatabasePath = path.join(root, 'sillyagent', 'roleplay-state.sqlite');
    const skillPartition = createHash('sha256').update(normalizedCharacterId, 'utf8').digest('hex');
    const skillDatabasePath = path.join(root, 'sillyagent', 'skills', skillPartition + '.sqlite');

    let memory = null;
    let roleplayState = null;
    let skills = null;
    if (memoryStores.has(memoryDatabasePath) || existsSync(memoryDatabasePath)) {
        const store = await getAgentMemoryStore({ ...directories, root }, { startWorker: false });
        memory = store.deleteCharacterPartition(normalizedCharacterId);
    }
    if (roleplayStateStores.has(stateDatabasePath) || existsSync(stateDatabasePath)) {
        const store = await getAgentRoleplayStateStore({ ...directories, root });
        roleplayState = store.deleteCharacterPartition(normalizedCharacterId);
    }
    if (skillStores.has(skillDatabasePath) || existsSync(skillDatabasePath)) {
        const store = await getAgentSkillStore({ ...directories, root }, normalizedCharacterId);
        skills = store.clearAll();
    }

    return {
        characterId: normalizedCharacterId,
        chatPartitionsProcessed: chatResults.length,
        chatResults,
        memory,
        roleplayState,
        skills,
    };
}

export async function getAgentSkillStore(input, characterId) {
    const { root } = normalizeDirectories(input);
    if (typeof characterId !== 'string' || !characterId.trim() || characterId.length > 256) {
        throw new TypeError('Persistent agent skills require an active character ID; global skill storage is disabled.');
    }
    const normalizedCharacterId = characterId.trim();
    const partition = createHash('sha256').update(normalizedCharacterId, 'utf8').digest('hex');
    const databasePath = path.join(root, 'sillyagent', 'skills', partition + '.sqlite');
    if (!skillStores.has(databasePath)) {
        const opening = SkillStore.open(databasePath);
        skillStores.set(databasePath, opening);
        opening.catch(() => skillStores.delete(databasePath));
    }
    return await skillStores.get(databasePath);
}

/**
 * Get the durable roleplay state store for a SillyTavern data root.
 * State partitions are keyed by validated character/chat identifiers, never by
 * caller-supplied filesystem paths.
 * @param {string|object} input User data directory or directory object.
 * @returns {Promise<RoleplayStateStore>} Persistent roleplay state store.
 */
export async function getAgentRoleplayStateStore(input) {
    const { root } = normalizeDirectories(input);
    const databasePath = path.join(root, 'sillyagent', 'roleplay-state.sqlite');
    if (!roleplayStateStores.has(databasePath)) {
        const opening = RoleplayStateStore.open(databasePath);
        roleplayStateStores.set(databasePath, opening);
        opening.catch(() => roleplayStateStores.delete(databasePath));
    }
    return await roleplayStateStores.get(databasePath);
}

/**
 * Initialize the default data root's native agent worker when the server boots.
 * Other configured user roots are initialized lazily through authenticated APIs.
 * @param {string} root Default data root.
 * @returns {Promise<import('./memory-store.js').MemoryStore>} Initialized default memory store.
 */
export async function initializeAgentRuntime(root) {
    return await getAgentMemoryStore(root);
}
