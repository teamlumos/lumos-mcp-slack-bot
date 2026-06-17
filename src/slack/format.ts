import type { ToolCallSummary } from '../agent/agent.js';

/** Remove the leading bot @-mention(s) from an app_mention message. */
export function stripBotMention(text: string, botUserId: string | undefined): string {
  let cleaned = text;
  if (botUserId) {
    cleaned = cleaned.replace(new RegExp(`<@${botUserId}>`, 'g'), ' ');
  }
  return cleaned.trim();
}

/**
 * Best-effort conversion of common Markdown to Slack mrkdwn. Claude is prompted
 * to emit Slack mrkdwn already; this is a safety net for stray `**bold**` and
 * `[label](url)` links.
 */
export function toSlackMrkdwn(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<$2|$1>')
    .replace(/\*\*([^*]+)\*\*/g, '*$1*');
}

/** A compact, demo-friendly trace of which MCP tools were called this turn. */
export function formatToolTrace(toolCalls: ToolCallSummary[]): string {
  if (toolCalls.length === 0) return '';
  const lines = toolCalls.map((call) => {
    const marker = call.isError ? '⚠️' : '🔧';
    const suffix = call.intent ? ` — _${call.intent}_` : '';
    return `${marker} \`${call.name}\`${suffix}`;
  });
  return `_Lumos MCP calls:_\n${lines.join('\n')}`;
}
