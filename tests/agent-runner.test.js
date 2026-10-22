import { afterEach, describe, expect, jest, test } from '@jest/globals';

import { SillyAgentRunner } from '../public/scripts/agent-runner.js';

function makeRunner(overrides = {}) {
    const calls = {
        executed: [],
        saved: [],
        policies: [],
        errors: [],
        stops: [],
    };
    const runner = new SillyAgentRunner({
        extractToolCalls: data => Array.isArray(data) ? data : (data?.calls ?? []),
        executeToolCall: async (toolCall, options) => {
            calls.executed.push({ toolCall, options });
            if (overrides.execution) return await overrides.execution(toolCall, options, calls);
            return {
                invocation: {
                    id: toolCall.id,
                    name: toolCall.function.name,
                    parameters: JSON.stringify(toolCall.function.arguments),
                    result: { ok: true },
                    error: false,
                },
            };
        },
        saveToolInvocations: async invocations => calls.saved.push(invocations),
        setToolCallsAllowed: allowed => calls.policies.push(allowed),
        onToolErrors: errors => calls.errors.push(errors),
        onStop: type => calls.stops.push(type),
    });
    return { runner, calls };
}

function toolCall(id, args = {}) {
    return { id, function: { name: 'mock_tool', arguments: args } };
}

describe('SillyAgentRunner', () => {
    afterEach(() => jest.restoreAllMocks());

    test('owns multiple tool rounds and continues with normal generation after the first response', async () => {
        const { runner, calls } = makeRunner();
        const steps = [];
        const result = await runner.run({
            type: 'regenerate',
            generationOptions: { depth: 0, force_name2: true },
            generateStep: async (type, options, policy) => {
                steps.push({ type, options, policy });
                if (steps.length < 3) {
                    return {
                        __sillyAgentRunner: true,
                        kind: 'tool_calls',
                        responseData: [toolCall('tool-' + steps.length, { step: steps.length })],
                    };
                }
                return 'final narrative';
            },
        });

        expect(result).toBe('final narrative');
        expect(steps.map(step => step.type)).toEqual(['regenerate', 'normal', 'normal']);
        expect(steps.map(step => step.options.depth)).toEqual([0, 1, 2]);
        expect(steps.every(step => step.options.force_name2 === true)).toBe(true);
        expect(calls.executed.map(item => item.toolCall.function.arguments.step)).toEqual([1, 2]);
        expect(calls.saved).toHaveLength(2);
        expect(calls.policies).toEqual([true, true, true, true]);
    });

    test('turns off tool schemas after the round budget and performs a final tool-free generation', async () => {
        const { runner, calls } = makeRunner();
        let modelSteps = 0;
        const result = await runner.run({
            type: 'normal',
            generateStep: async (_type, _options, policy) => {
                modelSteps += 1;
                return policy.allowToolCalls
                    ? { __sillyAgentRunner: true, kind: 'tool_calls', responseData: [toolCall('step-' + modelSteps)] }
                    : 'budgeted final answer';
            },
        });

        expect(result).toBe('budgeted final answer');
        expect(modelSteps).toBe(SillyAgentRunner.MAX_TOOL_ROUNDS + 1);
        expect(calls.executed).toHaveLength(SillyAgentRunner.MAX_TOOL_ROUNDS);
        expect(calls.policies.at(-2)).toBe(false);
        expect(calls.policies.at(-1)).toBe(true);
    });

    test('does not spin if dispatch produces no user-visible tool results', async () => {
        const { runner, calls } = makeRunner({
            execution: async () => ({ error: new Error('invalid tool') }),
        });
        const result = await runner.run({
            type: 'normal',
            generateStep: async () => ({ __sillyAgentRunner: true, kind: 'tool_calls', responseData: [toolCall('invalid')] }),
        });

        expect(result).toBeUndefined();
        expect(calls.errors).toHaveLength(1);
        expect(calls.stops).toEqual(['normal']);
        expect(calls.executed).toHaveLength(1);
    });

    test('caps executed calls across the entire turn and records skipped calls', async () => {
        const { runner, calls } = makeRunner();
        let steps = 0;
        const lotsOfCalls = Array.from({ length: SillyAgentRunner.MAX_TOOL_CALLS + 6 }, (_, index) => toolCall('bulk-' + index));
        const result = await runner.run({
            type: 'normal',
            generateStep: async (_type, _options, policy) => {
                steps += 1;
                return policy.allowToolCalls
                    ? { __sillyAgentRunner: true, kind: 'tool_calls', responseData: lotsOfCalls }
                    : 'final after global call budget';
            },
        });

        expect(result).toBe('final after global call budget');
        expect(calls.executed).toHaveLength(SillyAgentRunner.MAX_TOOL_CALLS);
        expect(calls.saved[0]).toHaveLength(SillyAgentRunner.MAX_TOOL_CALLS + 1);
        expect(calls.saved[0].at(-1).name).toBe('agent_tool_budget');
        expect(calls.errors).toHaveLength(1);
        expect(steps).toBe(2);
    });

    test('forces excluded generation modes to single-step tool-free behavior', async () => {
        const { runner, calls } = makeRunner();
        const result = await runner.run({
            type: 'quiet',
            generateStep: async (_type, _options, policy) => {
                expect(policy.allowToolCalls).toBe(false);
                return 'quiet output';
            },
        });

        expect(result).toBe('quiet output');
        expect(calls.executed).toHaveLength(0);
        expect(calls.policies).toEqual([false, true]);
    });
});
