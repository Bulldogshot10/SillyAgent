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
const skillWritesEnvKey = 'SILLYTAVERN_AGENTTOOLS_SKILLWRITESENABLED';
let previousMemoryProposalsEnv;
let previousSkillWritesEnv;

const initialContent = [
    '# Agentic skill lifecycle',
    '',
    'Use this skill to validate a new agent-managed skill workflow.',
    '',
    '1. Search the catalog by describing the procedure you need.',
    '2. Read the selected skill only after its metadata indicates a match.',
    '3. Apply its steps to the current task and record what worked or failed.',
    '4. Propose a focused revision when a reusable improvement is discovered.',
    '5. Validate the outcome and preserve earlier versions so the agent can roll back.',
].join('\n');

const improvedContent = [
    '# Agentic skill lifecycle, improved',
    '',
    'Use this skill to validate a new agent-managed skill workflow and retain useful improvements.',
    '',
    '1. Search the metadata-only catalog and load only the skill relevant to the task.',
    '2. Follow its steps while tracking evidence, failed attempts, and successful outcomes.',
    '3. Propose focused Markdown changes that explain when to use the skill and why the steps work.',
    '4. Run deterministic validation before activation; use approval only when the owner opts in.',
    '5. Keep every revision and checksum so a poor change can be reviewed or rolled back.',
].join('\n');

