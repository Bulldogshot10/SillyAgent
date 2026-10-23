import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { promises as fsPromises } from 'node:fs';

const STATE_TYPES = new Set(['world', 'character', 'scene']);
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const MAX_STATE_BYTES = 24 * 1024;
const MAX_PATCH_BYTES = 12 * 1024;
const MAX_STATE_KEYS = 32;
const MAX_HISTORY_LIMIT = 100;
const STATE_KEY_PATTERN = /^[a-z][a-zA-Z0-9_.-]{0,63}$/u;
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const CREDENTIAL_PATTERN = /(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|Bearer\s+[A-Za-z0-9._~+/-]{20,})/u;

function isPlainObject(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function validateStateType(stateType) {
    if (!STATE_TYPES.has(stateType)) {
        throw new TypeError('State type must be world, character, or scene.');
    }
    return stateType;
}

function validateScopeId(scopeId) {
    if (typeof scopeId !== 'string' || !scopeId.trim() || scopeId.length > 256) {
        throw new TypeError('A valid character or chat scope is required.');
    }
    return scopeId.trim();
}

function validateStateKey(key) {
    if (typeof key !== 'string' || !STATE_KEY_PATTERN.test(key) || FORBIDDEN_KEYS.has(key)) {
        throw new TypeError('State keys must start with a letter and contain only letters, numbers, dots, underscores, or hyphens.');
    }
    return key;
}

function validateJsonValue(value, depth = 0) {
    if (depth > 5) throw new TypeError('State values cannot be nested more than five levels.');
    if (value === null || typeof value === 'boolean') return;
    if (typeof value === 'string') {
        if (value.length > 4000) throw new TypeError('State strings must be 4000 characters or smaller.');
        if (CREDENTIAL_PATTERN.test(value)) throw new TypeError('State values must not contain credential-like secrets.');
        return;
    }
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) throw new TypeError('State numbers must be finite.');
        return;
    }
    if (Array.isArray(value)) {
        if (value.length > 50) throw new TypeError('State arrays may contain at most 50 items.');
        for (const entry of value) validateJsonValue(entry, depth + 1);
        return;
    }
    if (isPlainObject(value)) {
        const entries = Object.entries(value);
        if (entries.length > MAX_STATE_KEYS) throw new TypeError('Nested state objects may contain at most 32 keys.');
        for (const [key, entry] of entries) {
            if (FORBIDDEN_KEYS.has(key)) throw new TypeError('State values contain a forbidden object key.');
            validateJsonValue(entry, depth + 1);
        }
        return;
    }
    throw new TypeError('State values must be JSON-compatible.');
}

function parseState(value) {
    try {
        const parsed = JSON.parse(value || '{}');
        return isPlainObject(parsed) ? parsed : {};
    } catch {
        return {};
    }
}

function mergePatch(target, patch) {
    const result = { ...target };
    for (const [key, value] of Object.entries(patch)) {
        if (value === null) {
            delete result[key];
        } else if (isPlainObject(value) && isPlainObject(result[key])) {
            result[key] = mergePatch(result[key], value);
        } else {
            result[key] = value;
        }
    }
    return result;
}

async function secureStateStorage(databasePath) {
    const resolvedPath = path.resolve(databasePath);
    const directoryPath = path.dirname(resolvedPath);
    await fsPromises.mkdir(directoryPath, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });

    if (process.platform === 'win32') return;

    const directoryInfo = await fsPromises.lstat(directoryPath);
    if (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory()) {
        throw new Error('Roleplay state storage must use a real directory, not a symbolic link.');
    }
    await fsPromises.chmod(directoryPath, PRIVATE_DIRECTORY_MODE);

    for (const filePath of [resolvedPath, resolvedPath + '-wal', resolvedPath + '-shm']) {
        let fileInfo;
        try {
            fileInfo = await fsPromises.lstat(filePath);
        } catch (error) {
            if (error?.code === 'ENOENT') continue;
            throw error;
        }
        if (fileInfo.isSymbolicLink()) throw new Error('Roleplay state database files must not be symbolic links.');
        await fsPromises.chmod(filePath, PRIVATE_FILE_MODE);
    }
}

