import Anthropic from '@anthropic-ai/sdk';
import type { Tool as McpTool } from '@modelcontextprotocol/sdk/types.js';
import { config } from '../config.js';
import type { LumosMcpClient } from '../mcp/client.js';

function intro(webUrl: string): string {
  return `You are the Lumos access assistant, running inside Slack.

You help people get software access through Lumos via the Lumos user MCP server:
searching the app catalog, finding requestable permissions, and submitting access
requests to grant new access. The tools available to you are provided with this
request — use them.

You can only GRANT new access. You cannot remove, modify, downgrade, extend, or approve
access, and you cannot see other people's requests. When someone wants any of that — or
would simply rather handle it themselves — don't dead-end them; point them to the Lumos
web app: ${webUrl}`;
}

function guidance(webUrl: string): string {
  return `How to behave:
- You're in Slack, often a *public channel* where coworkers can see the exchange. Keep
  replies short and skimmable (Slack mrkdwn: *bold* not **bold**, • bullets; never raw
  JSON), and don't drag people through a long back-and-forth.
- Default to least privilege, but stay practical: aim for the fastest reasonable path to
  the *narrowest* request that actually covers what they asked for. Resolve it yourself —
  search, then pick the least-privileged permission that satisfies the stated need (prefer
  read/read-only over write/admin unless they clearly need more) and submit. Don't pad a
  request with access they didn't ask for. Ask a clarifying question ONLY when you
  genuinely cannot proceed (e.g. several clearly different apps or permission levels match
  and nothing indicates which), and keep it to one short question.
- Prefer sensible, conservative defaults over questions for most fields. If they didn't
  give a duration, infer one from the nature of the request rather than asking, and lean
  toward the smallest window that fits: a time-boxed option when the work is clearly
  temporary (debugging an incident, a one-off task, "for the sprint"), and *Unlimited*
  only when the access is genuinely ongoing/standing — an app they'll use as a regular
  part of their role. When it's a close call, prefer the shorter, renewable option over
  standing access. Whatever you pick, tell them which duration and why, and list the other
  durations the tool offered so they can course-correct.
- Business justification matters most: it's shown to approvers, so every request should
  carry a real reason. First try to infer it from what they already told you — e.g. "I'm
  debugging the prod incident" -> justification "Debugging a production incident." Use
  their own wording and stated purpose; never invent specifics or inflate urgency. Only
  when they've given you genuinely nothing to base a reason on, ask one short follow-up
  for the business justification BEFORE submitting — don't file a request with an empty or
  made-up justification.
- After submitting, briefly state what you requested — app, permission, duration, and the
  justification used — so it's on the record and they can correct course if needed.
- Mechanics: search -> list_requestable_permissions (to read request_mode and the
  durations actually offered) -> submit. Never invent durations or permission ids.
- If a tool says they already have access or a pending request, say so instead of
  filing a duplicate.
- If you hit something you can't do here, hand off to the Lumos web app (${webUrl})
  rather than just refusing.`;
}

/** The identity paragraph depends on whether we're acting as the Slack user. */
function identitySection(actingAsEmail?: string): string {
  if (actingAsEmail) {
    return `Identity: you are acting on behalf of the Slack user you're chatting with, whose
Lumos identity is ${actingAsEmail}. Everything you do — searching apps, finding
requestable permissions, submitting requests, and listing existing requests — is scoped
to that person via the for_user parameter, which is set automatically from their verified
Slack email. You never need to ask who something is for, and must not set or change
for_user yourself.`;
  }
  return `Identity: you are authenticated as one fixed Lumos account — the user who created the
configured API key. You do NOT know the Lumos identity of the Slack person chatting with
you and cannot act as them; every request is filed under the API key's owner, whoever
sent the message. If someone says "request access for me," clarify that the request will
be created for the configured Lumos account, not their personal one.`;
}

function buildSystemPrompt(actingAsEmail?: string): string {
  const webUrl = config.lumos.webUrl;
  return `${intro(webUrl)}\n\n${identitySection(actingAsEmail)}\n\n${guidance(webUrl)}`;
}

export interface ToolCallSummary {
  name: string;
  input: Record<string, unknown>;
  isError: boolean;
  /** Optional `telemetry.intent` the model attached to the call, for the trace. */
  intent?: string;
}

export interface AgentResult {
  /** The assistant's final natural-language reply. */
  text: string;
  /** Updated conversation history to persist for this thread. */
  messages: Anthropic.MessageParam[];
  /** What tools were invoked this turn (for an optional Slack "trace"). */
  toolCalls: ToolCallSummary[];
}

/** Convert MCP tool definitions into Anthropic tool definitions. */
function toAnthropicTools(tools: McpTool[]): Anthropic.Tool[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema as Anthropic.Tool.InputSchema,
  }));
}

