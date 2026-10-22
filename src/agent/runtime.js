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
    const databasePath = path.join(root, 'sillyagent', 'memory.sqlite');
    if (!memoryStores.has(databasePath) && !existsSync(databasePath)) {
        return { found: false, clearedTurns: 0, deletedMemories: 0, deletedProposals: 0, cancelledJobs: 0 };
    }
    const store = await getAgentMemoryStore({ ...directories, root }, { startWorker: false });
    return { found: true, ...store.deleteChatPartition(scopeId) };
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
