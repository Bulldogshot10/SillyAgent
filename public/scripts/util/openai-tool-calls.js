/**
 * Select the primary OpenAI-compatible choice for function-call extraction.
 * Some OpenAI-compatible providers omit the optional `index` field.
 * @param {object} data Chat-completions response.
 * @returns {object|null} The primary choice, or null when there are no choices.
 */
export function selectOpenAIChoice(data) {
    const choices = data?.choices;
    if (!Array.isArray(choices) || choices.length === 0) {
        return null;
    }

    const indexedPrimary = choices.find(choice => choice?.index === 0);
    if (indexedPrimary) {
        return indexedPrimary;
    }

    return choices.find(choice => Array.isArray(choice?.message?.tool_calls)) ?? choices[0];
}
