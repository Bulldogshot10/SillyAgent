import path from 'node:path';

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
            getSkillStore: () => getAgentSkillStore(directories),
        });
        workerHandles.set(databasePath, starting);
    }
    return store;
}

export async function getAgentSkillStore(input) {
    const { root } = normalizeDirectories(input);
    const databasePath = path.join(root, 'sillyagent', 'skills.sqlite');
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
