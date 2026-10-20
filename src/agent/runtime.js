import path from 'node:path';
import { createHash } from 'node:crypto';

import { MemoryStore } from './memory-store.js';
import { SkillStore } from './skill-store.js';
import { startReflectionWorker } from './reflection-worker.js';

const memoryStores = new Map();
const skillStores = new Map();
const workerHandles = new Map();

function normalizeDirectories(input) {
    const directories = typeof input === 'string' ? { root: input } : input;
    if (!directories || typeof directories.root !== 'string' || !directories.root.trim()) {
        throw new TypeError('A user data directory is required for the SillyAgent runtime.');
    }
    return { directories, root: path.resolve(directories.root) };
}

export async function getAgentMemoryStore(input) {
    const { directories, root } = normalizeDirectories(input);
    const databasePath = path.join(root, 'sillyagent', 'memory.sqlite');
    if (!memoryStores.has(databasePath)) {
        const opening = MemoryStore.open(databasePath);
        memoryStores.set(databasePath, opening);
        opening.catch(() => memoryStores.delete(databasePath));
    }
    const store = await memoryStores.get(databasePath);
    if (!workerHandles.has(databasePath)) {
        const starting = startReflectionWorker({
            store,
            directories: { ...directories, root },
            getSkillStore: characterId => getAgentSkillStore(directories, characterId),
        });
        workerHandles.set(databasePath, starting);
    }
    return store;
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
 * Initialize the default data root's native agent worker when the server boots.
 * Other configured user roots are initialized lazily through authenticated APIs.
 * @param {string} root Default data root.
 * @returns {Promise<import('./memory-store.js').MemoryStore>} Initialized default memory store.
 */
export async function initializeAgentRuntime(root) {
    return await getAgentMemoryStore(root);
}
