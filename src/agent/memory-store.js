import path from 'node:path';
import { promises as fsPromises } from 'node:fs';
import { randomUUID } from 'node:crypto';

const SCOPES = new Set(['user', 'character', 'chat']);
const KINDS = new Set(['fact', 'preference', 'event', 'relationship', 'goal', 'world_state']);
const STATUSES = new Set(['pending', 'approved', 'rejected']);
const MAX_CONTENT = 4000;
const MAX_EVENT_CONTENT = 12000;
const MAX_METADATA_BYTES = 8192;

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
        if (databasePath !== ':memory:') {
            await fsPromises.mkdir(path.dirname(path.resolve(databasePath)), { recursive: true });
        }

        let DatabaseSync;
        try {
            ({ DatabaseSync } = await import('node:sqlite'));
        } catch (error) {
            throw new Error('Persistent memory requires Node.js 22.5+ with the built-in node:sqlite module.', { cause: error });
        }

        const database = new DatabaseSync(databasePath);
        try {
            return new MemoryStore(database);
        } catch (error) {
            database.close();
            throw new Error('Could not initialize the memory database. Check SQLite FTS5 support and database permissions.', { cause: error });
        }
    }

    #initialize() {
        this.#db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 2500;');
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

    /**
     * Create a reviewable memory candidate. Proposals are not retrieved until approved.
     * @param {object} input Candidate fields.
     * @returns {object} Stored proposal.
     */
    proposeMemory({ scope, scopeId, kind = 'fact', content, importance = 3, metadata, createdAt = Date.now() }) {
        const target = normalizeScope(scope, scopeId);
        const text = normalizeText(content, MAX_CONTENT, 'Memory content');
        if (!KINDS.has(kind)) throw new TypeError('Unsupported memory kind.');
        if (!Number.isInteger(importance) || importance < 1 || importance > 5) {
            throw new TypeError('Memory importance must be an integer from 1 through 5.');
        }
        if (!Number.isSafeInteger(createdAt) || createdAt < 0) throw new TypeError('Memory timestamp must be a non-negative integer.');
        const metadataJson = serializeMetadata(metadata);

        this.#db.exec('BEGIN IMMEDIATE;');
        try {
            const duplicate = this.#db.prepare(
                'SELECT * FROM memory_proposals WHERE status = \'pending\' AND scope = ? AND scope_id = ? AND kind = ? AND content = ? ORDER BY created_at DESC LIMIT 1',
            ).get(target.scope, target.scopeId, kind, text);
            if (duplicate) {
                this.#db.exec('COMMIT;');
                return { ...toProposal(duplicate), duplicate: true };
            }

            const event = this.recordEvent({
                scope: target.scope,
                scopeId: target.scopeId,
                eventType: 'memory.proposal_created',
                content: text,
                metadata: { kind, importance },
                createdAt,
            });
            const id = randomUUID();
            this.#db.prepare(
                'INSERT INTO memory_proposals (id, scope, scope_id, kind, content, importance, source_event_id, status, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, \'pending\', ?, ?)',
            ).run(id, target.scope, target.scopeId, kind, text, importance, event.id, metadataJson, createdAt);
            const proposal = toProposal(this.#db.prepare('SELECT * FROM memory_proposals WHERE id = ?').get(id));
            this.#db.exec('COMMIT;');
            return { ...proposal, duplicate: false };
        } catch (error) {
            this.#db.exec('ROLLBACK;');
            throw error;
        }
    }

    /**
     * Retrieve reviewable candidates.
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
                    proposalRow.created_at, reviewedAt,
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
                memory = toMemory(memoryRow);
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

        const sql = 'WITH matches AS (' + matchQueries.join(' UNION ALL ') + ') ' +
            'SELECT m.* FROM memories m ' +
            'INNER JOIN (SELECT memory_id, MIN(rank) AS rank FROM matches GROUP BY memory_id) ranked ON ranked.memory_id = m.id ' +
            'WHERE (' + conditions.join(' OR ') + ') ' +
            'ORDER BY ranked.rank ASC, m.importance DESC, m.updated_at DESC LIMIT ?';
        return this.#db.prepare(sql).all(...matchParams, ...scopeParams, safeLimit).map(row => ({
            ...toMemory(row),
            preview: row.content.length > 400 ? row.content.slice(0, 397) + '...' : row.content,
        }));
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
