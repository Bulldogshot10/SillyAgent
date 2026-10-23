import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fsPromises } from 'node:fs';

const MAX_NAME_LENGTH = 120;
const MAX_DESCRIPTION_LENGTH = 500;
const MAX_CONTENT_LENGTH = 12000;
const MAX_REASON_LENGTH = 1000;
const CREDENTIAL_PATTERN = /(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|Bearer\s+[A-Za-z0-9._~+/-]{20,})/u;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

function normalizeText(value, maximum, name, minimum = 1) {
    if (typeof value !== 'string') throw new TypeError(name + ' must be a string.');
    const text = value.trim();
    if (text.length < minimum || text.length > maximum) {
        throw new TypeError(name + ' must contain between ' + minimum + ' and ' + maximum + ' characters.');
    }
    return text;
}

function normalizeSlug(value) {
    if (typeof value !== 'string') throw new TypeError('A skill slug is required.');
    const slug = value.trim().toLowerCase();
    if (slug.length > 80 || !SLUG_PATTERN.test(slug)) {
        throw new TypeError('Skill slugs must use lowercase letters, numbers, and single hyphens.');
    }
    return slug;
}

function slugFromName(name) {
    const slug = name.normalize('NFKD')
        .replace(/[\u0300-\u036f]/gu, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/gu, '-')
        .replace(/^-+|-+$/gu, '')
        .slice(0, 80)
        .replace(/-+$/gu, '');
    return normalizeSlug(slug);
}

function parseJson(value, fallback = {}) {
    try {
        return JSON.parse(value || '{}');
    } catch {
        return fallback;
    }
}

async function secureSkillStorage(databasePath) {
    const resolvedPath = path.resolve(databasePath);
    const directoryPath = path.dirname(resolvedPath);
    await fsPromises.mkdir(directoryPath, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });

    if (process.platform === 'win32') return;

    const directoryInfo = await fsPromises.lstat(directoryPath);
    if (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory()) {
        throw new Error('Skill storage directory must be a real directory, not a symbolic link.');
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
        if (fileInfo.isSymbolicLink()) throw new Error('Skill storage files must not be symbolic links.');
        await fsPromises.chmod(filePath, PRIVATE_FILE_MODE);
    }
}

function revisionFromRow(row, includeContent = true) {
    if (!row) return null;
    const revision = {
        slug: row.slug,
        version: row.version,
        name: row.name,
        description: row.description,
        checksum: row.checksum,
        status: row.status,
        source: row.source,
        changeReason: row.change_reason,
        parentVersion: row.parent_version,
        evaluation: parseJson(row.evaluation_json),
        createdAt: row.created_at,
        activatedAt: row.activated_at,
    };
    if (includeContent) revision.content = row.content;
    return revision;
}

function boundedLimit(value, fallback = 20, maximum = 100) {
    return Math.max(1, Math.min(maximum, Number.isInteger(value) ? value : fallback));
}

function validateRevision(name, description, content) {
    const checks = [];
    if (name.length >= 2) checks.push('name-length');
    if (description.length >= 8) checks.push('description-length');
    if (content.length >= 80) checks.push('content-length');
    if (content.split(/\s+/u).filter(Boolean).length >= 12) checks.push('minimum-instruction-density');
    const requiredChecks = ['name-length', 'description-length', 'content-length', 'minimum-instruction-density'];
    const failed = requiredChecks.filter(check => !checks.includes(check));
    if (failed.length) {
        throw new TypeError('Skill revision failed validation: ' + failed.join(', ') + '.');
    }
    return { valid: true, checks, score: 1 };
}

/**
 * Persistent agent-managed procedural skills.
 *
 * Skills use progressive disclosure: catalog results contain metadata only, while
 * readSkill returns the instruction body only when explicitly requested.
 * Skill bodies are Markdown instructions, never executable application code.
 */
export class SkillStore {
    #db;

    constructor(database) {
        this.#db = database;
        this.#initialize();
    }

