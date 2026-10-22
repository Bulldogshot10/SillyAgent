import { afterEach, describe, expect, jest, test } from '@jest/globals';

import { SillyAgentRunner } from '../public/scripts/agent-runner.js';

function makeRunner(overrides = {}, runnerOptions = {}) {
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
        onToolErrors: errors => calls.errors.push(errors),
        onStop: type => calls.stops.push(type),
        ...runnerOptions,
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
        expect(steps.map(step => step.policy.allowToolCalls)).toEqual([true, true, true]);
    });

    test('turns off tool schemas after the round budget and performs a final tool-free generation', async () => {
        const { runner, calls } = makeRunner();
        let modelSteps = 0;
        const policies = [];
        const result = await runner.run({
            type: 'normal',
            generateStep: async (_type, _options, policy) => {
                policies.push(policy.allowToolCalls);
                modelSteps += 1;
                return policy.allowToolCalls
                    ? { __sillyAgentRunner: true, kind: 'tool_calls', responseData: [toolCall('step-' + modelSteps)] }
                    : 'budgeted final answer';
            },
        });

        expect(result).toBe('budgeted final answer');
        expect(modelSteps).toBe(SillyAgentRunner.MAX_TOOL_ROUNDS + 1);
        expect(calls.executed).toHaveLength(SillyAgentRunner.MAX_TOOL_ROUNDS);
        expect(policies).toHaveLength(SillyAgentRunner.MAX_TOOL_ROUNDS + 1);
        expect(policies.slice(0, -1).every(Boolean)).toBe(true);
        expect(policies.at(-1)).toBe(false);
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

    test('turns thrown dispatch errors and malformed calls into model-visible tool results', async () => {
        const { runner, calls } = makeRunner({
            execution: async () => {
                throw new Error('dispatcher unavailable');
            },
        });
        let steps = 0;
        const result = await runner.run({
            type: 'normal',
            generateStep: async () => {
                steps += 1;
                if (steps === 1) {
                    return {
                        __sillyAgentRunner: true,
                        kind: 'tool_calls',
                        responseData: [
                            toolCall('throws'),
                            { id: 'malformed', function: { arguments: {} } },
                        ],
                    };
                }
                return 'recovered final answer';
            },
        });

        expect(result).toBe('recovered final answer');
        expect(calls.saved[0]).toHaveLength(2);
        expect(calls.saved[0].every(invocation => invocation.error)).toBe(true);
        expect(calls.saved[0][0].result).toContain('dispatcher unavailable');
        expect(calls.saved[0][1].name).toBe('unknown_tool');
        expect(calls.errors).toHaveLength(1);
    });

    test('stops between tool dispatch and the next model round when cancelled', async () => {
        let cancelled = false;
        const stop = jest.fn();
        const { runner, calls } = makeRunner({
            execution: async (toolCall, _options, state) => {
                state.executed.push({ cancelledDuringCall: toolCall.id });
                cancelled = true;
                return {
                    invocation: {
                        id: toolCall.id,
                        name: toolCall.function.name,
                        parameters: '{}',
                        result: 'completed before cancellation',
                        error: false,
                    },
                };
            },
        }, {
            shouldStop: () => cancelled,
            onStop: stop,
        });
        let modelRounds = 0;

        const result = await runner.run({
            type: 'normal',
            generateStep: async () => {
                modelRounds += 1;
                return {
                    __sillyAgentRunner: true,
                    kind: 'tool_calls',
                    responseData: [toolCall('cancel-after-this')],
                };
            },
        });

        expect(result).toBeUndefined();
        expect(modelRounds).toBe(1);
        expect(calls.saved).toHaveLength(1);
        expect(stop).toHaveBeenCalledWith('normal');
    });

    test('unlocks the generation UI when tool-result persistence fails', async () => {
        const stop = jest.fn();
        const { runner } = makeRunner({}, {
            saveToolInvocations: async () => {
                throw new Error('chat persistence failed');
            },
            onStop: stop,
        });

        await expect(runner.run({
            type: 'normal',
            generateStep: async () => ({
                __sillyAgentRunner: true,
                kind: 'tool_calls',
                responseData: [toolCall('persist-failure')],
            }),
        })).rejects.toThrow('chat persistence failed');

        expect(stop).toHaveBeenCalledWith('normal');
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

    test('keeps concurrent runs on independent per-turn budgets without shared mutable gates', async () => {
        const { runner: shortRunner } = makeRunner({}, { maxToolRounds: 1 });
        const { runner: longRunner } = makeRunner({}, { maxToolRounds: 2 });
        const shortPolicies = [];
        const longPolicies = [];

        const runWithPolicyHistory = async (runner, history) => runner.run({
            type: 'normal',
            generateStep: async (_type, _options, policy) => {
                history.push(policy.allowToolCalls);
                return policy.allowToolCalls
                    ? { __sillyAgentRunner: true, kind: 'tool_calls', responseData: [toolCall('call-' + history.length)] }
                    : 'final';
            },
        });

        const [shortResult, longResult] = await Promise.all([
            runWithPolicyHistory(shortRunner, shortPolicies),
            runWithPolicyHistory(longRunner, longPolicies),
        ]);

        expect(shortResult).toBe('final');
        expect(longResult).toBe('final');
        expect(shortPolicies).toEqual([true, false]);
        expect(longPolicies).toEqual([true, true, false]);
    });

    test('forces excluded generation modes to single-step tool-free behavior', async () => {
        const { runner, calls } = makeRunner();
        const policies = [];
        const result = await runner.run({
            type: 'quiet',
            generateStep: async (_type, _options, policy) => {
                policies.push(policy.allowToolCalls);
                expect(policy.allowToolCalls).toBe(false);
                return 'quiet output';
            },
        });

        expect(result).toBe('quiet output');
        expect(calls.executed).toHaveLength(0);
        expect(policies).toEqual([false]);
    });

    test('unlocks generation UI when a provider round throws before returning a handoff', async () => {
        const stop = jest.fn();
        const { runner } = makeRunner({}, { onStop: stop });

        await expect(runner.run({
            type: 'normal',
            generateStep: async () => {
                throw new Error('provider preprocessing failed');
            },
        })).rejects.toThrow('provider preprocessing failed');

        expect(stop).toHaveBeenCalledTimes(1);
        expect(stop).toHaveBeenCalledWith('normal');
    });

    test('stops dispatching a model batch after a stealth tool terminates the turn', async () => {
        const { runner, calls } = makeRunner({
            execution: async toolCall => toolCall.id === 'stealth'
                ? { stealth: true }
                : {
                    invocation: {
                        id: toolCall.id,
                        name: toolCall.function.name,
                        parameters: '{}',
                        result: 'should not run',
                        error: false,
                    },
                },
        });
        let modelRounds = 0;

        const result = await runner.run({
            type: 'normal',
            generateStep: async () => {
                modelRounds += 1;
                return {
                    __sillyAgentRunner: true,
                    kind: 'tool_calls',
                    responseData: [toolCall('stealth'), toolCall('must-not-run')],
                };
            },
        });

        expect(result).toBeUndefined();
        expect(modelRounds).toBe(1);
        expect(calls.executed).toHaveLength(1);
        expect(calls.executed[0].toolCall.id).toBe('stealth');
    });
});
