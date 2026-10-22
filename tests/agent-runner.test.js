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
        executeToolCalls: async (data, options) => {
            calls.executed.push({ data, options });
            return overrides.execution
                ? await overrides.execution(data, options, calls)
                : { invocations: [{ id: 'tool-' + calls.executed.length, name: 'mock_tool', result: { ok: true } }], errors: [], stealthCalls: [] };
        },
        saveToolInvocations: async invocations => calls.saved.push(invocations),
        setToolCallsAllowed: allowed => calls.policies.push(allowed),
        onToolErrors: errors => calls.errors.push(errors),
        onStop: type => calls.stops.push(type),
    });
    return { runner, calls };
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
                        responseData: { step: steps.length },
                    };
                }
                return 'final narrative';
            },
        });

        expect(result).toBe('final narrative');
        expect(steps.map(step => step.type)).toEqual(['regenerate', 'normal', 'normal']);
        expect(steps.map(step => step.options.depth)).toEqual([0, 1, 2]);
        expect(steps.every(step => step.options.force_name2 === true)).toBe(true);
        expect(calls.executed.map(item => item.data.step)).toEqual([1, 2]);
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
                    ? { __sillyAgentRunner: true, kind: 'tool_calls', responseData: { step: modelSteps } }
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
            execution: async () => ({ invocations: [], errors: [new Error('invalid tool')], stealthCalls: [] }),
        });
        const result = await runner.run({
            type: 'normal',
            generateStep: async () => ({ __sillyAgentRunner: true, kind: 'tool_calls', responseData: { tool: true } }),
        });

        expect(result).toBeUndefined();
        expect(calls.errors).toHaveLength(1);
        expect(calls.stops).toEqual(['normal']);
        expect(calls.executed).toHaveLength(1);
    });

    test('limits the final dispatch to remaining turn-wide tool budget', async () => {
        const { runner, calls } = makeRunner({
            execution: async (_data, options) => ({
                invocations: Array.from({ length: options.maxCalls }, (_, index) => ({
                    id: 'mock-' + index, name: 'mock_tool', result: { ok: true },
                })),
                errors: [],
                stealthCalls: [],
            }),
        });
        let steps = 0;
        const result = await runner.run({
            type: 'normal',
            generateStep: async (_type, _options, policy) => {
                steps += 1;
                return policy.allowToolCalls
                    ? { __sillyAgentRunner: true, kind: 'tool_calls', responseData: { step: steps } }
                    : 'final after global call budget';
            },
        });

        expect(result).toBe('final after global call budget');
        expect(calls.executed).toHaveLength(1);
        expect(calls.executed[0].options.maxCalls).toBe(SillyAgentRunner.MAX_TOOL_CALLS);
        expect(calls.saved[0]).toHaveLength(SillyAgentRunner.MAX_TOOL_CALLS);
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