    static async open(databasePath) {
        if (typeof databasePath !== 'string' || !databasePath) {
            throw new TypeError('A skill database path is required.');
        }
        if (databasePath !== ':memory:') await secureSkillStorage(databasePath);

        let DatabaseSync;
        try {
            ({ DatabaseSync } = await import('node:sqlite'));
        } catch (error) {
            throw new Error('Persistent agent skills require Node.js 22.5+ with the built-in node:sqlite module.', { cause: error });
        }

        const database = new DatabaseSync(databasePath);
        try {
            const store = new SkillStore(database);
            if (databasePath !== ':memory:') await secureSkillStorage(databasePath);
            return store;
        } catch (error) {
            database.close();
            throw new Error('Could not initialize the skill database. Check Node.js SQLite support and database permissions.', { cause: error });
        }
    }

    #assertCharacterActive() {
        const row = this.#db.prepare('SELECT deleted FROM skill_store_lifecycle WHERE singleton = 1').get();
        if (row?.deleted === 1) {
            const error = new Error('This character was deleted; procedural skill writes are blocked until the character is reopened.');
            error.code = 'character_partition_deleted';
            throw error;
        }
    }

    #initialize() {
        this.#db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 2500; PRAGMA secure_delete = ON; PRAGMA trusted_schema = OFF;');
        this.#db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
        this.#db.exec(
            'CREATE TABLE IF NOT EXISTS skill_store_lifecycle (' +
            'singleton INTEGER PRIMARY KEY CHECK (singleton = 1), deleted INTEGER NOT NULL CHECK (deleted IN (0, 1)));',
        );
        this.#db.prepare('INSERT OR IGNORE INTO skill_store_lifecycle(singleton, deleted) VALUES (1, 0)').run();
        this.#db.exec(
            'CREATE TABLE IF NOT EXISTS skills (' +
            'slug TEXT PRIMARY KEY, next_version INTEGER NOT NULL DEFAULT 1, active_version INTEGER, ' +
            'created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);',
        );
        this.#db.exec(
            'CREATE TABLE IF NOT EXISTS skill_revisions (' +
            'slug TEXT NOT NULL, version INTEGER NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL, content TEXT NOT NULL, ' +
            'checksum TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN (\'pending\',\'active\',\'superseded\',\'rejected\')), ' +
            'source TEXT NOT NULL, change_reason TEXT NOT NULL, parent_version INTEGER, evaluation_json TEXT NOT NULL DEFAULT \'{}\', ' +
            'created_at INTEGER NOT NULL, activated_at INTEGER, PRIMARY KEY (slug, version), ' +
            'FOREIGN KEY (slug) REFERENCES skills(slug));',
        );
        this.#db.exec('CREATE INDEX IF NOT EXISTS skill_revisions_status_created ON skill_revisions(status, created_at DESC);');
        this.#db.exec('CREATE INDEX IF NOT EXISTS skill_revisions_slug_version ON skill_revisions(slug, version DESC);');
        this.#db.exec(
            'CREATE TABLE IF NOT EXISTS skill_events (' +
            'id TEXT PRIMARY KEY, slug TEXT NOT NULL, version INTEGER, event_type TEXT NOT NULL, ' +
            'details_json TEXT NOT NULL DEFAULT \'{}\', created_at INTEGER NOT NULL);',
        );
        this.#db.exec('CREATE INDEX IF NOT EXISTS skill_events_slug_created ON skill_events(slug, created_at DESC);');
        this.#db.exec('CREATE TABLE IF NOT EXISTS skill_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);');
    }

    #audit(slug, version, eventType, details = {}) {
        this.#db.prepare(
            'INSERT INTO skill_events (id, slug, version, event_type, details_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        ).run(randomUUID(), slug, version ?? null, eventType, JSON.stringify(details), Date.now());
    }

    getSettings() {
        const rows = this.#db.prepare('SELECT key, value FROM skill_settings').all();
        const values = Object.fromEntries(rows.map(row => [row.key, row.value]));
        return { requireApproval: values.requireApproval === 'true' };
    }

    updateSettings(input) {
        if (!input || typeof input !== 'object' || Array.isArray(input)) {
            throw new TypeError('Skill settings must be an object.');
        }
        const allowedKeys = new Set(['requireApproval']);
        for (const key of Object.keys(input)) {
            if (!allowedKeys.has(key)) throw new TypeError('Unsupported skill setting: ' + key + '.');
        }
        if (Object.hasOwn(input, 'requireApproval')) {
            if (typeof input.requireApproval !== 'boolean') throw new TypeError('requireApproval must be a boolean.');
            this.#assertCharacterActive();
            this.#db.prepare(
                'INSERT INTO skill_settings (key, value) VALUES (?, ?) ' +
                'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
            ).run('requireApproval', String(input.requireApproval));
            this.#audit('_settings', null, 'skill.settings_updated', { requireApproval: input.requireApproval });
        }
        return this.getSettings();
    }

    listSkills({ query = '', limit = 20 } = {}) {
        const safeLimit = boundedLimit(limit);
        if (typeof query !== 'string' || query.length > 200) throw new TypeError('Skill search query must be 0-200 characters.');
        const rows = this.#db.prepare(
            'SELECT r.slug, r.version, r.name, r.description, r.checksum, r.source, r.created_at, r.activated_at, s.updated_at ' +
            'FROM skills s JOIN skill_revisions r ON r.slug = s.slug AND r.version = s.active_version ' +
            'WHERE r.status = \'active\' ORDER BY s.updated_at DESC',
        ).all();
        const needle = query.trim().toLocaleLowerCase();
        return rows.filter(row => !needle
            || row.slug.includes(needle)
            || row.name.toLocaleLowerCase().includes(needle)
            || row.description.toLocaleLowerCase().includes(needle))
            .slice(0, safeLimit)
            .map(row => ({
                slug: row.slug,
                version: row.version,
                name: row.name,
                description: row.description,
                checksum: row.checksum,
                source: row.source,
                createdAt: row.created_at,
                activatedAt: row.activated_at,
                updatedAt: row.updated_at,
            }));
    }

    searchSkills({ query, limit = 10 } = {}) {
        const text = normalizeText(query, 200, 'Skill search query');
        return this.listSkills({ query: text, limit });
    }

    readSkill(slug) {
        const normalizedSlug = normalizeSlug(slug);
        const row = this.#db.prepare(
            'SELECT r.* FROM skills s JOIN skill_revisions r ON r.slug = s.slug AND r.version = s.active_version ' +
            'WHERE s.slug = ? AND r.status = \'active\'',
        ).get(normalizedSlug);
        return revisionFromRow(row);
    }

    getRevision(slug, version) {
        const normalizedSlug = normalizeSlug(slug);
        if (!Number.isInteger(version) || version < 1) throw new TypeError('Skill version must be a positive integer.');
        const row = this.#db.prepare('SELECT * FROM skill_revisions WHERE slug = ? AND version = ?')
            .get(normalizedSlug, version);
        return revisionFromRow(row);
    }

    getHistory(slug, { limit = 30 } = {}) {
        const normalizedSlug = normalizeSlug(slug);
        return this.#db.prepare(
            'SELECT slug, version, name, description, checksum, status, source, change_reason, parent_version, ' +
            'evaluation_json, created_at, activated_at FROM skill_revisions WHERE slug = ? ORDER BY version DESC LIMIT ?',
        ).all(normalizedSlug, boundedLimit(limit, 30, 100)).map(row => revisionFromRow(row, false));
    }

    listPendingRevisions({ limit = 30 } = {}) {
        return this.#db.prepare(
            'SELECT * FROM skill_revisions WHERE status = \'pending\' ORDER BY created_at DESC LIMIT ?',
        ).all(boundedLimit(limit, 30, 100)).map(row => revisionFromRow(row, false));
    }

    proposeSkill({
        slug,
        name,
        description,
        content,
        changeReason = 'Agent-created or improved a reusable procedure.',
        source = 'agent',
        requireApproval,
    }) {
        const normalizedName = normalizeText(name, MAX_NAME_LENGTH, 'Skill name', 2);
        const normalizedDescription = normalizeText(description, MAX_DESCRIPTION_LENGTH, 'Skill description', 8);
        const normalizedContent = normalizeText(content, MAX_CONTENT_LENGTH, 'Skill content', 80);
        const normalizedReason = normalizeText(changeReason, MAX_REASON_LENGTH, 'Change reason');
        for (const [label, value] of [
            ['Skill name', normalizedName],
            ['Skill description', normalizedDescription],
            ['Skill content', normalizedContent],
            ['Change reason', normalizedReason],
        ]) {
            if (CREDENTIAL_PATTERN.test(value)) throw new TypeError(label + ' must not contain credential-like secrets.');
        }
        const normalizedSource = normalizeText(source, 32, 'Skill source');
        if (!/^[a-z][a-z0-9_-]*$/u.test(normalizedSource)) throw new TypeError('Skill source must be a lowercase identifier.');
        const normalizedSlug = slug === undefined || slug === null || slug === ''
            ? slugFromName(normalizedName)
            : normalizeSlug(slug);
        const evaluation = validateRevision(normalizedName, normalizedDescription, normalizedContent);
        const checksum = createHash('sha256').update(normalizedContent, 'utf8').digest('hex');
        const approvalRequired = requireApproval === undefined ? this.getSettings().requireApproval : requireApproval;
        if (typeof approvalRequired !== 'boolean') throw new TypeError('requireApproval must be a boolean.');

        this.#db.exec('BEGIN IMMEDIATE;');
        try {
            this.#assertCharacterActive();
            let skill = this.#db.prepare('SELECT * FROM skills WHERE slug = ?').get(normalizedSlug);
            const active = skill?.active_version
                ? this.#db.prepare('SELECT * FROM skill_revisions WHERE slug = ? AND version = ?')
                    .get(normalizedSlug, skill.active_version)
                : null;

            if (active && active.name === normalizedName && active.description === normalizedDescription && active.checksum === checksum) {
                this.#db.exec('COMMIT;');
                return { created: false, duplicate: true, requiresApproval: false, revision: revisionFromRow(active) };
            }

            const duplicatePending = this.#db.prepare(
                'SELECT * FROM skill_revisions WHERE slug = ? AND status = \'pending\' AND name = ? AND description = ? AND checksum = ? ' +
                'ORDER BY version DESC LIMIT 1',
            ).get(normalizedSlug, normalizedName, normalizedDescription, checksum);
            if (duplicatePending) {
                if (!approvalRequired) {
                    const now = Date.now();
                    const latestSkill = this.#db.prepare('SELECT active_version FROM skills WHERE slug = ?').get(normalizedSlug);
                    const previousVersion = latestSkill?.active_version ?? null;
                    if (previousVersion !== null) {
                        this.#db.prepare('UPDATE skill_revisions SET status = \'superseded\' WHERE slug = ? AND version = ? AND status = \'active\'')
                            .run(normalizedSlug, previousVersion);
                    }
                    this.#db.prepare('UPDATE skill_revisions SET status = \'active\', activated_at = ? WHERE slug = ? AND version = ?')
                        .run(now, normalizedSlug, duplicatePending.version);
                    this.#db.prepare('UPDATE skills SET active_version = ?, updated_at = ? WHERE slug = ?')
                        .run(duplicatePending.version, now, normalizedSlug);
                    this.#audit(normalizedSlug, duplicatePending.version, 'skill.revision_activated', { source: 'policy-change' });
                    const promoted = this.#db.prepare('SELECT * FROM skill_revisions WHERE slug = ? AND version = ?')
                        .get(normalizedSlug, duplicatePending.version);
                    this.#db.exec('COMMIT;');
                    return { created: false, duplicate: true, requiresApproval: false, revision: revisionFromRow(promoted) };
                }
                this.#db.exec('COMMIT;');
                return {
                    created: false,
                    duplicate: true,
                    requiresApproval: true,
                    revision: revisionFromRow(duplicatePending),
                };
            }

            const now = Date.now();
            if (!skill) {
                this.#db.prepare(
                    'INSERT INTO skills (slug, next_version, active_version, created_at, updated_at) VALUES (?, 1, NULL, ?, ?)',
                ).run(normalizedSlug, now, now);
                skill = this.#db.prepare('SELECT * FROM skills WHERE slug = ?').get(normalizedSlug);
            }

            const version = skill.next_version;
            const parentVersion = skill.active_version ?? null;
            const status = approvalRequired ? 'pending' : 'active';
            this.#db.prepare(
                'INSERT INTO skill_revisions (slug, version, name, description, content, checksum, status, source, ' +
                'change_reason, parent_version, evaluation_json, created_at, activated_at) ' +
                'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            ).run(
                normalizedSlug, version, normalizedName, normalizedDescription, normalizedContent, checksum, status,
                normalizedSource, normalizedReason, parentVersion, JSON.stringify(evaluation), now, approvalRequired ? null : now,
            );
            this.#db.prepare('UPDATE skills SET next_version = ?, updated_at = ? WHERE slug = ?')
                .run(version + 1, now, normalizedSlug);

            if (!approvalRequired) {
                if (parentVersion !== null) {
                    this.#db.prepare(
                        'UPDATE skill_revisions SET status = \'superseded\' WHERE slug = ? AND version = ? AND status = \'active\'',
                    ).run(normalizedSlug, parentVersion);
                }
                this.#db.prepare('UPDATE skills SET active_version = ?, updated_at = ? WHERE slug = ?')
                    .run(version, now, normalizedSlug);
            }

            this.#audit(normalizedSlug, version, 'skill.revision_created', {
                status,
                source: normalizedSource,
                reason: normalizedReason,
                parentVersion,
                checksum,
            });
            if (!approvalRequired) {
                this.#audit(normalizedSlug, version, 'skill.revision_activated', { source: normalizedSource });
            }
            const row = this.#db.prepare('SELECT * FROM skill_revisions WHERE slug = ? AND version = ?')
                .get(normalizedSlug, version);
            this.#db.exec('COMMIT;');
            return {
                created: true,
                duplicate: false,
                requiresApproval: approvalRequired,
                revision: revisionFromRow(row),
            };
        } catch (error) {
            this.#db.exec('ROLLBACK;');
            throw error;
        }
    }

    reviewRevision(slug, version, decision) {
        const normalizedSlug = normalizeSlug(slug);
        if (!Number.isInteger(version) || version < 1) throw new TypeError('Skill version must be a positive integer.');
        if (!['approve', 'reject'].includes(decision)) throw new TypeError('Decision must be approve or reject.');

        this.#db.exec('BEGIN IMMEDIATE;');
        try {
            this.#assertCharacterActive();
            const revision = this.#db.prepare(
                'SELECT * FROM skill_revisions WHERE slug = ? AND version = \'pending\'',
            ).get(normalizedSlug, version);
            if (!revision) {
                this.#db.exec('COMMIT;');
                return null;
            }

            const now = Date.now();
            if (decision === 'approve') {
                const skill = this.#db.prepare('SELECT active_version FROM skills WHERE slug = ?').get(normalizedSlug);
                const previousVersion = skill?.active_version ?? null;
                if (previousVersion !== null && previousVersion !== version) {
                    this.#db.prepare(
                        'UPDATE skill_revisions SET status = \'superseded\' WHERE slug = ? AND version = ? AND status = \'active\'',
                    ).run(normalizedSlug, previousVersion);
                }
                this.#db.prepare(
                    'UPDATE skill_revisions SET status = \'active\', activated_at = ? WHERE slug = ? AND version = ?',
                ).run(now, normalizedSlug, version);
                this.#db.prepare('UPDATE skills SET active_version = ?, updated_at = ? WHERE slug = ?')
                    .run(version, now, normalizedSlug);
            } else {
                this.#db.prepare('UPDATE skill_revisions SET status = \'rejected\' WHERE slug = ? AND version = ?')
                    .run(normalizedSlug, version);
            }

            this.#audit(normalizedSlug, version, decision === 'approve' ? 'skill.revision_approved' : 'skill.revision_rejected', { decision });
            const updated = this.#db.prepare('SELECT * FROM skill_revisions WHERE slug = ? AND version = ?')
                .get(normalizedSlug, version);
            this.#db.exec('COMMIT;');
            return revisionFromRow(updated);
        } catch (error) {
            this.#db.exec('ROLLBACK;');
            throw error;
        }
    }

    rollbackSkill(slug, targetVersion, { requireApproval, reason } = {}) {
        const target = this.getRevision(slug, targetVersion);
        if (!target) throw new TypeError('The target skill version does not exist.');
        return this.proposeSkill({
            slug: target.slug,
            name: target.name,
            description: target.description,
            content: target.content,
            changeReason: reason ?? ('Rollback requested to version ' + targetVersion + '.'),
            source: 'rollback',
            requireApproval,
        });
    }

    getEvents({ slug, limit = 50 } = {}) {
        const safeLimit = boundedLimit(limit, 50, 200);
        if (slug !== undefined && slug !== null) {
            const normalizedSlug = normalizeSlug(slug);
            return this.#db.prepare(
                'SELECT id, slug, version, event_type, details_json, created_at FROM skill_events WHERE slug = ? ORDER BY created_at DESC LIMIT ?',
            ).all(normalizedSlug, safeLimit).map(row => ({
                id: row.id,
                slug: row.slug,
                version: row.version,
                eventType: row.event_type,
                details: parseJson(row.details_json),
                createdAt: row.created_at,
            }));
        }
        return this.#db.prepare(
            'SELECT id, slug, version, event_type, details_json, created_at FROM skill_events ORDER BY created_at DESC LIMIT ?',
        ).all(safeLimit).map(row => ({
            id: row.id,
            slug: row.slug,
            version: row.version,
            eventType: row.event_type,
            details: parseJson(row.details_json),
            createdAt: row.created_at,
        }));
    }

    /**
     * Remove every procedural skill, revision, setting, and audit event for this character.
     * @returns {{skills: number, revisions: number, events: number}}
     */
    clearAll() {
        this.#db.exec('BEGIN IMMEDIATE;');
        try {
            const skills = this.#db.prepare('SELECT COUNT(*) AS count FROM skills').get().count;
            const revisions = this.#db.prepare('SELECT COUNT(*) AS count FROM skill_revisions').get().count;
            const events = this.#db.prepare('SELECT COUNT(*) AS count FROM skill_events').get().count;
            this.#db.exec('DELETE FROM skill_events; DELETE FROM skill_revisions; DELETE FROM skills; DELETE FROM skill_settings;');
            this.#db.prepare('UPDATE skill_store_lifecycle SET deleted = 1 WHERE singleton = 1').run();
            this.#db.exec('COMMIT;');
            return { skills, revisions, events };
        } catch (error) {
            this.#db.exec('ROLLBACK;');
            throw error;
        }
    }

    /**
     * Re-enable procedural skill writes after the core verifies the owning character exists.
     * @returns {{activated: boolean}} Whether the tombstone was cleared.
     */
    activateCharacterPartition() {
        this.#db.exec('BEGIN IMMEDIATE;');
        try {
            const result = this.#db.prepare(
                'UPDATE skill_store_lifecycle SET deleted = 0 WHERE singleton = 1 AND deleted = 1',
            ).run();
            this.#db.exec('COMMIT;');
            return { activated: result.changes > 0 };
        } catch (error) {
            this.#db.exec('ROLLBACK;');
            throw error;
        }
    }

    close() {
        this.#db.close();
    }
}
