import path from 'node:path';
import { promises as fsPromises } from 'node:fs';
import { randomUUID } from 'node:crypto';

const SCOPES = new Set(['user', 'character', 'chat']);
const KINDS = new Set(['fact', 'preference', 'event', 'relationship', 'goal', 'world_state']);
const STATUSES = new Set(['pending', 'approved', 'rejected']);
const MAX_CONTENT = 4000;
const MAX_EVENT_CONTENT = 12000;
const MAX_METADATA_BYTES = 8192;

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

/**
 * Enforce private permissions for persistent memory storage on POSIX systems.
 * Database symlinks are rejected so a local path cannot silently redirect memory
 * storage to an unrelated file.
 * @param {string} databasePath SQLite database path.
 * @returns {Promise<void>}
 */
async function secureMemoryStorage(databasePath) {
    const resolvedDatabasePath = path.resolve(databasePath);
    const directoryPath = path.dirname(resolvedDatabasePath);
    await fsPromises.mkdir(directoryPath, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });

    if (process.platform === 'win32') return;

    const directoryInfo = await fsPromises.lstat(directoryPath);
    if (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory()) {
        throw new Error('Persistent memory storage directory must be a real directory, not a symbolic link.');
    }
    await fsPromises.chmod(directoryPath, PRIVATE_DIRECTORY_MODE);

    for (const filePath of [resolvedDatabasePath, resolvedDatabasePath + '-wal', resolvedDatabasePath + '-shm']) {
        let fileInfo;
        try {
            fileInfo = await fsPromises.lstat(filePath);
        } catch (error) {
            if (error?.code === 'ENOENT') continue;
            throw error;
        }
        if (fileInfo.isSymbolicLink()) {
            throw new Error('Persistent memory storage files must not be symbolic links.');
        }
        await fsPromises.chmod(filePath, PRIVATE_FILE_MODE);
    }
}

function normalizeScope(scope, scopeId) {
    if (!SCOPES.has(scope)) throw new TypeError('Memory scope must be user, character, or chat.');
    if (scope === 'user') return { scope, scopeId: '' };
    if (typeof scopeId !== 'string' || !scopeId.trim() || scopeId.length > 256) {
        throw new TypeError('Character and chat memories require a valid scope ID.');
    }
    return { scope, scopeId: scopeId.trim() };
}

function normalizeText(value, maximum, name) {
    if (typeof value !== 'string') throw new TypeError(name + ' must be a string.');
    const text = value.trim();
    if (!text || text.length > maximum) {
        throw new TypeError(name + ' must contain between 1 and ' + maximum + ' characters.');
    }
    return text;
}

function serializeMetadata(metadata) {
    if (metadata === undefined || metadata === null) return '{}';
    if (typeof metadata !== 'object' || Array.isArray(metadata)) throw new TypeError('Memory metadata must be an object.');
    const serialized = JSON.stringify(metadata);
    if (typeof serialized !== 'string' || Buffer.byteLength(serialized, 'utf8') > MAX_METADATA_BYTES) {
        throw new TypeError('Memory metadata exceeds the allowed size.');
    }
    return serialized;
}

function parseMetadata(value) {
    try {
        return JSON.parse(value || '{}');
    } catch {
        return {};
    }
}

function toEvent(row) {
    return row ? {
        id: row.id,
        scope: row.scope,
        scopeId: row.scope_id,
        eventType: row.event_type,
        content: row.content,
        metadata: parseMetadata(row.metadata_json),
        createdAt: row.created_at,
    } : null;
}

function toMemory(row) {
    return row ? {
        id: row.id,
        scope: row.scope,
        scopeId: row.scope_id,
        kind: row.kind,
        content: row.content,
        importance: row.importance,
        sourceEventId: row.source_event_id,
        metadata: parseMetadata(row.metadata_json),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    } : null;
}

function toProposal(row) {
    return row ? {
        id: row.id,
        scope: row.scope,
        scopeId: row.scope_id,
        kind: row.kind,
        content: row.content,
        importance: row.importance,
        sourceEventId: row.source_event_id,
        status: row.status,
        metadata: parseMetadata(row.metadata_json),
        createdAt: row.created_at,
        reviewedAt: row.reviewed_at,
    } : null;
}

function getSearchTokens(query) {
    return [...new Set((query.match(/[\p{L}\p{N}]+/gu) ?? []).map(token => token.toLowerCase()))].slice(0, 16);
}

function buildMatchExpression(tokens) {
    return tokens.map(token => '"' + token.replaceAll('"', '""') + '"').join(' OR ');
}

const CJK_PATTERN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/**
 * Whether the current or supplied Node.js version provides the built-in SQLite API.
 * The main application can still run on Node.js 20; persistent memory needs 22.5+.
 * @param {string} version Node.js version such as 20.20.0 or v22.5.0.
 * @returns {boolean} Whether the runtime meets the memory feature requirement.
 */
