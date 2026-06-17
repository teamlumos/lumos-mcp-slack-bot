import type { App } from '@slack/bolt';
import type { KnownBlock, WebClient } from '@slack/web-api';
import type Anthropic from '@anthropic-ai/sdk';
import type { LumosAgent } from '../agent/agent.js';
import { config } from '../config.js';
import { formatToolTrace, stripBotMention, toSlackMrkdwn } from './format.js';
import { resolveUserEmail } from './users.js';

/**
 * In-memory per-conversation history so a thread (or DM) keeps context across
 * turns. Keyed by a stable conversation key; trimmed to the most recent turns.
 * For a production deployment you'd persist this (and scope it per Slack user).
 */
const conversations = new Map<string, Anthropic.MessageParam[]>();
const MAX_HISTORY_MESSAGES = 20;

/**
 * The Slack user a thread is "anchored" to — the first person to @-mention the bot
 * there. In a shared channel thread the bot only responds to this user and always
 * acts on their behalf, so other participants can't hijack the session or flip who
 * a request is filed for. (DMs are 1:1, so they don't need this.)
 */
const threadOwners = new Map<string, string>();

/** Claim a thread for `userId` if unowned; return whether `userId` owns it. */
function claimOrCheckOwner(conversationKey: string, userId: string): boolean {
  const owner = threadOwners.get(conversationKey);
  if (owner === undefined) {
    threadOwners.set(conversationKey, userId);
    return true;
  }
  return owner === userId;
}

/** Whether `userId` already owns the thread, without claiming it. */
function isOwner(conversationKey: string, userId: string): boolean {
  return threadOwners.get(conversationKey) === userId;
}

function getHistory(key: string): Anthropic.MessageParam[] {
  return conversations.get(key) ?? [];
}

function saveHistory(key: string, messages: Anthropic.MessageParam[]): void {
  let trimmed = messages.slice(-MAX_HISTORY_MESSAGES);
  // The Messages API requires the conversation to start with a user message.
  if (trimmed.length > 0 && trimmed[0].role !== 'user') {
    trimmed = trimmed.slice(1);
  }
  conversations.set(key, trimmed);
}

interface HandleArgs {
  agent: LumosAgent;
  client: WebClient;
  text: string;
  channel: string;
  /** Slack user id of the sender — used to resolve their email in acting-as mode. */
  slackUserId: string;
  /** Thread to reply into (root ts for channel mentions, may be undefined in DMs). */
  threadTs?: string;
  /** Stable key for conversation continuity. */
  conversationKey: string;
}

async function handleUserMessage({
  agent,
  client,
  text,
  channel,
  slackUserId,
  threadTs,
  conversationKey,
}: HandleArgs): Promise<void> {
  if (!text.trim()) {
    await client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text: 'Hi! Ask me to find an app, discover permissions, or request access — e.g. "request read access to Salesforce".',
    });
    return;
  }

  // In acting-as mode (default), file requests for the Slack user. Resolve their
  // verified email up front; if we can't, bail rather than silently filing the
  // request under the service account.
  let actingAsEmail: string | undefined;
  if (config.lumos.actAsSlackUser) {
    const email = await resolveUserEmail(client, slackUserId);
    if (!email) {
      await client.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text: ":warning: I couldn't read your email from Slack, so I can't act on your behalf. The app needs the `users:read.email` scope (and your profile must have an email). An admin can also disable acting-as mode (`LUMOS_ACT_AS_SLACK_USER=false`).",
      });
      return;
    }
    actingAsEmail = email;
  }

  // Post a placeholder so the user gets instant feedback, then edit it in place.
  const placeholder = await client.chat.postMessage({
    channel,
    thread_ts: threadTs,
    text: ':hourglass_flowing_sand: Checking Lumos…',
  });
  const placeholderTs = placeholder.ts as string;

  try {
    const result = await agent.run(text, getHistory(conversationKey), { actingAsEmail });
    saveHistory(conversationKey, result.messages);

    const answer = toSlackMrkdwn(result.text || '(no response)');
    const blocks: KnownBlock[] = [
      { type: 'section', text: { type: 'mrkdwn', text: answer } },
    ];

    if (config.bot.showToolTrace) {
      const contextLines: string[] = [];
      if (actingAsEmail) contextLines.push(`:bust_in_silhouette: Acting on behalf of *${actingAsEmail}*`);
      if (result.toolCalls.length > 0) contextLines.push(formatToolTrace(result.toolCalls));
      if (contextLines.length > 0) {
        blocks.push({
          type: 'context',
          elements: [{ type: 'mrkdwn', text: contextLines.join('\n') }],
        });
      }
    }

    await client.chat.update({
      channel,
      ts: placeholderTs,
      text: answer,
      blocks,
    });
  } catch (err) {
    console.error('[lumos-bot] Failed to handle message:', err);
    await client.chat.update({
      channel,
      ts: placeholderTs,
      text: `:warning: Something went wrong talking to Lumos: ${
        err instanceof Error ? err.message : String(err)
      }`,
    });
  }
}

export function registerListeners(app: App, agent: LumosAgent): void {
  // Channel usage: someone @-mentions the bot.
  app.event('app_mention', async ({ event, client, context }) => {
    if (!event.user) return;
    // Reply in a thread rooted at the mention (or the existing thread).
    const threadTs = event.thread_ts ?? event.ts;
    const conversationKey = `${event.channel}:${threadTs}`;
    // Anchor the thread to the first person who tags the bot. Ignore mentions from
    // anyone else so a shared thread can't switch who the bot is acting for.
    if (!claimOrCheckOwner(conversationKey, event.user)) return;
    const text = stripBotMention(event.text ?? '', context.botUserId);
    await handleUserMessage({
      agent,
      client,
      text,
      channel: event.channel,
      slackUserId: event.user,
      threadTs,
      conversationKey,
    });
  });

  // Direct messages, plus follow-ups in threads the bot is already part of —
  // so you don't have to re-@-mention it on every reply.
  app.message(async ({ message, client, context }) => {
    // Only plain user messages (skip edits, joins, bot echoes, etc.).
    if (message.subtype !== undefined) return;
    if (!message.text || !message.user) return;
    if (message.user === context.botUserId) return;

    const botUserId = context.botUserId;

    // Direct message: respond to everything in the DM (one rolling conversation).
    if (message.channel_type === 'im') {
      const threadTs = message.thread_ts;
      await handleUserMessage({
        agent,
        client,
        text: stripBotMention(message.text, botUserId),
        channel: message.channel,
        slackUserId: message.user,
        threadTs,
        conversationKey: threadTs ? `${message.channel}:${threadTs}` : message.channel,
      });
      return;
    }

    // Channel / private channel. The app_mention handler already covers mentions,
    // so skip them here to avoid double-replies. Otherwise only continue threads
    // the bot is already engaged in, so it never butts into unrelated chatter.
    const mentionsBot = botUserId ? message.text.includes(`<@${botUserId}>`) : false;
    if (mentionsBot) return;
    if (!message.thread_ts) return;
    const conversationKey = `${message.channel}:${message.thread_ts}`;
    if (!conversations.has(conversationKey)) return;
    // Only the user who anchored the thread drives the bot. Ignore follow-ups from
    // anyone else (and never claim ownership from a non-mention message).
    if (!isOwner(conversationKey, message.user)) return;

    await handleUserMessage({
      agent,
      client,
      text: message.text,
      channel: message.channel,
      slackUserId: message.user,
      threadTs: message.thread_ts,
      conversationKey,
    });
  });
}