/** Pull an optional `telemetry.intent` string out of a tool's input, if present. */
function extractIntent(input: Record<string, unknown>): string | undefined {
  const telemetry = (input as { telemetry?: { intent?: unknown } }).telemetry;
  return typeof telemetry?.intent === 'string' ? telemetry.intent : undefined;
}

/** Whether an MCP tool's input schema declares a `for_user` parameter. */
function supportsForUser(inputSchema: unknown): boolean {
  const props = (inputSchema as { properties?: Record<string, unknown> } | null)?.properties;
  return !!props && Object.prototype.hasOwnProperty.call(props, 'for_user');
}

/** Pull the plain-text content out of an assistant message. */
function extractText(content: Anthropic.ContentBlock[]): string {
  return content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

export class LumosAgent {
  private anthropic: Anthropic;

  constructor(private mcp: LumosMcpClient) {
    this.anthropic = new Anthropic({ apiKey: config.anthropic.apiKey });
  }

  /**
   * Run one user turn through Claude, letting it call Lumos MCP tools until it
   * produces a final answer. `history` is the prior conversation for this thread.
   *
   * When `opts.actingAsEmail` is set, the bot acts on behalf of that Slack user:
   * `for_user` is forced to their verified email on every tool (never taken from the
   * model or the message text). Only tools that support for_user are exposed in this
   * mode, so nothing can run unscoped as the service account — as of the current user
   * MCP server, that's every tool.
   */
  async run(
    userText: string,
    history: Anthropic.MessageParam[] = [],
    opts: { actingAsEmail?: string } = {},
  ): Promise<AgentResult> {
    const { actingAsEmail } = opts;
    const mcpTools = await this.mcp.listTools();

    // Tools that accept a for_user parameter, per their live MCP input schema.
    const forUserTools = new Set(
      mcpTools.filter((t) => supportsForUser(t.inputSchema)).map((t) => t.name),
    );
    // In acting-as mode only expose tools we can scope to the target via for_user,
    // so nothing runs unscoped as the service account. (Currently every tool
    // supports it, so none are withheld.)
    const exposedTools = actingAsEmail
      ? mcpTools.filter((t) => forUserTools.has(t.name))
      : mcpTools;
    const tools = toAnthropicTools(exposedTools);
    const system = buildSystemPrompt(actingAsEmail);

    // Full working transcript for this turn. It includes the tool_use/tool_result
    // exchanges Claude needs in order to reason, but which we deliberately do NOT
    // persist as history (see the `messages` we return below).
    const working: Anthropic.MessageParam[] = [
      ...history,
      { role: 'user', content: userText },
    ];
    const toolCalls: ToolCallSummary[] = [];
    let finalText =
      "I wasn't able to finish that in time — could you narrow the request a bit?";

    for (let iteration = 0; iteration < config.anthropic.maxToolIterations; iteration++) {
      const response = await this.anthropic.messages.create({
        model: config.anthropic.model,
        max_tokens: config.anthropic.maxTokens,
        system,
        tools,
        messages: working,
      });

      working.push({ role: 'assistant', content: response.content });

      if (response.stop_reason !== 'tool_use') {
        finalText = extractText(response.content) || '(no response)';
        break;
      }

      // Execute every tool_use block Claude requested, in order.
      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const block of response.content) {
        if (block.type !== 'tool_use') continue;

        // Clone so we don't mutate the model's recorded tool_use block.
        const input = { ...((block.input ?? {}) as Record<string, unknown>) };
        // The model must NEVER choose who a request is for. We set for_user
        // entirely server-side: in acting-as mode force the sender's verified Slack
        // email; otherwise strip any for_user the model tried to pass so the call
        // runs as the key owner. This matters because an admin API key lets the MCP
        // server honor ANY for_user value — the bot is the only gatekeeper.
        if (actingAsEmail && forUserTools.has(block.name)) {
          input.for_user = actingAsEmail;
        } else {
          delete input.for_user;
        }
        let resultText: string;
        let isError: boolean;
        try {
          const result = await this.mcp.callTool(block.name, input);
          resultText = result.text;
          isError = result.isError;
        } catch (err) {
          resultText = `Tool call failed: ${err instanceof Error ? err.message : String(err)}`;
          isError = true;
        }

        toolCalls.push({ name: block.name, input, isError, intent: extractIntent(input) });
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: resultText,
          is_error: isError,
        });
      }

      working.push({ role: 'user', content: toolResults });
    }

    // Persist only the clean conversational turn: the user's text and the final
    // answer. We drop the intermediate tool_use/tool_result blocks on purpose —
    // keeping them means history can be trimmed mid-pair, which the Messages API
    // rejects ("each tool_result block must have a corresponding tool_use block").
    // Follow-ups still work: the assistant's summarized replies stay in history,
    // and any data needed again is re-fetched by calling the tools again.
    const messages: Anthropic.MessageParam[] = [
      ...history,
      { role: 'user', content: userText },
      { role: 'assistant', content: finalText },
    ];

    return { text: finalText, messages, toolCalls };
  }
}
