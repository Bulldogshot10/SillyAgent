import { afterEach, describe, test, expect } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
    beginAgentChatDeletion,
    beginAgentCharacterDeletion,
    endAgentChatDeletion,
    endAgentCharacterDeletion,
    getAgentSkillStore,
    isAgentChatDeletionInProgress,
    isAgentCharacterDeletionInProgress,
} from '../src/agent/runtime.js';

let root;
let juliaSkills;
let bellaSkills;

afterEach(async () => {
    juliaSkills?.close();
    bellaSkills?.close();
    juliaSkills = null;
    bellaSkills = null;
    if (root) await fs.rm(root, { recursive: true, force: true });
    root = null;
});

describe('native agent deletion coordination', () => {
    test('keeps overlapping deletion locks scoped by root and owner', async () => {
        root = await fs.mkdtemp(path.join(os.tmpdir(), 'sillyagent-deletion-locks-'));
        const directories = { root };
        beginAgentChatDeletion(directories, 'same-chat', 'julia.png');
        beginAgentChatDeletion(directories, 'same-chat', 'julia.png');
        expect(isAgentChatDeletionInProgress(directories, 'same-chat', 'julia.png')).toBe(true);
        expect(isAgentChatDeletionInProgress(directories, 'same-chat', 'bella.png')).toBe(false);

        endAgentChatDeletion(directories, 'same-chat', 'julia.png');
        expect(isAgentChatDeletionInProgress(directories, 'same-chat', 'julia.png')).toBe(true);
        endAgentChatDeletion(directories, 'same-chat', 'julia.png');
        expect(isAgentChatDeletionInProgress(directories, 'same-chat', 'julia.png')).toBe(false);

        beginAgentCharacterDeletion(directories, 'julia.png');
        expect(isAgentCharacterDeletionInProgress(directories, 'julia.png')).toBe(true);
        expect(isAgentCharacterDeletionInProgress(directories, 'bella.png')).toBe(false);
        endAgentCharacterDeletion(directories, 'julia.png');
        expect(isAgentCharacterDeletionInProgress(directories, 'julia.png')).toBe(false);
    });
});

describe('native per-character procedural memory', () => {
    test('stores skills in separate databases for separate characters', async () => {
        root = await fs.mkdtemp(path.join(os.tmpdir(), 'sillyagent-character-skills-'));
        juliaSkills = await getAgentSkillStore({ root }, 'julia.png');
        bellaSkills = await getAgentSkillStore({ root }, 'bella.png');

        const skill = {
            slug: 'rust-cli-workflow',
            name: 'Rust CLI workflow',
            description: 'A reusable workflow for building and debugging a Rust command-line tool.',
            content: [
                '# Rust CLI workflow',
                '',
                'Use this procedure when building or debugging a small Rust command-line application.',
                '',
                '1. Confirm the installed toolchain and project directory.',
                '2. Reproduce the issue with the smallest relevant command.',
                '3. Read the complete compiler diagnostic and identify the failing module or type.',
                '4. Make the smallest correction supported by the diagnostic.',
                '5. Rerun the command and confirm the original failure is gone.',
            ].join('\n'),
            changeReason: 'Capture a reusable verified workflow.',
            source: 'self_improvement',
            requireApproval: false,
        };
        const created = juliaSkills.proposeSkill(skill);

        expect(created.created).toBe(true);
        expect(created.revision.status).toBe('active');
        expect(juliaSkills.readSkill('rust-cli-workflow')).not.toBeNull();
        expect(bellaSkills.readSkill('rust-cli-workflow')).toBeNull();
        expect(bellaSkills.listSkills()).toHaveLength(0);

        const skillFiles = (await fs.readdir(path.join(root, 'sillyagent', 'skills')))
            .filter(filename => filename.endsWith('.sqlite'));
        expect(skillFiles).toHaveLength(2);
        expect(skillFiles.every(filename => /^[a-f0-9]{64}\.sqlite$/u.test(filename))).toBe(true);
        await expect(fs.access(path.join(root, 'sillyagent', 'skills.sqlite'))).rejects.toThrow();
        await expect(getAgentSkillStore({ root })).rejects.toThrow(/active character ID/u);
    });
});