function normalizePatch(patch) {
    if (!isPlainObject(patch)) throw new TypeError('State patch must be a JSON object.');
    const entries = Object.entries(patch);
    if (!entries.length || entries.length > MAX_STATE_KEYS) {
        throw new TypeError('State patches must contain between 1 and 32 top-level keys.');
    }
    const normalized = {};
    for (const [rawKey, value] of entries) {
        const key = validateStateKey(rawKey);
        if (key === 'version' || key === 'updatedAt') {
            throw new TypeError('Version and update timestamps are managed by the harness.');
        }
        if (value !== null) validateJsonValue(value);
        normalized[key] = value;
    }
    if (Buffer.byteLength(JSON.stringify(normalized), 'utf8') > MAX_PATCH_BYTES) {
        throw new TypeError('State patches must be 12 KiB or smaller.');
    }
    return normalized;
}

export class RoleplayStateStore {
    #db;

    constructor(database) {
        this.#db = database;
        this.#initialize();
    }

    static async open(databasePath) {
        if (typeof databasePath !== 'string' || !databasePath) {
            throw new TypeError('A roleplay state database path is required.');
        }
        if (databasePath !== ':memory:') await secureStateStorage(databasePath);

        let DatabaseSync;
        try {
            ({ DatabaseSync } = await import('node:sqlite'));
        } catch (error) {
            throw new Error('Persistent roleplay state requires Node.js 22.5+ with the built-in node:sqlite module.', { cause: error });
        }

        const database = new DatabaseSync(databasePath);
        try {
            const store = new RoleplayStateStore(database);
            if (databasePath !== ':memory:') await secureStateStorage(databasePath);
            return store;
        } catch (error) {
            database.close();
            throw new Error('Could not initialize the roleplay state database. Check SQLite support and database permissions.', { cause: error });
        }
    }

