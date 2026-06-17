import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Tool as McpTool } from '@modelcontextprotocol/sdk/types.js';
import { config } from '../config.js';

/**
 * A thin wrapper around an MCP client connected to the Lumos user MCP server.
 *
 * The only Lumos-specific detail lives here: we authenticate with the **API key
 * (Bearer) method** by attaching `Authorization: Bearer <LUMOS_API_KEY>` to every
 * HTTP request the transport makes. The Lumos MCP server validates the key and
 * runs each tool call as the user that owns it. (The server also supports per-user
 * OAuth with dynamic client registration; this bot uses an API key because a
 * per-user browser flow is awkward to run inside a Slack bot.)
 *
 * Transport is streamable HTTP, which is exactly what
 * `StreamableHTTPClientTransport` speaks.
 */
export class LumosMcpClient {
  private client: Client;
  private transport: StreamableHTTPClientTransport;
  private connected = false;
  private toolsCache?: McpTool[];

  constructor() {
    this.transport = new StreamableHTTPClientTransport(new URL(config.lumos.mcpUrl), {
      requestInit: {
        headers: {
          Authorization: `Bearer ${config.lumos.apiKey}`,
        },
      },
    });

    this.client = new Client(
      { name: 'lumos-mcp-slack-bot', version: '1.0.0' },
      { capabilities: {} },
    );
  }

  /** Connect (idempotent) and run the MCP initialize handshake. */
  async connect(): Promise<void> {
    if (this.connected) return;
    await this.client.connect(this.transport);
    this.connected = true;
  }

  /**
   * Fetch the tools the server exposes, as MCP tool definitions. The result is
   * memoized: the tool set is static for the life of the process, and this is
   * called on the hot path (every user turn), so we avoid a remote `tools/list`
   * round-trip each time. Only successful fetches are cached.
   */
  async listTools(): Promise<McpTool[]> {
    if (this.toolsCache) return this.toolsCache;
    await this.connect();
    const { tools } = await this.client.listTools();
    this.toolsCache = tools;
    return tools;
  }

  /**
   * Invoke a tool by name. Returns the textual content blocks joined together,
   * plus whether the server flagged the result as an error.
   */
  async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ text: string; isError: boolean }> {
    await this.connect();
    const result = await this.client.callTool({ name, arguments: args });

    const content = Array.isArray(result.content) ? result.content : [];
    const text = content
      .map((block) => {
        if (block.type === 'text') return block.text;
        // Surface any non-text block in a debuggable form rather than dropping it.
        return JSON.stringify(block);
      })
      .join('\n')
      .trim();

    return { text: text || '(empty response)', isError: result.isError === true };
  }

  async close(): Promise<void> {
    if (!this.connected) return;
    await this.client.close();
    this.connected = false;
  }
}
