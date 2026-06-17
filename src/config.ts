import 'dotenv/config';

function required(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function optional(key: string, defaultValue: string): string {
  return process.env[key] || defaultValue;
}

function optionalInt(key: string, defaultValue: number): number {
  const value = process.env[key];
  return value ? Number.parseInt(value, 10) : defaultValue;
}

function optionalBool(key: string, defaultValue: boolean): boolean {
  const value = process.env[key];
  if (value === undefined) return defaultValue;
  return /^(1|true|yes|on)$/i.test(value.trim());
}

export const config = Object.freeze({
  slack: {
    botToken: required('SLACK_BOT_TOKEN'),
    appToken: required('SLACK_APP_TOKEN'),
    signingSecret: required('SLACK_SIGNING_SECRET'),
  },
  anthropic: {
    apiKey: required('ANTHROPIC_API_KEY'),
    // Default to a current, capable Claude model. Override via env if desired.
    model: optional('ANTHROPIC_MODEL', 'claude-sonnet-4-6'),
    maxTokens: optionalInt('ANTHROPIC_MAX_TOKENS', 1024),
    // Safety cap on how many tool-call round-trips one user turn can take.
    maxToolIterations: optionalInt('ANTHROPIC_MAX_TOOL_ITERATIONS', 8),
  },
  lumos: {
    // The Lumos *user* MCP server. The trailing slash is handled server-side.
    mcpUrl: optional('LUMOS_MCP_URL', 'https://api.lumos.com/mcp/user'),
    // A Lumos API key. Sent verbatim as `Authorization: Bearer <key>`. The MCP
    // server validates it and runs tool calls as the user that owns the key.
    apiKey: required('LUMOS_API_KEY'),
    // The Lumos web app, used for "do it in the browser" hand-offs (things the MCP
    // server can't do: removing/modifying/extending access, approvals, etc.).
    webUrl: optional('LUMOS_WEB_URL', 'https://app.lumosidentity.com'),
    // Act on behalf of the Slack user who's chatting (default). Resolves their
    // verified Slack email and passes it as `for_user` on every tool that supports
    // it, so requests are filed for the right person. REQUIRES the API key to
    // belong to a Lumos admin. Set to false to act as a single fixed identity
    // (the key owner) — use that with a non-admin key.
    actAsSlackUser: optionalBool('LUMOS_ACT_AS_SLACK_USER', true),
  },
  bot: {
    // Append a small "Lumos MCP calls: ..." trace under each reply. Useful for
    // demos so you can see the tool calls happening; turn off for a cleaner
    // end-user experience.
    showToolTrace: optionalBool('SHOW_TOOL_TRACE', true),
  },
});

export type Config = typeof config;
