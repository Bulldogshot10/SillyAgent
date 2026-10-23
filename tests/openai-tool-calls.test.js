import { describe, expect, test } from '@jest/globals';

import { selectOpenAIChoice } from '../public/scripts/util/openai-tool-calls.js';

describe('OpenAI-compatible tool-call choice selection', () => {
    test('prefers choice index zero when the provider includes indices', () => {
        const first = { index: 0, message: { content: 'normal response' } };
        const second = { index: 1, message: { tool_calls: [{ id: 'secondary-call' }] } };

        expect(selectOpenAIChoice({ choices: [second, first] })).toBe(first);
    });

    test('finds the tool-call choice when the provider omits choice indices', () => {
        const choice = { message: { tool_calls: [{ id: 'call-1', function: { name: 'memory_search', arguments: '{}' } }] } };

        expect(selectOpenAIChoice({ choices: [choice] })).toBe(choice);
    });

    test('returns the first choice if no choice contains tool calls or an index', () => {
        const choice = { message: { content: 'plain text' } };

        expect(selectOpenAIChoice({ choices: [choice] })).toBe(choice);
    });

    test('returns null when choices are missing or empty', () => {
        expect(selectOpenAIChoice({})).toBeNull();
        expect(selectOpenAIChoice({ choices: [] })).toBeNull();
    });
});
