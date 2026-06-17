import { config } from './config.js';
import { LumosAgent } from './agent/agent.js';
import { LumosMcpClient } from './mcp/client.js';
import { createApp } from './slack/app.js';
import { registerListeners } from './slack/listeners.js';

async function main() {
  console.log('🔐 Lumos MCP Slack bot starting…');

  // 1. Connect to the Lumos user MCP server with the API key (Bearer) method.
  const mcp = new LumosMcpClient();
  try {
    const tools = await mcp.listTools();
    console.log(
      `[lumos-bot] Connected to Lumos MCP at ${config.lumos.mcpUrl}. ` +
        `Tools: ${tools.map((t) => t.name).join(', ') || '(none)'}`,
    );
  } catch (err) {
    console.warn(
      `[lumos-bot] WARNING: could not reach the Lumos MCP server at ${config.lumos.mcpUrl}. ` +
        'Check LUMOS_MCP_URL and LUMOS_API_KEY. Starting anyway; tool calls will report errors.',
      err,
    );
  }

  console.log(
    config.lumos.actAsSlackUser
      ? '[lumos-bot] Acting-as mode ON — requests are filed for the Slack user via for_user. ' +
          'Requires the API key to belong to a Lumos admin.'
      : '[lumos-bot] Acting-as mode OFF — requests are filed as the API key owner (single identity).',
  );

  // 2. The Claude agent that turns natural language into MCP tool calls.
  const agent = new LumosAgent(mcp);

  // 3. Slack app (Socket Mode) + listeners.
  const app = createApp();
  registerListeners(app, agent);
  console.log('[lumos-bot] Slack listeners registered');

  // 4. Go.
  await app.start();
  console.log('✅ Lumos MCP Slack bot is running. Mention it in a channel or DM it.');

  const shutdown = async () => {
    console.log('\n[lumos-bot] Shutting down…');
    await app.stop();
    await mcp.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  console.error('[lumos-bot] Fatal error during startup:', error);
  process.exit(1);
});
