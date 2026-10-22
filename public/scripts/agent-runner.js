/**
 * SillyAgent's native model/tool orchestration loop.
 *
 * Provider adapters still format requests and normalize vendor response formats,
 * but this runner owns the cycle: request -> tool dispatch -> persist result ->
 * request again. It enforces SillyAgent-specific budgets independently of the
 * legacy SillyTavern recursion setting.
 */
export class SillyAgentRunner {
    static MAX_TOOL_ROUNDS = 8;
    static MAX_TOOL_CALLS = 24;

    #executeToolCalls;
    #saveToolInvocations;
    #setToolCallsAllowed;
    #onToolErrors;
    #onStop;

    constructor({
        executeToolCalls,
        saveToolInvocations,
        setToolCallsAllowed,
        onToolErrors,
        onStop,
    } = {}) {
        if (typeof executeToolCalls !== 'function'
            || typeof saveToolInvocations !== 'function'
            || typeof setToolCallsAllowed !== 'function') {
            throw new TypeError('SillyAgentRunner requires tool execution, result persistence, and tool-policy adapters.');
        }

        this.#executeToolCalls = executeToolCalls;
        this.#saveToolInvocations = saveToolInvocations;
        this.#setToolCallsAllowed = setToolCallsAllowed;
        this.#onToolErrors = typeof onToolErrors === 'function' ? onToolErrors : () => {};
        this.#onStop = typeof onStop === 'function' ? onStop : () => {};
    }

    /**
     * Run one logical assistant turn. A generation step returns either its
     * normal value or a structured tool-call handoff. The runner, not the
     * provider adapter, decides whether and when the next model turn begins.
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

                const remainingCalls = SillyAgentRunner.MAX_TOOL_CALLS - toolCallsExecuted;
                const execution = await this.#executeToolCalls(result.responseData, {
                    reasoningText: result.reasoningText ?? null,
                    maxCalls: remainingCalls,
                });

                toolCallsExecuted += execution.invocations.length;
                if (execution.errors.length) this.#onToolErrors(execution.errors);

                // Stealth calls intentionally terminate their turn, matching their
                // contract. An empty dispatch cannot be allowed to spin forever.
                if (execution.stealthCalls.length || execution.invocations.length === 0) {
                    this.#onStop(type);
                    return undefined;
                }

                await this.#saveToolInvocations(execution.invocations);
                rounds += 1;
            }
        } finally {
            this.#setToolCallsAllowed(true);
        }
    }
}
