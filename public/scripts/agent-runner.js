/**
 * SillyAgent's native model/tool orchestration loop.
 *
 * Provider adapters normalize vendor response formats, but this runner owns
 * the cycle: request -> bounded tool dispatch -> persist tool results -> request
 * again. It does not call SillyTavern's recursive tool-execution loop.
 */
export class SillyAgentRunner {
    static MAX_TOOL_ROUNDS = 8;
    static MAX_TOOL_CALLS = 24;

    #extractToolCalls;
    #executeToolCall;
    #saveToolInvocations;
    #setToolCallsAllowed;
    #onToolErrors;
    #onStop;

    constructor({
        extractToolCalls,
        executeToolCall,
        saveToolInvocations,
        setToolCallsAllowed,
        onToolErrors,
        onStop,
    } = {}) {
        if (typeof extractToolCalls !== 'function'
            || typeof executeToolCall !== 'function'
            || typeof saveToolInvocations !== 'function'
            || typeof setToolCallsAllowed !== 'function') {
            throw new TypeError('SillyAgentRunner requires provider normalization, tool dispatch, result persistence, and policy adapters.');
        }

        this.#extractToolCalls = extractToolCalls;
        this.#executeToolCall = executeToolCall;
        this.#saveToolInvocations = saveToolInvocations;
        this.#setToolCallsAllowed = setToolCallsAllowed;
        this.#onToolErrors = typeof onToolErrors === 'function' ? onToolErrors : () => {};
        this.#onStop = typeof onStop === 'function' ? onStop : () => {};
    }

    /**
     * Run one logical assistant turn. Each provider round returns either its
     * normal result or a structured tool-call handoff. The runner decides
     * whether the loop continues and enforces turn-wide budgets.
     * @param {object} options Turn context.
     * @param {string} options.type SillyTavern generation type.
     * @param {object} [options.generationOptions] Existing generation context.
     * @param {boolean} [options.dryRun] Whether this is prompt preview only.
     * @param {Function} options.generateStep Exactly one model round.
     * @returns {Promise<*>} Final generation result.
     */
    async run({ type, generationOptions = {}, dryRun = false, generateStep } = {}) {
        if (typeof generateStep !== 'function') throw new TypeError('A single-step generation function is required.');

        let rounds = 0;
        let toolCallsExecuted = 0;
        const originalDepth = Number.isInteger(generationOptions.depth) ? generationOptions.depth : 0;
        const singleStepOnly = dryRun || ['quiet', 'continue', 'impersonate', 'swipe'].includes(type);

        try {
            while (true) {
                const withinBudget = !singleStepOnly
                    && rounds < SillyAgentRunner.MAX_TOOL_ROUNDS
                    && toolCallsExecuted < SillyAgentRunner.MAX_TOOL_CALLS;
                this.#setToolCallsAllowed(withinBudget);

                const stepType = rounds === 0 ? type : 'normal';
                const result = await generateStep(stepType, {
                    ...generationOptions,
                    depth: originalDepth + rounds,
                }, { allowToolCalls: withinBudget, round: rounds });

                if (!result || result.__sillyAgentRunner !== true || result.kind !== 'tool_calls') {
                    return result;
                }

                if (!withinBudget) {
                    this.#onStop(stepType);
                    return undefined;
                }

                const modelToolCalls = this.#extractToolCalls(result.responseData);
                if (!Array.isArray(modelToolCalls) || modelToolCalls.length === 0) {
                    this.#onStop(stepType);
                    return undefined;
                }

                const remainingCalls = SillyAgentRunner.MAX_TOOL_CALLS - toolCallsExecuted;
                const callsToRun = modelToolCalls.slice(0, remainingCalls);
                const skippedCalls = modelToolCalls.length - callsToRun.length;
                const invocations = [];
                const errors = [];
                const stealthCalls = [];

                for (const toolCall of callsToRun) {
                    const execution = await this.#executeToolCall(toolCall, {
                        reasoningText: result.reasoningText ?? null,
                    });

                    if (execution?.error instanceof Error) errors.push(execution.error);
                    if (execution?.stealth) {
                        stealthCalls.push(toolCall?.function?.name ?? 'unknown');
                    }
                    if (execution?.invocation) invocations.push(execution.invocation);
                }

                if (skippedCalls > 0) {
                    const budgetError = new Error('SillyAgent reached its total tool-call budget. Some requested calls were not executed.');
                    errors.push(budgetError);
                    invocations.push({
                        id: 'agent-tool-budget-' + Date.now(),
                        displayName: 'SillyAgent tool budget',
                        name: 'agent_tool_budget',
                        parameters: JSON.stringify({ skippedCalls }),
                        result: JSON.stringify({ error: 'tool_call_budget_exceeded', skippedCalls }),
                        error: true,
                        signature: null,
                        reasoning: result.reasoningText ?? null,
                    });
                }

                if (errors.length) this.#onToolErrors(errors);
                toolCallsExecuted += callsToRun.length;

                if (invocations.length > 0) {
                    await this.#saveToolInvocations(invocations);
                }

                // Stealth tools deliberately terminate their turn. Persist any
                // ordinary results from the same batch before stopping. An empty
                // dispatch cannot be allowed to create an infinite model loop.
                if (stealthCalls.length || invocations.length === 0) {
                    this.#onStop(stepType);
                    return undefined;
                }

                rounds += 1;
            }
        } finally {
            this.#setToolCallsAllowed(true);
        }
    }
}