export function supportsPersistentMemoryRuntime(version = process.versions.node) {
    const match = typeof version === 'string' ? /^v?(\d+)\.(\d+)\.(\d+)/u.exec(version) : null;
    if (!match) return false;

    const major = Number(match[1]);
    const minor = Number(match[2]);
    return major > 22 || (major === 22 && minor >= 5);
}


/**
 * Per-user persistent memory using Node's built-in SQLite and FTS5.
 * Each user should have a separate database file.
 */
export class MemoryStore {
    #db;

    constructor(database) {
        this.#db = database;
        this.#initialize();
    }

    /**
     * Open a store. Requires Node.js with node:sqlite and SQLite FTS5.
     * @param {string} databasePath File path, or :memory: for tests.
     * @returns {Promise<MemoryStore>} Open store.
     */
    static async open(databasePath) {
        if (typeof databasePath !== 'string' || !databasePath) throw new TypeError('A memory database path is required.');
        if (!supportsPersistentMemoryRuntime()) {
            throw new Error(
                'Persistent memory is unavailable on Node.js ' + process.versions.node
                + '. This feature requires Node.js 22.5+ with the built-in node:sqlite module; the rest of SillyTavern can still run.',
            );
        }
        if (databasePath !== ':memory:') {
            await secureMemoryStorage(databasePath);
        }

        let DatabaseSync;
        try {
            ({ DatabaseSync } = await import('node:sqlite'));
        } catch (error) {
            throw new Error('Persistent memory requires Node.js 22.5+ with the built-in node:sqlite module.', { cause: error });
        }

        const database = new DatabaseSync(databasePath);
        try {
            const store = new MemoryStore(database);
            if (databasePath !== ':memory:') {
                await secureMemoryStorage(databasePath);
            }
            return store;
        } catch (error) {
            database.close();
            throw new Error('Could not initialize the memory database. Check SQLite FTS5 support and database permissions.', { cause: error });
        }
    }