beforeAll(async () => {
    previousMemoryProposalsEnv = process.env[memoryProposalsEnvKey];
    previousSkillWritesEnv = process.env[skillWritesEnvKey];
    process.env[memoryProposalsEnvKey] = 'true';
    process.env[skillWritesEnvKey] = 'true';
    userRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sillyagent-skills-endpoint-'));

    const app = express();
    app.use(express.json());
    app.use((request, _response, next) => {
        request.user = { directories: { root: userRoot } };
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
    if (previousMemoryProposalsEnv === undefined) delete process.env[memoryProposalsEnvKey];
    else process.env[memoryProposalsEnvKey] = previousMemoryProposalsEnv;
    if (previousSkillWritesEnv === undefined) delete process.env[skillWritesEnvKey];
    else process.env[skillWritesEnvKey] = previousSkillWritesEnv;
});

async function postJson(url, body) {
    return fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
}

describe('agent-managed skills API', () => {
    test('publishes skill tools alongside existing agent tools', async () => {
        const response = await fetch(baseUrl);
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.tools.some(tool => tool.function.name === 'skill_search')).toBe(true);
        expect(body.tools.some(tool => tool.function.name === 'skill_read')).toBe(true);
        expect(body.tools.some(tool => tool.function.name === 'skill_propose')).toBe(true);
        expect(body.tools.some(tool => tool.function.name === 'skill_history')).toBe(true);
        expect(body.tools.some(tool => tool.function.name === 'skill_rollback')).toBe(true);
    });

    test('auto-activates agent-authored revisions by default and progressively discloses content', async () => {
        const createResponse = await postJson(baseUrl + '/execute', {
            name: 'skill_propose',
            arguments: {
                name: 'Agentic Skill Lifecycle',
                description: 'A repeatable workflow for creating and improving agent-managed skills.',
                content: initialContent,
                changeReason: 'Capture the reusable process discovered during implementation.',
            },
        });
        const created = await createResponse.json();
        expect(createResponse.status).toBe(200);
        expect(created.ok).toBe(true);
        expect(created.result.revision.slug).toBe('agentic-skill-lifecycle');
        expect(created.result.revision.version).toBe(1);
        expect(created.result.revision.status).toBe('active');
        expect(created.result.requiresApproval).toBe(false);

        const catalogResponse = await fetch(baseUrl + '/skills');
        const catalog = await catalogResponse.json();
        const entry = catalog.skills.find(skill => skill.slug === 'agentic-skill-lifecycle');
        expect(catalogResponse.status).toBe(200);
        expect(entry.version).toBe(1);
        expect(entry.content).toBeUndefined();

        const readResponse = await fetch(baseUrl + '/skills/agentic-skill-lifecycle');
        const loaded = await readResponse.json();
        expect(readResponse.status).toBe(200);
        expect(loaded.skill.content).toContain('metadata indicates a match');

        const modelReadResponse = await postJson(baseUrl + '/execute', {
            name: 'skill_read',
            arguments: { slug: 'agentic-skill-lifecycle' },
        });
        const modelRead = await modelReadResponse.json();
        expect(modelReadResponse.status).toBe(200);
        expect(modelRead.result.found).toBe(true);
        expect(modelRead.result.skill.version).toBe(1);
    });

    test('keeps revisions pending only when approval is opted in', async () => {
        const settingsResponse = await postJson(baseUrl + '/skills/settings', { requireApproval: true });
        expect(settingsResponse.status).toBe(200);
        expect((await settingsResponse.json()).settings.requireApproval).toBe(true);

        const proposedResponse = await postJson(baseUrl + '/execute', {
            name: 'skill_propose',
            arguments: {
                slug: 'agentic-skill-lifecycle',
                name: 'Agentic Skill Lifecycle',
                description: 'A repeatable workflow for creating and improving agent-managed skills.',
                content: improvedContent,
                changeReason: 'Add an explicit validation and rollback step.',
            },
        });
        const proposed = await proposedResponse.json();
        expect(proposedResponse.status).toBe(200);
        expect(proposed.result.requiresApproval).toBe(true);
        expect(proposed.result.revision.status).toBe('pending');

        const beforeReviewResponse = await fetch(baseUrl + '/skills/agentic-skill-lifecycle');
        const beforeReview = await beforeReviewResponse.json();
        expect(beforeReview.skill.version).toBe(1);

        const pendingResponse = await fetch(baseUrl + '/skills/pending');
        const pending = await pendingResponse.json();
        expect(pending.revisions.some(revision => revision.slug === 'agentic-skill-lifecycle' && revision.version === 2)).toBe(true);

        const pendingRevisionResponse = await fetch(baseUrl + '/skills/agentic-skill-lifecycle/revisions/2');
        const pendingRevision = await pendingRevisionResponse.json();
        expect(pendingRevisionResponse.status).toBe(200);
        expect(pendingRevision.revision.status).toBe('pending');
        expect(pendingRevision.revision.content).toContain('deterministic validation before activation');

        const reviewResponse = await postJson(baseUrl + '/skills/agentic-skill-lifecycle/revisions/2/review', {
            decision: 'approve',
        });
        const reviewed = await reviewResponse.json();
        expect(reviewResponse.status).toBe(200);
        expect(reviewed.revision.status).toBe('active');
        expect(reviewed.activeSkill.version).toBe(2);

        const historyResponse = await fetch(baseUrl + '/skills/agentic-skill-lifecycle/history');
        const history = await historyResponse.json();
        expect(history.revisions.map(revision => revision.version)).toEqual([2, 1]);
        expect(history.revisions.every(revision => revision.checksum)).toBe(true);

        const resetResponse = await postJson(baseUrl + '/skills/settings', { requireApproval: false });
        expect((await resetResponse.json()).settings.requireApproval).toBe(false);
    });

    test('rejects malformed review decisions and respects the independent skills-write switch', async () => {
        const invalidReview = await postJson(baseUrl + '/skills/agentic-skill-lifecycle/revisions/2/review', {
            decision: 'maybe',
        });
        expect(invalidReview.status).toBe(400);

        process.env[skillWritesEnvKey] = 'false';
        const denied = await postJson(baseUrl + '/execute', {
            name: 'skill_propose',
            arguments: {
                name: 'Disabled Skill',
                description: 'A skill that should not be written when the feature is disabled.',
                content: initialContent,
            },
        });
        expect(denied.status).toBe(403);
        process.env[skillWritesEnvKey] = 'true';
    });
});
