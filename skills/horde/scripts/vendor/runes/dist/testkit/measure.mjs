/**
 * How much context a server's `tools/list` costs a client, measured in CI and reported as a warning, never a failure: the size of the list is a quality resource, and so is the accuracy of tool calls, so a budget overrun is a signal to look, not a gate.
 *
 * Tokens are estimated from characters (default four per token, a common rule for English and JSON); Runes has no tokenizer and no dependency to bring one. The estimate is for comparing a server with itself over time and against its budget, not for billing.
 */
/** Measures a `tools/list` result (the `tools` array). */
export function measureTools(tools, options = {}) {
    const { budgetTokens = 8_500, charsPerToken = 4, label = 'tools/list' } = options;
    const est = (chars) => Math.ceil(chars / charsPerToken);
    const chars = JSON.stringify({ tools }).length;
    const tokens = est(chars);
    const perTool = tools.map((t) => { const c = JSON.stringify(t).length; return { name: t.name, chars: c, tokens: est(c) }; }).sort((a, b) => b.chars - a.chars);
    const over = tokens > budgetTokens;
    const top = perTool.slice(0, 3).map((t) => `${t.name} ≈${t.tokens}`).join(', ');
    return { chars, tokens, budgetTokens, over, perTool, warning: over ? `${label}: ≈${tokens} tokens for ${tools.length} tools, over the budget of ${budgetTokens} (largest: ${top})` : null };
}
/** One line for a CI log: the size, the budget, and the warning when over. */
export function formatToolsMeasure(m, label = 'tools/list') {
    return m.warning ?? `${label}: ≈${m.tokens} tokens for ${m.perTool.length} tools (${m.chars} chars), within the budget of ${m.budgetTokens}`;
}