    #initialize() {
        this.#db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 2500; PRAGMA secure_delete = ON; PRAGMA trusted_schema = OFF;');
        this.#db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
        this.#db.exec(
            'CREATE TABLE IF NOT EXISTS memory_events (' +
            'id TEXT PRIMARY KEY, scope TEXT NOT NULL CHECK (scope IN (\'user\',\'character\',\'chat\')), ' +
            'scope_id TEXT NOT NULL DEFAULT \'\', event_type TEXT NOT NULL, content TEXT NOT NULL, ' +
            'metadata_json TEXT NOT NULL DEFAULT \'{}\', created_at INTEGER NOT NULL);',
        );
        this.#db.exec('CREATE INDEX IF NOT EXISTS memory_events_scope_created ON memory_events(scope, scope_id, created_at DESC);');
        this.#db.exec(
            'CREATE TABLE IF NOT EXISTS memory_proposals (' +
            'id TEXT PRIMARY KEY, scope TEXT NOT NULL CHECK (scope IN (\'user\',\'character\',\'chat\')), ' +
            'scope_id TEXT NOT NULL DEFAULT \'\', kind TEXT NOT NULL, content TEXT NOT NULL, ' +
            'importance INTEGER NOT NULL CHECK (importance BETWEEN 1 AND 5), source_event_id TEXT, ' +
            'status TEXT NOT NULL DEFAULT \'pending\' CHECK (status IN (\'pending\',\'approved\',\'rejected\')), ' +
            'metadata_json TEXT NOT NULL DEFAULT \'{}\', created_at INTEGER NOT NULL, reviewed_at INTEGER);',
        );
        this.#db.exec('CREATE INDEX IF NOT EXISTS memory_proposals_status_created ON memory_proposals(status, created_at DESC);');
        this.#db.exec(
            'CREATE TABLE IF NOT EXISTS memories (' +
            'id TEXT PRIMARY KEY, scope TEXT NOT NULL CHECK (scope IN (\'user\',\'character\',\'chat\')), ' +
            'scope_id TEXT NOT NULL DEFAULT \'\', kind TEXT NOT NULL, content TEXT NOT NULL, ' +
            'importance INTEGER NOT NULL CHECK (importance BETWEEN 1 AND 5), source_event_id TEXT, ' +
            'metadata_json TEXT NOT NULL DEFAULT \'{}\', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, ' +
            'UNIQUE(scope, scope_id, kind, content));',
        );
        this.#db.exec('CREATE INDEX IF NOT EXISTS memories_scope_updated ON memories(scope, scope_id, updated_at DESC);');
        this.#db.exec('CREATE TABLE IF NOT EXISTS memory_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);');
        this.#db.exec(
            'CREATE TABLE IF NOT EXISTS memory_capture_keys (' +
            'capture_key TEXT PRIMARY KEY, event_id TEXT NOT NULL, created_at INTEGER NOT NULL);',
        );
        this.#db.exec(
            'CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(' +
            'memory_id UNINDEXED, scope UNINDEXED, scope_id UNINDEXED, content, ' +
            'tokenize = \'unicode61 remove_diacritics 2\');',
        );
        this.#db.exec(
            'CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts_trigram USING fts5(' +
            'memory_id UNINDEXED, scope UNINDEXED, scope_id UNINDEXED, content, ' +
            'tokenize = \'trigram\');',
        );
        this.#db.exec(
            'INSERT INTO memory_fts_trigram(memory_id, scope, scope_id, content) ' +
            'SELECT m.id, m.scope, m.scope_id, m.content FROM memories m ' +
            'WHERE NOT EXISTS (SELECT 1 FROM memory_fts_trigram f WHERE f.memory_id = m.id);',
        );
    }

    /**
     * Record a durable event for consolidation and auditing.
     * @param {object} input Event fields.
     * @returns {object} Stored event.
     */
    recordEvent({ scope, scopeId, eventType, content, metadata, createdAt = Date.now() }) {
        const target = normalizeScope(scope, scopeId);
        const text = normalizeText(content, MAX_EVENT_CONTENT, 'Event content');
        if (typeof eventType !== 'string' || !/^[a-z][a-z0-9_.-]{0,63}$/.test(eventType)) {
            throw new TypeError('Event type must be a short lowercase identifier.');
        }
        if (!Number.isSafeInteger(createdAt) || createdAt < 0) throw new TypeError('Event timestamp must be a non-negative integer.');

        const id = randomUUID();
        this.#db.prepare(
            'INSERT INTO memory_events (id, scope, scope_id, event_type, content, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        ).run(id, target.scope, target.scopeId, eventType, text, serializeMetadata(metadata), createdAt);
        return toEvent(this.#db.prepare('SELECT * FROM memory_events WHERE id = ?').get(id));
    }

    #storeAcceptedMemory(proposalRow, updatedAt = Date.now()) {
        const existing = this.#db.prepare(
            'SELECT id FROM memories WHERE scope = ? AND scope_id = ? AND kind = ? AND content = ?',
        ).get(proposalRow.scope, proposalRow.scope_id, proposalRow.kind, proposalRow.content);
        const memoryId = existing?.id ?? randomUUID();
        this.#db.prepare(
            'INSERT INTO memories (id, scope, scope_id, kind, content, importance, source_event_id, metadata_json, created_at, updated_at) ' +
            'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
            'ON CONFLICT(scope, scope_id, kind, content) DO UPDATE SET ' +
            'importance = MAX(memories.importance, excluded.importance), updated_at = excluded.updated_at',
        ).run(
            memoryId, proposalRow.scope, proposalRow.scope_id, proposalRow.kind, proposalRow.content,
            proposalRow.importance, proposalRow.source_event_id, proposalRow.metadata_json,
            proposalRow.created_at, updatedAt,
        );
        const memoryRow = this.#db.prepare(
            'SELECT * FROM memories WHERE scope = ? AND scope_id = ? AND kind = ? AND content = ?',
        ).get(proposalRow.scope, proposalRow.scope_id, proposalRow.kind, proposalRow.content);
        this.#db.prepare('DELETE FROM memory_fts WHERE memory_id = ?').run(memoryRow.id);
        this.#db.prepare(
            'INSERT INTO memory_fts(memory_id, scope, scope_id, content) VALUES (?, ?, ?, ?)',
        ).run(memoryRow.id, memoryRow.scope, memoryRow.scope_id, memoryRow.content);
        this.#db.prepare('DELETE FROM memory_fts_trigram WHERE memory_id = ?').run(memoryRow.id);
        this.#db.prepare(
            'INSERT INTO memory_fts_trigram(memory_id, scope, scope_id, content) VALUES (?, ?, ?, ?)',
        ).run(memoryRow.id, memoryRow.scope, memoryRow.scope_id, memoryRow.content);
        return toMemory(memoryRow);
    }

    /**
     * Persist a memory candidate. Default mode accepts it immediately; review mode stages it as pending.
     * @param {object} input Candidate fields.
     * @returns {object} Stored proposal.
     */
    proposeMemory({
        scope,
        scopeId,
        kind = 'fact',
        content,
        importance = 3,
        metadata,
        createdAt = Date.now(),
        requireApproval,
    }) {
        const target = normalizeScope(scope, scopeId);
        const text = normalizeText(content, MAX_CONTENT, 'Memory content');
        if (!KINDS.has(kind)) throw new TypeError('Unsupported memory kind.');
        if (!Number.isInteger(importance) || importance < 1 || importance > 5) {
            throw new TypeError('Memory importance must be an integer from 1 through 5.');
        }
        if (!Number.isSafeInteger(createdAt) || createdAt < 0) throw new TypeError('Memory timestamp must be a non-negative integer.');
        const metadataJson = serializeMetadata(metadata);
        const approvalRequired = requireApproval === undefined ? this.getSettings().requireApproval : requireApproval;
        if (typeof approvalRequired !== 'boolean') throw new TypeError('requireApproval must be a boolean.');

        this.#db.exec('BEGIN IMMEDIATE;');
        try {
            const duplicate = this.#db.prepare(
                'SELECT * FROM memory_proposals WHERE status = \'pending\' AND scope = ? AND scope_id = ? AND kind = ? AND content = ? ORDER BY created_at DESC LIMIT 1',
            ).get(target.scope, target.scopeId, kind, text);
            if (duplicate) {
                let memory = null;
                let proposalRow = duplicate;
                if (!approvalRequired) {
                    const reviewedAt = Date.now();
                    memory = this.#storeAcceptedMemory(duplicate, reviewedAt);
                    this.#db.prepare('UPDATE memory_proposals SET status = \'approved\', reviewed_at = ? WHERE id = ?')
                        .run(reviewedAt, duplicate.id);
                    proposalRow = this.#db.prepare('SELECT * FROM memory_proposals WHERE id = ?').get(duplicate.id);
                }
                this.#db.exec('COMMIT;');
                return {
                    ...toProposal(proposalRow),
                    memory,
                    requiresReview: approvalRequired,
                    duplicate: true,
                };
            }

            const acceptedProposal = this.#db.prepare(
                'SELECT * FROM memory_proposals WHERE status = \'approved\' AND scope = ? AND scope_id = ? AND kind = ? AND content = ? ORDER BY created_at DESC LIMIT 1',
            ).get(target.scope, target.scopeId, kind, text);
            if (acceptedProposal) {
                const memoryRow = this.#db.prepare(
                    'SELECT * FROM memories WHERE scope = ? AND scope_id = ? AND kind = ? AND content = ?',
                ).get(target.scope, target.scopeId, kind, text);
                if (memoryRow) {
                    this.#db.exec('COMMIT;');
                    return {
                        ...toProposal(acceptedProposal),
                        memory: toMemory(memoryRow),
                        requiresReview: false,
                        duplicate: true,
                    };
                }
            }

            const proposalStatus = approvalRequired ? 'pending' : 'approved';
            const reviewedAt = approvalRequired ? null : createdAt;
            const event = this.recordEvent({
                scope: target.scope,
                scopeId: target.scopeId,
                eventType: 'memory.proposal_created',
                content: text,
                metadata: { kind, importance, status: proposalStatus, autoApproved: !approvalRequired },
                createdAt,
            });
            const id = randomUUID();
            this.#db.prepare(
                'INSERT INTO memory_proposals (id, scope, scope_id, kind, content, importance, source_event_id, status, metadata_json, created_at, reviewed_at) ' +
                'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            ).run(
                id, target.scope, target.scopeId, kind, text, importance, event.id, proposalStatus,
                metadataJson, createdAt, reviewedAt,
            );
            const proposalRow = this.#db.prepare('SELECT * FROM memory_proposals WHERE id = ?').get(id);
            const memory = approvalRequired ? null : this.#storeAcceptedMemory(proposalRow, createdAt);
            const proposal = toProposal(proposalRow);
            this.#db.exec('COMMIT;');
            return {
                ...proposal,
                memory,
                requiresReview: approvalRequired,
                duplicate: false,
            };
        } catch (error) {
            this.#db.exec('ROLLBACK;');
            throw error;
        }
    }

    /**
     * Retrieve pending, accepted, or rejected memory records.
     * @param {object} options Query options.
     * @returns {object[]} Proposals.
     */
    listProposals({ status = 'pending', limit = 30 } = {}) {
        if (!STATUSES.has(status)) throw new TypeError('Invalid proposal status.');
        const safeLimit = Math.max(1, Math.min(100, Number.isInteger(limit) ? limit : 30));
        return this.#db.prepare(
            'SELECT * FROM memory_proposals WHERE status = ? ORDER BY created_at DESC LIMIT ?',
        ).all(status, safeLimit).map(toProposal);
    }

    /**
     * Approve or reject a pending memory proposal.
     * @param {string} proposalId Candidate ID.
     * @param {'approve'|'reject'} decision User decision.
     * @returns {object|null} Reviewed proposal and optional accepted memory.
     */
    reviewProposal(proposalId, decision) {
        if (typeof proposalId !== 'string' || !proposalId) throw new TypeError('A proposal ID is required.');
        if (!['approve', 'reject'].includes(decision)) throw new TypeError('Decision must be approve or reject.');

        this.#db.exec('BEGIN IMMEDIATE;');
        try {
            const proposalRow = this.#db.prepare(
                'SELECT * FROM memory_proposals WHERE id = ? AND status = \'pending\'',
            ).get(proposalId);
            if (!proposalRow) {
                this.#db.exec('COMMIT;');
                return null;
            }

            const reviewedAt = Date.now();
            let memory = null;
            if (decision === 'approve') {
                memory = this.#storeAcceptedMemory(proposalRow, reviewedAt);
            }

            const status = decision === 'approve' ? 'approved' : 'rejected';
            this.#db.prepare('UPDATE memory_proposals SET status = ?, reviewed_at = ? WHERE id = ?')
                .run(status, reviewedAt, proposalId);
            this.#db.exec('COMMIT;');
            return {
                proposal: toProposal(this.#db.prepare('SELECT * FROM memory_proposals WHERE id = ?').get(proposalId)),
                memory,
            };
        } catch (error) {
            this.#db.exec('ROLLBACK;');
            throw error;
        }
    }

    /**
     * Automatically accept all currently pending proposals when autonomous mode is active.
     * Called when an owner disables review, including when upgrading from the older review-only behavior.
     * @returns {number} Number of proposals accepted.
     */
    autoApprovePendingProposals() {
        let accepted = 0;
        while (true) {
            const pending = this.listProposals({ status: 'pending', limit: 100 });
            if (!pending.length) break;
            for (const proposal of pending) {
                if (this.reviewProposal(proposal.id, 'approve')) accepted++;
            }
            if (pending.length < 100) break;
        }
        return accepted;
    }

    /**
     * Search accepted memories with FTS5 and roleplay scope boundaries.
     * @param {object} options Search options.
     * @returns {object[]} Ranked memories.
     */
    searchMemories({ query, scope = 'relevant', activeChatId = null, activeCharacterId = null, limit = 5 }) {
        const text = normalizeText(query, 300, 'Search query');
        const tokens = getSearchTokens(text);
        if (!tokens.length) return [];
        const matchExpression = buildMatchExpression(tokens);
        const trigramTokens = tokens.filter(token => Array.from(token).length >= 3);
        const trigramExpression = buildMatchExpression(trigramTokens);
        const shortCjkTokens = tokens.filter(token => Array.from(token).length < 3 && CJK_PATTERN.test(token));
        if (!['relevant', 'user', 'character', 'chat'].includes(scope)) {
            throw new TypeError('Search scope must be relevant, user, character, or chat.');
        }

        const safeLimit = Math.max(1, Math.min(5, Number.isInteger(limit) ? limit : 5));
        const conditions = [];
        const scopeParams = [];

        if (scope === 'user') {
            conditions.push('m.scope = \'user\'');
        } else if (scope === 'chat') {
            if (typeof activeChatId !== 'string' || !activeChatId) return [];
            conditions.push('m.scope = \'chat\' AND m.scope_id = ?');
            scopeParams.push(activeChatId);
        } else if (scope === 'character') {
            if (typeof activeCharacterId !== 'string' || !activeCharacterId) return [];
            conditions.push('m.scope = \'character\' AND m.scope_id = ?');
            scopeParams.push(activeCharacterId);
        } else {
            conditions.push('m.scope = \'user\'');
            if (typeof activeChatId === 'string' && activeChatId) {
                conditions.push('(m.scope = \'chat\' AND m.scope_id = ?)');
                scopeParams.push(activeChatId);
            }
            if (typeof activeCharacterId === 'string' && activeCharacterId) {
                conditions.push('(m.scope = \'character\' AND m.scope_id = ?)');
                scopeParams.push(activeCharacterId);
            }
        }

        const matchQueries = [
            'SELECT memory_id, bm25(memory_fts) AS rank FROM memory_fts WHERE memory_fts MATCH ?',
        ];
        const matchParams = [matchExpression];
        if (trigramExpression) {
            matchQueries.push('SELECT memory_id, bm25(memory_fts_trigram) AS rank FROM memory_fts_trigram WHERE memory_fts_trigram MATCH ?');
            matchParams.push(trigramExpression);
        }
        if (shortCjkTokens.length) {
            matchQueries.push(
                'SELECT m.id AS memory_id, 0 AS rank FROM memories m WHERE (' +
                shortCjkTokens.map(() => 'm.content LIKE ?').join(' OR ') + ')',
            );
            matchParams.push(...shortCjkTokens.map(token => '%' + token + '%'));
        }

        // Over-fetch lexical candidates before applying the blended ranking.
        const candidateLimit = Math.min(50, safeLimit * 10);
        const sql = 'WITH matches AS (' + matchQueries.join(' UNION ALL ') + ') ' +
            'SELECT m.*, ranked.rank AS search_rank FROM memories m ' +
            'INNER JOIN (SELECT memory_id, MIN(rank) AS rank FROM matches GROUP BY memory_id) ranked ON ranked.memory_id = m.id ' +
            'WHERE (' + conditions.join(' OR ') + ') ' +
            'ORDER BY ranked.rank ASC, m.importance DESC, m.updated_at DESC LIMIT ?';
        const rows = this.#db.prepare(sql).all(...matchParams, ...scopeParams, candidateLimit);
        const normalizedQuery = text.normalize('NFKC').toLocaleLowerCase();
        const now = Date.now();
        const ranked = rows.map((row, index) => {
            const normalizedContent = row.content.normalize('NFKC').toLocaleLowerCase();
            const matchedTokens = tokens.filter(token => normalizedContent.includes(token));
            const coverage = matchedTokens.length / tokens.length;
            const exactPhrase = normalizedContent.includes(normalizedQuery);
            const bm25Score = rows.length > 1 ? 1 - (index / (rows.length - 1)) : 1;
            const ageDays = Math.max(0, (now - row.updated_at) / 86400000);
            const recencyScore = 1 / (1 + (ageDays / 30));
            const importanceScore = row.importance / 5;
            const score = Math.min(1, (exactPhrase ? 0.45 : 0)
                + (coverage * 0.30)
                + (bm25Score * 0.15)
                + (importanceScore * 0.07)
                + (recencyScore * 0.03));
            return {
                row,
                score,
                exactPhrase,
                coverage,
                matchedTokens,
                bm25Rank: row.search_rank,
            };
        }).sort((left, right) => right.score - left.score
            || Number(right.exactPhrase) - Number(left.exactPhrase)
            || right.coverage - left.coverage
            || left.bm25Rank - right.bm25Rank
            || right.row.importance - left.row.importance
            || right.row.updated_at - left.row.updated_at);

        return ranked.slice(0, safeLimit).map(item => ({
            ...toMemory(item.row),
            preview: item.row.content.length > 400 ? item.row.content.slice(0, 397) + '...' : item.row.content,
            retrievalScore: Number(item.score.toFixed(4)),
            matchedTerms: item.matchedTokens,
        }));
    }
    /**
     * Clear raw captured turns from one chat while retaining approved memories and proposals.
     * @param {string} scopeId Chat ID.
     * @returns {number} Number of raw turns removed.
     */
    clearCapturedTurns(scopeId) {
        const target = normalizeScope('chat', scopeId);
        this.#db.exec('BEGIN IMMEDIATE;');
        try {
            const count = this.#db.prepare(
                'SELECT COUNT(*) AS count FROM memory_events WHERE scope = ? AND scope_id = ? ' +
                'AND event_type IN (?, ?)',
            ).get(target.scope, target.scopeId, 'chat.user_turn', 'chat.assistant_turn').count;
            this.#db.prepare(
                'DELETE FROM memory_capture_keys WHERE event_id IN (' +
                'SELECT id FROM memory_events WHERE scope = ? AND scope_id = ? ' +
                'AND event_type IN (?, ?))',
            ).run(target.scope, target.scopeId, 'chat.user_turn', 'chat.assistant_turn');
            this.#db.prepare(
                'DELETE FROM memory_events WHERE scope = ? AND scope_id = ? ' +
                'AND event_type IN (?, ?)',
            ).run(target.scope, target.scopeId, 'chat.user_turn', 'chat.assistant_turn');
            this.recordEvent({
                scope: target.scope,
                scopeId: target.scopeId,
                eventType: 'memory.capture_history_cleared',
                content: 'Captured turn history cleared by user.',
                metadata: { deletedTurns: count },
            });
            this.#db.exec('COMMIT;');
            return count;
        } catch (error) {
            this.#db.exec('ROLLBACK;');
            throw error;
        }
    }

    getSettings() {
        const settings = {
            autoRetrieveEnabled: true,
            autoCaptureEnabled: true,
            autoDreamEnabled: true,
            requireApproval: false,
        };
        const rows = this.#db.prepare('SELECT key, value FROM memory_settings').all();
        for (const row of rows) {
            if (!Object.hasOwn(settings, row.key)) continue;
            try {
                const value = JSON.parse(row.value);
                if (typeof value === 'boolean') settings[row.key] = value;
            } catch {
                // Ignore malformed settings and keep the safe default.
            }
        }
        return settings;
    }

    /**
     * Persist a partial set of supported memory settings.
     * @param {object} patch User-selected settings.
     * @returns {object} Updated settings.
     */
    updateSettings(patch) {
        if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
            throw new TypeError('Memory settings must be an object.');
        }
        const allowed = new Set(['autoRetrieveEnabled', 'autoCaptureEnabled', 'autoDreamEnabled', 'requireApproval']);
        this.#db.exec('BEGIN IMMEDIATE;');
        try {
            for (const [key, value] of Object.entries(patch)) {
                if (!allowed.has(key)) throw new TypeError('Unsupported memory setting: ' + key);
                if (typeof value !== 'boolean') throw new TypeError('Memory setting ' + key + ' must be a boolean.');
                this.#db.prepare(
                    'INSERT INTO memory_settings(key, value) VALUES (?, ?) ' +
                    'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
                ).run(key, JSON.stringify(value));
            }
            this.#db.exec('COMMIT;');
        } catch (error) {
            this.#db.exec('ROLLBACK;');
            throw error;
        }
        return this.getSettings();
    }

    /**
     * List accepted memories from one scope or all scopes.
     * @param {object} options Scope and filtering options.
     * @returns {object[]} Accepted memories.
     */
    listMemories({ scope = 'all', scopeId = '', query = '', limit = 50 } = {}) {
        if (typeof query !== 'string' || query.length > 300) {
            throw new TypeError('Memory filter must be a string of 300 characters or fewer.');
        }
        if (!['all', 'user', 'character', 'chat'].includes(scope)) {
            throw new TypeError('Memory list scope must be all, user, character, or chat.');
        }
        const safeLimit = Math.max(1, Math.min(100, Number.isInteger(limit) ? limit : 50));
        const normalizedQuery = query.trim();
        const conditions = [];
        const params = [];

        if (scope !== 'all') {
            const target = normalizeScope(scope, scopeId);
            conditions.push('scope = ?', 'scope_id = ?');
            params.push(target.scope, target.scopeId);
        }
        if (normalizedQuery) {
            conditions.push('instr(lower(content), lower(?)) > 0');
            params.push(normalizedQuery);
        }

        const sql = 'SELECT * FROM memories'
            + (conditions.length ? ' WHERE ' + conditions.join(' AND ') : '')
            + ' ORDER BY updated_at DESC LIMIT ?';
        params.push(safeLimit);
        return this.#db.prepare(sql).all(...params).map(row => ({
            ...toMemory(row),
            preview: row.content.length > 400 ? row.content.slice(0, 397) + '...' : row.content,
        }));
    }

    /**
     * Delete one accepted memory and remove it from both full-text indexes.
     * A non-content audit event records the deletion without retaining the deleted text.
     * @param {string} memoryId Memory ID.
     * @returns {boolean} Whether a memory was deleted.
     */
    deleteMemory(memoryId) {
        if (typeof memoryId !== 'string' || !memoryId) throw new TypeError('A memory ID is required.');
        this.#db.exec('BEGIN IMMEDIATE;');
        try {
            const row = this.#db.prepare('SELECT * FROM memories WHERE id = ?').get(memoryId);
            if (!row) {
                this.#db.exec('COMMIT;');
                return false;
            }

            // Forget every copy of this content within the same scope. The same text
            // in another chat/character scope remains an independent memory.
            const relatedMemories = this.#db.prepare(
                'SELECT * FROM memories WHERE scope = ? AND scope_id = ? AND content = ?',
            ).all(row.scope, row.scope_id, row.content);
            const relatedProposals = this.#db.prepare(
                'SELECT * FROM memory_proposals WHERE scope = ? AND scope_id = ? AND content = ?',
            ).all(row.scope, row.scope_id, row.content);
            const relatedEvents = this.#db.prepare(
                'SELECT id FROM memory_events WHERE scope = ? AND scope_id = ? ' +
                'AND event_type = ? AND content = ?',
            ).all(row.scope, row.scope_id, 'memory.proposal_created', row.content);

            const sourceEventIds = new Set([
                ...relatedMemories.map(memory => memory.source_event_id),
                ...relatedProposals.map(proposal => proposal.source_event_id),
                ...relatedEvents.map(event => event.id),
            ].filter(id => typeof id === 'string' && id));

            for (const memory of relatedMemories) {
                this.#db.prepare('DELETE FROM memory_fts WHERE memory_id = ?').run(memory.id);
                this.#db.prepare('DELETE FROM memory_fts_trigram WHERE memory_id = ?').run(memory.id);
            }

            const deletedMemories = this.#db.prepare(
                'DELETE FROM memories WHERE scope = ? AND scope_id = ? AND content = ?',
            ).run(row.scope, row.scope_id, row.content).changes;
            const deletedProposals = this.#db.prepare(
                'DELETE FROM memory_proposals WHERE scope = ? AND scope_id = ? AND content = ?',
            ).run(row.scope, row.scope_id, row.content).changes;

            let deletedSourceEvents = 0;
            for (const eventId of sourceEventIds) {
                const result = this.#db.prepare(
                    'DELETE FROM memory_events WHERE id = ? AND event_type = ? ' +
                    'AND NOT EXISTS (SELECT 1 FROM memory_proposals p WHERE p.source_event_id = memory_events.id) ' +
                    'AND NOT EXISTS (SELECT 1 FROM memories m WHERE m.source_event_id = memory_events.id)',
                ).run(eventId, 'memory.proposal_created');
                deletedSourceEvents += result.changes;
            }

            this.recordEvent({
                scope: row.scope,
                scopeId: row.scope_id,
                eventType: 'memory.deleted',
                content: 'Memory and linked records purged by user.',
                metadata: {
                    memoryId,
                    purgedMemories: deletedMemories,
                    purgedProposals: deletedProposals,
                    purgedSourceEvents: deletedSourceEvents,
                },
            });
            this.#db.exec('COMMIT;');
            return true;
        } catch (error) {
            this.#db.exec('ROLLBACK;');
            throw error;
        }
    }
    /**
     * Record a chat turn once, even if frontend lifecycle events fire more than once.
     * Raw turns remain events only; they do not become approved memories directly.
     * @param {object} input Captured turn fields.
     * @returns {object} Stored event and duplicate indicator.
     */
    captureTurn({ scopeId, role, content, captureKey, metadata = {}, createdAt = Date.now() }) {
        const target = normalizeScope('chat', scopeId);
        if (!['user', 'assistant'].includes(role)) throw new TypeError('Captured turn role must be user or assistant.');
        const text = normalizeText(content, MAX_EVENT_CONTENT, 'Captured turn content');
        const key = normalizeText(captureKey, 256, 'Capture key');
        if (!Number.isSafeInteger(createdAt) || createdAt < 0) throw new TypeError('Event timestamp must be a non-negative integer.');
        this.#db.exec('BEGIN IMMEDIATE;');
        try {
            const existing = this.#db.prepare(
                'SELECT e.* FROM memory_capture_keys k INNER JOIN memory_events e ON e.id = k.event_id WHERE k.capture_key = ?',
            ).get(key);
            if (existing) {
                this.#db.exec('COMMIT;');
                return { event: toEvent(existing), duplicate: true };
            }
            const event = this.recordEvent({
                scope: target.scope,
                scopeId: target.scopeId,
                eventType: role === 'user' ? 'chat.user_turn' : 'chat.assistant_turn',
                content: text,
                metadata: { ...metadata, role, origin: 'automatic_capture' },
                createdAt,
            });
            this.#db.prepare(
                'INSERT INTO memory_capture_keys(capture_key, event_id, created_at) VALUES (?, ?, ?)',
            ).run(key, event.id, createdAt);
            this.#db.exec('COMMIT;');
            return { event, duplicate: false };
        } catch (error) {
            this.#db.exec('ROLLBACK;');
            throw error;
        }
    }

    /**
     * Return captured-turn count for the active chat. Used to trigger optional dreaming.
     * @param {string} scopeId Chat ID.
     * @returns {number} Captured turn count.
     */
    countCapturedTurns(scopeId) {
        const target = normalizeScope('chat', scopeId);
        return this.#db.prepare(
            'SELECT COUNT(*) AS count FROM memory_events WHERE scope = ? AND scope_id = ? ' +
            'AND event_type IN (\'chat.user_turn\', \'chat.assistant_turn\')',
        ).get(target.scope, target.scopeId).count;
    }

    /**
     * Read recent events from a single scope, optionally restricted to event types.
     * Results are returned in chronological order for reflection and consolidation.
     * @param {object} options Query options.
     * @returns {object[]} Events.
     */
    listEvents({ scope = 'chat', scopeId, eventTypes = [], limit = 100 } = {}) {
        const target = normalizeScope(scope, scopeId);
        if (!Array.isArray(eventTypes) || eventTypes.some(type => typeof type !== 'string' || type.length > 64)) {
            throw new TypeError('Event types must be an array of short strings.');
        }
        const safeLimit = Math.max(1, Math.min(200, Number.isInteger(limit) ? limit : 100));
        const params = [target.scope, target.scopeId];
        let sql = 'SELECT * FROM memory_events WHERE scope = ? AND scope_id = ?';
        if (eventTypes.length) {
            sql += ' AND event_type IN (' + eventTypes.map(() => '?').join(', ') + ')';
            params.push(...eventTypes);
        }
        sql += ' ORDER BY created_at DESC LIMIT ?';
        params.push(safeLimit);
        return this.#db.prepare(sql).all(...params).reverse().map(toEvent);
    }

    /**
     * Return true when a matching accepted memory or pending proposal already exists.
     * @param {object} input Memory identity.
     * @returns {boolean} Whether the candidate is already known.
     */
    hasMemoryOrPending({ scope, scopeId, kind, content }) {
        const target = normalizeScope(scope, scopeId);
        const text = normalizeText(content, MAX_CONTENT, 'Memory content');
        if (!KINDS.has(kind)) throw new TypeError('Unsupported memory kind.');
        const accepted = this.#db.prepare(
            'SELECT 1 FROM memories WHERE scope = ? AND scope_id = ? AND kind = ? AND content = ? LIMIT 1',
        ).get(target.scope, target.scopeId, kind, text);
        if (accepted) return true;
        const pending = this.#db.prepare(
            'SELECT 1 FROM memory_proposals WHERE status = \'pending\' AND scope = ? AND scope_id = ? AND kind = ? AND content = ? LIMIT 1',
        ).get(target.scope, target.scopeId, kind, text);
        return !!pending;
    }

    getSummary() {
        return {
            events: this.#db.prepare('SELECT COUNT(*) AS count FROM memory_events').get().count,
            acceptedMemories: this.#db.prepare('SELECT COUNT(*) AS count FROM memories').get().count,
            pendingProposals: this.#db.prepare('SELECT COUNT(*) AS count FROM memory_proposals WHERE status = \'pending\'').get().count,
        };
    }

    close() {
        this.#db.close();
    }
}
