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
    #onToolErrors;
    #maxToolRounds;
    #maxToolCalls;
    #onStop;
    #shouldStop;

    constructor({
        extractToolCalls,
        executeToolCall,
        saveToolInvocations,
        onToolErrors,
        onStop,
        shouldStop,
        maxToolRounds = SillyAgentRunner.MAX_TOOL_ROUNDS,
        maxToolCalls = SillyAgentRunner.MAX_TOOL_CALLS,
    } = {}) {
        if (typeof extractToolCalls !== 'function'
            || typeof executeToolCall !== 'function'
            || typeof saveToolInvocations !== 'function') {
            throw new TypeError('SillyAgentRunner requires provider normalization, tool dispatch, and result persistence adapters.');
        }

        this.#extractToolCalls = extractToolCalls;
        this.#executeToolCall = executeToolCall;
        this.#saveToolInvocations = saveToolInvocations;
        this.#onToolErrors = typeof onToolErrors === 'function' ? onToolErrors : () => {};
        this.#onStop = typeof onStop === 'function' ? onStop : () => {};
        this.#shouldStop = typeof shouldStop === 'function' ? shouldStop : () => false;
        this.#maxToolRounds = Number.isInteger(maxToolRounds)
            ? Math.max(1, Math.min(SillyAgentRunner.MAX_TOOL_ROUNDS, maxToolRounds))
            : SillyAgentRunner.MAX_TOOL_ROUNDS;
        this.#maxToolCalls = Number.isInteger(maxToolCalls)
            ? Math.max(1, Math.min(SillyAgentRunner.MAX_TOOL_CALLS, maxToolCalls))
            : SillyAgentRunner.MAX_TOOL_CALLS;
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
    async run({ type, generationOptions = {}, dryRun = false, signal = null, generateStep } = {}) {
        if (typeof generateStep !== 'function') throw new TypeError('A single-step generation function is required.');

        let rounds = 0;
        let toolCallsExecuted = 0;
        const originalDepth = Number.isInteger(generationOptions.depth) ? generationOptions.depth : 0;
        const singleStepOnly = dryRun || ['quiet', 'continue', 'impersonate', 'swipe'].includes(type);

        let stopNotified = false;
        const notifyStop = generationType => {
            if (stopNotified) return;
            stopNotified = true;
            this.#onStop(generationType);
        };

        try {
            while (true) {
            if (this.#shouldStop()) {
                notifyStop(rounds === 0 ? type : 'normal');
                return undefined;
            }

            const withinBudget = !singleStepOnly
                && rounds < this.#maxToolRounds
                && toolCallsExecuted < this.#maxToolCalls;

            const stepType = rounds === 0 ? type : 'normal';
            const result = await generateStep(stepType, {
                ...generationOptions,
                depth: originalDepth + rounds,
            }, {
                allowToolCalls: withinBudget,
                round: rounds,
                toolCallsRemaining: this.#maxToolCalls - toolCallsExecuted,
            });

            if (!result || result.__sillyAgentRunner !== true || result.kind !== 'tool_calls') {
                return result;
            }

            if (!withinBudget) {
                notifyStop(stepType);
                return undefined;
            }

            const modelToolCalls = this.#extractToolCalls(result.responseData);
            if (!Array.isArray(modelToolCalls) || modelToolCalls.length === 0) {
                notifyStop(stepType);
                return undefined;
            }

            const remainingCalls = this.#maxToolCalls - toolCallsExecuted;
            const callsToRun = modelToolCalls.slice(0, remainingCalls);
            const skippedCalls = modelToolCalls.length - callsToRun.length;
            const invocations = [];
            const errors = [];
            const stealthCalls = [];

            for (const toolCall of callsToRun) {
                if (this.#shouldStop()) break;

                const toolName = typeof toolCall?.function?.name === 'string'
                    ? toolCall.function.name
                    : 'unknown_tool';
                const parameters = toolCall?.function?.arguments ?? {};
                let execution;

                try {
                    if (toolName === 'unknown_tool') {
                        throw new Error('The provider returned a malformed tool call without a function name.');
                    }
                    execution = await this.#executeToolCall(toolCall, {
                        reasoningText: result.reasoningText ?? null,
                        signal,
                    });
                } catch (caught) {
                    const error = caught instanceof Error ? caught : new Error('Tool execution failed.');
                    errors.push(error);
                    invocations.push({
                        id: typeof toolCall?.id === 'string' ? toolCall.id : 'agent-tool-error-' + (toolCallsExecuted + callsToRun.indexOf(toolCall)),
                        displayName: toolName,
                        name: toolName,
                        parameters: typeof parameters === 'string' ? parameters : JSON.stringify(parameters) ?? '{}',
                        result: error.toString(),
                        error: true,
                        signature: toolCall?.signature || null,
                        reasoning: result.reasoningText ?? null,
                    });
                    continue;
                }

                if (execution?.error instanceof Error) errors.push(execution.error);
                if (execution?.stealth) {
                    stealthCalls.push(toolName);
                    // Stealth actions end the agent turn; do not execute later calls in this batch.
                    break;
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

            if (errors.length && !this.#shouldStop()) this.#onToolErrors(errors);
            toolCallsExecuted += callsToRun.length;

            if (invocations.length > 0) {
                try {
                    await this.#saveToolInvocations(invocations);
                } catch (error) {
                    // A persistence failure must not leave SillyTavern's generation UI locked.
                    notifyStop(stepType);
                    throw error;
                }
            }

            if (this.#shouldStop()) {
                notifyStop(stepType);
                return undefined;
            }

            // Stealth tools deliberately terminate their turn. Persist any
            // ordinary results from the same batch before stopping. An empty
            // dispatch cannot be allowed to create an infinite model loop.
            if (stealthCalls.length || invocations.length === 0) {
                notifyStop(stepType);
                return undefined;
            }

            rounds += 1;
            }
        } catch (error) {
            // A provider adapter may throw before its own generation cleanup runs.
            try {
                notifyStop(rounds === 0 ? type : 'normal');
            } catch {
                // Preserve the original provider/dispatch failure.
            }
            throw error;
        }
    }
}
