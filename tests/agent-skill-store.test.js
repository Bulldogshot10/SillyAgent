import { afterEach, describe, test, expect } from '@jest/globals';
import { SkillStore } from '../src/agent/skill-store.js';

let store;

async function createStore() {
    store = await SkillStore.open(':memory:');
    return store;
}

const originalSkill = {
    name: 'API Debugging',
    description: 'A repeatable workflow for diagnosing API failures.',
    content: [
        '# API debugging',
        '',
        'Use this skill when an HTTP request fails or an API response differs from expectations.',
        '',
        '1. Reproduce the request with the smallest input that still fails.',
        '2. Record the status code, response body, request ID, and relevant headers.',
        '3. Check authentication, content type, payload schema, and server logs in that order.',
        '4. Compare the failing request with a known-good request and isolate one variable at a time.',
        '5. Add a regression test for the confirmed cause, then summarize the fix and remaining uncertainty.',
    ].join('\n'),
};

const improvedContent = [
    '# API debugging, improved',
    '',
    'Use this skill whenever an HTTP request fails or an API response differs from expectations.',
    '',
    '1. Reproduce the issue with the smallest deterministic request and capture the exact response.',
    '2. Check status, headers, authentication, payload validation, timeout, and server logs.',
    '3. Compare against a known-good request. Change one variable at a time and preserve evidence.',
    '4. Fix the underlying cause instead of masking the error; add a regression test for the failure.',
    '5. Re-run the failing test, nearby tests, and lint. Record the root cause and any unresolved edge case.',
].join('\n');

afterEach(() => {
    if (store) store.close();
    store = null;
});

describe('SkillStore', () => {
    test('defaults to autonomous activation and uses metadata-only progressive disclosure', async () => {
        const skills = await createStore();
        expect(skills.getSettings().requireApproval).toBe(false);

        const created = skills.proposeSkill(originalSkill);
        expect(created.created).toBe(true);
        expect(created.requiresApproval).toBe(false);
        expect(created.revision.version).toBe(1);
        expect(created.revision.status).toBe('active');
        expect(created.revision.checksum).toMatch(/^[a-f0-9]{64}$/u);

        const catalog = skills.listSkills();
        expect(catalog).toHaveLength(1);
        expect(catalog[0].slug).toBe('api-debugging');
        expect(catalog[0].version).toBe(1);
        expect(catalog[0].content).toBeUndefined();

        const loaded = skills.readSkill('api-debugging');
        expect(loaded.content).toContain('smallest input');
        expect(loaded.version).toBe(1);
    });

    test('stages revisions when approval is enabled and changes active version only after approval', async () => {
        const skills = await createStore();
        skills.proposeSkill(originalSkill);
        skills.updateSettings({ requireApproval: true });

        const pending = skills.proposeSkill({
            ...originalSkill,
            content: improvedContent,
            changeReason: 'Add explicit evidence capture and regression validation.',
        });
        expect(pending.requiresApproval).toBe(true);
        expect(pending.revision.status).toBe('pending');
        expect(skills.readSkill('api-debugging').version).toBe(1);
        expect(skills.listPendingRevisions()).toHaveLength(1);

        const approved = skills.reviewRevision('api-debugging', 2, 'approve');
        expect(approved.status).toBe('active');
        expect(skills.readSkill('api-debugging').version).toBe(2);
        expect(skills.getRevision('api-debugging', 1).status).toBe('superseded');
    });

    test('rejected revisions never replace active instructions', async () => {
        const skills = await createStore();
        skills.proposeSkill(originalSkill);
        const pending = skills.proposeSkill({
            ...originalSkill,
            content: improvedContent,
            requireApproval: true,
        });
        const rejected = skills.reviewRevision(pending.revision.slug, pending.revision.version, 'reject');
        expect(rejected.status).toBe('rejected');
        expect(skills.readSkill('api-debugging').version).toBe(1);
        expect(skills.readSkill('api-debugging').content).toBe(originalSkill.content);
    });

    test('rejects credential-like secrets from persistent skill content', async () => {
        const skills = await createStore();
        expect(() => skills.proposeSkill({
            ...originalSkill,
            content: originalSkill.content + '\n\nKeep this API key sk-12345678901234567890 for later use.',
        })).toThrow(/credential-like secrets/);
    });

    test('rollback creates a new version and preserves the full revision history', async () => {
        const skills = await createStore();
        skills.proposeSkill(originalSkill);
        skills.proposeSkill({ ...originalSkill, content: improvedContent });
        const rollback = skills.rollbackSkill('api-debugging', 1);

        expect(rollback.revision.version).toBe(3);
        expect(rollback.revision.source).toBe('rollback');
        expect(rollback.revision.status).toBe('active');
        expect(skills.readSkill('api-debugging').content).toBe(originalSkill.content);
        expect(skills.getHistory('api-debugging').map(revision => revision.version)).toEqual([3, 2, 1]);
        expect(skills.getEvents({ slug: 'api-debugging' }).some(event => event.eventType === 'skill.revision_activated')).toBe(true);
    });

    test('deduplicates an identical active revision and validates weak revisions', async () => {
        const skills = await createStore();
        const first = skills.proposeSkill(originalSkill);
        const duplicate = skills.proposeSkill(originalSkill);
        expect(first.created).toBe(true);
        expect(duplicate.created).toBe(false);
        expect(duplicate.duplicate).toBe(true);
        expect(() => skills.proposeSkill({
            name: 'Tiny',
            description: 'Too short',
            content: 'not enough',
        })).toThrow(/characters|validation/u);
    });

    test('can disable approval and auto-activate a previously pending identical revision', async () => {
        const skills = await createStore();
        skills.proposeSkill(originalSkill);
        skills.updateSettings({ requireApproval: true });
        const pending = skills.proposeSkill({ ...originalSkill, content: improvedContent });
        expect(pending.revision.status).toBe('pending');

        skills.updateSettings({ requireApproval: false });
        const activated = skills.proposeSkill({ ...originalSkill, content: improvedContent });
        expect(activated.duplicate).toBe(true);
        expect(activated.requiresApproval).toBe(false);
        expect(skills.readSkill('api-debugging').version).toBe(2);
    });
    test('clears a character skill database as one transaction', async () => {
        const skills = await createStore();
        skills.proposeSkill(originalSkill);
        expect(skills.readSkill('api-debugging')).not.toBeNull();
        expect(skills.getEvents({ slug: 'api-debugging' }).length).toBeGreaterThan(0);

        const result = skills.clearAll();

        expect(result.skills).toBe(1);
        expect(result.revisions).toBe(1);
        expect(result.events).toBeGreaterThan(0);
        expect(skills.readSkill('api-debugging')).toBeNull();
        expect(skills.getHistory('api-debugging')).toHaveLength(0);
        expect(skills.getEvents()).toHaveLength(0);
    });

});