    #checkpointAfterPurge() {
        try {
            const result = this.#db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
            if (result?.busy) {
                console.warn('[SillyAgent storage] SQLite roleplay WAL checkpoint remains busy after a privacy purge.');
            }
        } catch (error) {
            console.warn('[SillyAgent storage] SQLite roleplay WAL checkpoint after privacy purge failed:', error?.message || error);
        }
    }

    #initialize() {
        this.#db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 2500; PRAGMA secure_delete = ON; PRAGMA trusted_schema = OFF;');
        this.#db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
        this.#db.exec(
            'CREATE TABLE IF NOT EXISTS roleplay_state (' +
            'state_type TEXT NOT NULL CHECK (state_type IN (\'world\',\'character\',\'scene\')), ' +
            'scope_id TEXT NOT NULL, state_json TEXT NOT NULL, version INTEGER NOT NULL CHECK (version >= 1), ' +
            'updated_at INTEGER NOT NULL, PRIMARY KEY(state_type, scope_id));',
        );
        this.#db.exec(
            'CREATE TABLE IF NOT EXISTS roleplay_state_events (' +
            'id TEXT PRIMARY KEY, state_type TEXT NOT NULL, scope_id TEXT NOT NULL, version INTEGER NOT NULL, ' +
            'event_type TEXT NOT NULL, patch_json TEXT NOT NULL, source TEXT NOT NULL, created_at INTEGER NOT NULL);',
        );
        this.#db.exec('CREATE INDEX IF NOT EXISTS roleplay_state_events_scope ON roleplay_state_events(state_type, scope_id, created_at DESC);');
        this.#db.exec(
            'CREATE TABLE IF NOT EXISTS roleplay_deleted_chat_partitions (' +
            'scope_id TEXT PRIMARY KEY, deleted_at INTEGER NOT NULL);',
        );
        this.#db.exec(
            'CREATE TABLE IF NOT EXISTS roleplay_deleted_character_partitions (' +
            'scope_id TEXT PRIMARY KEY, deleted_at INTEGER NOT NULL);',
        );
    }

    getState({ stateType, scopeId, keys } = {}) {
        validateStateType(stateType);
        const normalizedScopeId = validateScopeId(scopeId);
        const row = this.#db.prepare(
            'SELECT state_json, version, updated_at FROM roleplay_state WHERE state_type = ? AND scope_id = ?',
        ).get(stateType, normalizedScopeId);
        let state = parseState(row?.state_json);
        if (Array.isArray(keys) && keys.length) {
            const filtered = {};
            for (const key of [...new Set(keys)].slice(0, MAX_STATE_KEYS)) {
                validateStateKey(key);
                if (Object.hasOwn(state, key)) filtered[key] = state[key];
            }
            state = filtered;
        }
        return {
            stateType,
            version: row?.version ?? 0,
            updatedAt: row?.updated_at ?? null,
            state,
        };
    }

    updateState({ stateType, scopeId, patch, expectedVersion, source = 'tool' } = {}) {
        validateStateType(stateType);
        const normalizedScopeId = validateScopeId(scopeId);
        const normalizedPatch = normalizePatch(patch);
        if (!Number.isInteger(expectedVersion) || expectedVersion < 0) {
            throw new TypeError('expectedVersion is required and must be a non-negative integer.');
        }
        if (typeof source !== 'string' || !source.trim() || source.length > 80) {
            throw new TypeError('State change source must contain 1-80 characters.');
        }

        this.#db.exec('BEGIN IMMEDIATE');
        try {
            const deletedPartition = stateType === 'character'
                ? this.#db.prepare('SELECT 1 FROM roleplay_deleted_character_partitions WHERE scope_id = ? LIMIT 1').get(normalizedScopeId)
                : this.#db.prepare('SELECT 1 FROM roleplay_deleted_chat_partitions WHERE scope_id = ? LIMIT 1').get(normalizedScopeId);
            if (deletedPartition) {
                const owner = stateType === 'character' ? 'character' : 'chat';
                const conflict = new Error('This ' + owner + ' was deleted; its roleplay state cannot be modified.');
                conflict.code = 'state_conflict';
                conflict.currentVersion = 0;
                throw conflict;
            }
            const previous = this.#db.prepare(
                'SELECT state_json, version FROM roleplay_state WHERE state_type = ? AND scope_id = ?',
            ).get(stateType, normalizedScopeId);
            const currentVersion = previous?.version ?? 0;
            if (expectedVersion !== undefined && expectedVersion !== currentVersion) {
                const conflict = new Error('State changed since it was read. Fetch the latest state and retry with its current version.');
                conflict.code = 'state_conflict';
                conflict.currentVersion = currentVersion;
                throw conflict;
            }

            const currentState = parseState(previous?.state_json);
            const nextState = mergePatch(currentState, normalizedPatch);
            const serialized = JSON.stringify(nextState);
            if (Buffer.byteLength(serialized, 'utf8') > MAX_STATE_BYTES) {
                throw new TypeError('A state partition may contain at most 24 KiB of JSON data.');
            }

            const nextVersion = currentVersion + 1;
            const now = Date.now();
            this.#db.prepare(
                'INSERT INTO roleplay_state (state_type, scope_id, state_json, version, updated_at) VALUES (?, ?, ?, ?, ?) ' +
                'ON CONFLICT(state_type, scope_id) DO UPDATE SET state_json = excluded.state_json, version = excluded.version, updated_at = excluded.updated_at',
            ).run(stateType, normalizedScopeId, serialized, nextVersion, now);
            this.#db.prepare(
                'INSERT INTO roleplay_state_events (id, state_type, scope_id, version, event_type, patch_json, source, created_at) ' +
                'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            ).run(randomUUID(), stateType, normalizedScopeId, nextVersion, stateType + '.updated', JSON.stringify(normalizedPatch), source.trim(), now);
            this.#db.exec('COMMIT');
            return this.getState({ stateType, scopeId: normalizedScopeId });
        } catch (error) {
            try {
                this.#db.exec('ROLLBACK');
            } catch {
                // A failed BEGIN/COMMIT may already have closed the transaction.
            }
            throw error;
        }
    }

    advanceScene({ scopeId, summary, location, time, participants, openThreads, resolvedThreads, expectedVersion } = {}) {
        if (typeof summary !== 'string' || !summary.trim() || summary.length > 3000) {
            throw new TypeError('A scene summary of 1-3000 characters is required.');
        }
        const current = this.getState({ stateType: 'scene', scopeId });
        const nextOpenThreads = Array.isArray(openThreads)
            ? openThreads
            : (Array.isArray(current.state.openThreads) ? current.state.openThreads : [])
                .filter(thread => !Array.isArray(resolvedThreads) || !resolvedThreads.includes(thread));
        const patch = {
            sceneNumber: Math.max(0, Number.isInteger(current.state.sceneNumber) ? current.state.sceneNumber : 0) + 1,
            summary: summary.trim(),
            advancedAt: new Date().toISOString(),
            openThreads: nextOpenThreads,
        };
        if (typeof location === 'string' && location.trim()) patch.location = location.trim();
        if (typeof time === 'string' && time.trim()) patch.time = time.trim();
        if (Array.isArray(participants)) patch.participants = participants;
        // This field describes the latest transition, not cumulative history.
        // Clear it on a later advance when no threads were explicitly resolved.
        patch.lastResolvedThreads = Array.isArray(resolvedThreads) ? resolvedThreads : [];

        return this.updateState({
            stateType: 'scene',
            scopeId,
            patch,
            expectedVersion: expectedVersion ?? current.version,
            source: 'scene.advance',
        });
    }

    /**
     * Remove per-chat scene state and chat-scoped fallback world state when a chat is deleted.
     * Shared-world state and character-scoped state remain independent partitions.
     * @param {string} scopeId Deleted chat identifier.
     * @returns {{deletedStates: number, deletedEvents: number}}
     */
    deleteChatPartition(scopeId) {
        const normalizedScopeId = validateScopeId(scopeId);
        this.#db.exec('BEGIN IMMEDIATE;');
        try {
            this.#db.prepare(
                'INSERT INTO roleplay_deleted_chat_partitions(scope_id, deleted_at) VALUES (?, ?) ' +
                'ON CONFLICT(scope_id) DO UPDATE SET deleted_at = excluded.deleted_at',
            ).run(normalizedScopeId, Date.now());
            const deletedStates = this.#db.prepare(
                'SELECT COUNT(*) AS count FROM roleplay_state WHERE state_type IN (?, ?) AND scope_id = ?',
            ).get('scene', 'world', normalizedScopeId).count;
            const deletedEvents = this.#db.prepare(
                'SELECT COUNT(*) AS count FROM roleplay_state_events WHERE state_type IN (?, ?) AND scope_id = ?',
            ).get('scene', 'world', normalizedScopeId).count;
            this.#db.prepare(
                'DELETE FROM roleplay_state_events WHERE state_type IN (?, ?) AND scope_id = ?',
            ).run('scene', 'world', normalizedScopeId);
            this.#db.prepare(
                'DELETE FROM roleplay_state WHERE state_type IN (?, ?) AND scope_id = ?',
            ).run('scene', 'world', normalizedScopeId);
            this.#db.exec('COMMIT;');
            this.#checkpointAfterPurge();
            return { deletedStates, deletedEvents };
        } catch (error) {
            this.#db.exec('ROLLBACK;');
            throw error;
        }
    }

    /**
     * Allow writes to a chat partition only after the core reports that the chat is open again.
     * @param {string} scopeId Chat identifier.
     * @returns {{activated: boolean}} Whether a deletion tombstone was removed.
     */
    activateChatPartition(scopeId) {
        const normalizedScopeId = validateScopeId(scopeId);
        this.#db.exec('BEGIN IMMEDIATE;');
        try {
            const result = this.#db.prepare(
                'DELETE FROM roleplay_deleted_chat_partitions WHERE scope_id = ?',
            ).run(normalizedScopeId);
            this.#db.exec('COMMIT;');
            return { activated: result.changes > 0 };
        } catch (error) {
            this.#db.exec('ROLLBACK;');
            throw error;
        }
    }

    /**
     * Remove persistent state owned by a deleted character while preserving shared worlds and chats.
     * @param {string} characterId Deleted character identifier.
     * @returns {{deletedStates: number, deletedEvents: number}}
     */
    deleteCharacterPartition(characterId) {
        const normalizedCharacterId = validateScopeId(characterId);
        this.#db.exec('BEGIN IMMEDIATE;');
        try {
            this.#db.prepare(
                'INSERT INTO roleplay_deleted_character_partitions(scope_id, deleted_at) VALUES (?, ?) ' +
                'ON CONFLICT(scope_id) DO UPDATE SET deleted_at = excluded.deleted_at',
            ).run(normalizedCharacterId, Date.now());
            const deletedStates = this.#db.prepare(
                'SELECT COUNT(*) AS count FROM roleplay_state WHERE state_type = ? AND scope_id = ?',
            ).get('character', normalizedCharacterId).count;
            const deletedEvents = this.#db.prepare(
                'SELECT COUNT(*) AS count FROM roleplay_state_events WHERE state_type = ? AND scope_id = ?',
            ).get('character', normalizedCharacterId).count;
            this.#db.prepare(
                'DELETE FROM roleplay_state_events WHERE state_type = ? AND scope_id = ?',
            ).run('character', normalizedCharacterId);
            this.#db.prepare(
                'DELETE FROM roleplay_state WHERE state_type = ? AND scope_id = ?',
            ).run('character', normalizedCharacterId);
            this.#db.exec('COMMIT;');
            this.#checkpointAfterPurge();
            return { deletedStates, deletedEvents };
        } catch (error) {
            this.#db.exec('ROLLBACK;');
            throw error;
        }
    }

    /**
     * Allow writes to a character partition only after the core confirms that its character exists.
     * @param {string} characterId Character identifier.
     * @returns {{activated: boolean}} Whether a deletion tombstone was removed.
     */
    activateCharacterPartition(characterId) {
        const normalizedCharacterId = validateScopeId(characterId);
        this.#db.exec('BEGIN IMMEDIATE;');
        try {
            const result = this.#db.prepare(
                'DELETE FROM roleplay_deleted_character_partitions WHERE scope_id = ?',
            ).run(normalizedCharacterId);
            this.#db.exec('COMMIT;');
            return { activated: result.changes > 0 };
        } catch (error) {
            this.#db.exec('ROLLBACK;');
            throw error;
        }
    }

    getHistory({ stateType, scopeId, limit = 20 } = {}) {
        validateStateType(stateType);
        const normalizedScopeId = validateScopeId(scopeId);
        const safeLimit = Math.max(1, Math.min(MAX_HISTORY_LIMIT, Number.isInteger(limit) ? limit : 20));
        return this.#db.prepare(
            'SELECT version, event_type, patch_json, source, created_at FROM roleplay_state_events ' +
            'WHERE state_type = ? AND scope_id = ? ORDER BY version DESC LIMIT ?',
        ).all(stateType, normalizedScopeId, safeLimit).map(row => ({
            version: row.version,
            eventType: row.event_type,
            patch: parseState(row.patch_json),
            source: row.source,
            createdAt: row.created_at,
        }));
    }

    close() {
        this.#db.close();
    }
}
