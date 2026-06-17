# Lumos MCP Slack Bot

A small Slack bot that lets people manage their app access in plain English
("_request read access to Salesforce_", "_what have I requested lately?_") by
talking to the Lumos user MCP server.

It demonstrates the API key (Bearer) auth method: the bot sends a single Lumos
API key as `Authorization: Bearer <key>` on every MCP request.

> [!NOTE]
> The Lumos MCP server also supports per-user OAuth with dynamic client
> registration; this bot just deliberately doesn't use it. A browser-based OAuth
> flow is awkward to graft onto a Slack bot (more so a Socket Mode one, which has no
> public callback URL): you'd have to walk each person through a browser login, then
> store and refresh a token per user keyed to their Slack identity. The API key
> method sidesteps all of that — one key, with `for_user` for per-user attribution.
>
> **By default the bot files each request for the Slack user who's chatting.** It
> looks up that user's verified Slack email and passes it as `for_user` on the MCP
> tools, so requests are attributed to the right person. This requires the API key
> to belong to a Lumos admin. Set `LUMOS_ACT_AS_SLACK_USER=false` to instead act as
> a single fixed identity (the key owner). See
> [Who requests are filed for](#who-requests-are-filed-for) for the full picture.

```
Slack  ──mention/DM──▶  Bot  ──Claude (tool use)──▶  Lumos MCP tools
                         │                                  │
                         └────── Authorization: Bearer <LUMOS_API_KEY> ──────┘
                                  (streamable HTTP → https://api.lumos.com/mcp/user)
```

## How it works

1. A user mentions the bot in a channel (`@your-bot request admin on Snowflake`) or
   DMs it.
2. The bot resolves the sender's verified Slack email (for acting-as mode, below).
3. It runs the message through Claude with the Lumos MCP tools attached as tool
   definitions (fetched live via the MCP `tools/list` call).
4. Claude decides which tools to call (`search_apps`, `list_requestable_permissions`,
   `submit_access_request`, …). The bot executes each call against the Lumos MCP
   server over streamable HTTP, authenticating with the API key, and injects
   `for_user` from the sender's email so the request is filed for them.
5. The tool results go back to Claude, which writes a natural-language reply that
   the bot posts back in the Slack thread.

The tools the user MCP server exposes (discovered live at runtime, so this list
tracks whatever the server advertises):

| Tool | What it does |
| --- | --- |
| `search_apps` | Find apps in the Lumos catalog by name. |
| `search_requestable_permissions` | Find requestable permissions by task/capability across apps. |
| `list_requestable_permissions` | List the permissions you can request for one app. |
| `submit_access_request` | Submit a request to **grant** new access. |
| `list_access_requests` | List recent access requests. |

## Prerequisites

- Node.js 20+ (tested on 24)
- A Slack workspace where you can install an app
- An Anthropic API key
- A Lumos API key. For the default acting-as mode it must belong to a Lumos admin
  (it submits requests on behalf of other users). For single-identity mode
  (`LUMOS_ACT_AS_SLACK_USER=false`) any user's key works.

## Setup

### 1. Create the Slack app

1. Go to <https://api.slack.com/apps> → **Create New App** → **From a manifest**.
2. Pick your workspace and paste the contents of [`manifest.json`](./manifest.json).
3. **Basic Information → App-Level Tokens** → generate a token with the
   `connections:write` scope. This is your `SLACK_APP_TOKEN` (`xapp-…`).
4. **Install App** to your workspace. Copy the **Bot User OAuth Token**
   (`xoxb-…`) → `SLACK_BOT_TOKEN`.
5. **Basic Information → App Credentials** → copy the **Signing Secret** →
   `SLACK_SIGNING_SECRET`.

The manifest enables Socket Mode and the Messages tab, subscribes to mention and
message events (so the bot can follow up in threads without being re-mentioned), and
requests the scopes it needs: `app_mentions:read`, `chat:write`, the message-history
scopes for DMs and channels, and `users:read` + `users:read.email` (to read the
sender's email for acting-as mode).

### 2. Get a Lumos API key

Create an API key in Lumos (see [Creating an API token](https://developers.lumos.com/docs/quick-start#creating-an-api-token) in the Lumos developer docs).
The bot sends it as `Authorization: Bearer <key>`. For the default acting-as mode the
key must belong to a Lumos admin. Production endpoint: `https://api.lumos.com/mcp/user`.

> [!TIP]
> Create the key from a dedicated **service account**, not a personal
> one. Whoever owns the key is recorded as having acted on every request the bot files
> for other people, so a personal key means that person gets notified about everyone's
> requests. A service account keeps those notifications out of an individual's inbox.

### 3. Configure environment

```bash
cp .env.example .env
# then fill in the values
```

### 4. Install and run

```bash
npm install
npm run dev      # watch mode (tsx)
# or
npm start        # one-off run
```

On startup the bot connects to the MCP server and logs the discovered tools, e.g.:

```
[lumos-bot] Connected to Lumos MCP at https://api.lumos.com/mcp/user. Tools: search_apps, search_requestable_permissions, list_requestable_permissions, submit_access_request, list_access_requests
✅ Lumos MCP Slack bot is running. Mention it in a channel or DM it.
```

## Talking to the bot

Two gotchas when finding the app in your workspace:

- **To DM it:** the bot's Messages tab must be enabled. The manifest sets this, but
  if you created the app before adding it, go to **App Home → Show Tabs → Messages Tab**,
  turn it on, and check *"Allow users to send Slash commands and messages from the
  messages tab."* Then open the app under **Apps** in the Slack sidebar and DM it.
- **To mention it in a channel:** invite it first with `/invite @<bot-name>`. Bots only
  receive `app_mention` events in channels they belong to.

Once the bot has replied in a thread (or in a DM), you can keep chatting without
re-@-mentioning it. In a channel thread the bot anchors to the first person who
@-mentioned it: it follows up on that user's messages and acts on their behalf, and
ignores everyone else's messages in the thread. This keeps shared threads from
hijacking the session or flipping who a request is filed for. To start a separate
session, @-mention the bot in a new thread.

## Try it

The bot can be named anything — Lumos access requests are just one capability your
Slack bot might handle. Substitute your bot's actual name for `@your-bot` below.

DM the bot or mention it in a channel:

- `@your-bot what can I request for Salesforce?`
- `@your-bot I need to read production data — what should I request?`
- `@your-bot request read-only access to Snowflake for 7 days, reason: debugging an incident`
- `@your-bot what access requests do I have pending?`

By default each reply includes a small "_Lumos MCP calls: …_" trace so you can see
the tool calls happening during a demo. Set `SHOW_TOOL_TRACE=false` to hide it.

## How the bot behaves in Slack

The system prompt is tuned for a Slack context rather than a dedicated 1:1 chat:

- **Public-forum aware.** It assumes it's often in a channel others can see, so replies
  stay short and skimmable and it avoids long back-and-forth.
- **Least privilege by default.** It aims for the narrowest request that still covers
  what was asked — favoring read-only over broader write/admin access unless more is
  clearly needed — and scopes the duration to the work: a time-boxed window for clearly
  temporary needs (an incident, a one-off task) and *Unlimited* only for access that's
  genuinely ongoing. It tells the user which permission and duration it chose and lists
  the other options so they can course-correct.
- **Practical, not interrogative.** Within those guardrails it leans toward action: it
  fills in sensible, conservative defaults rather than quizzing the user, and asks a
  clarifying question only when it genuinely can't tell which app or permission level is
  meant — and then just one. After submitting it states what it requested.
- **Business justification.** Every request carries a real reason, since approvers see
  it. The bot infers one from what the user already said whenever it can (never inventing
  specifics or inflating urgency); only when there's genuinely nothing to infer from does
  it ask — once — before submitting. It won't file a request with an empty or made-up
  justification.
- **Hand-off to the web.** For anything the MCP server can't do (removing/modifying/
  extending access, approvals, viewing others' requests) or when the user would rather
  finish in the browser, it links them to the Lumos web app (`LUMOS_WEB_URL`,
  default `https://app.lumosidentity.com`).

## Project layout

```
src/
  index.ts            # entry point: connect MCP, start Slack (Socket Mode)
  config.ts           # env-based config
  mcp/client.ts       # MCP client → Lumos, Bearer API-key auth (the key bit)
  agent/agent.ts      # Claude tool-use loop; injects for_user in acting-as mode
  slack/app.ts        # Bolt app (Socket Mode)
  slack/listeners.ts  # app_mention + DM handlers, thread follow-ups
  slack/users.ts      # resolve a Slack user's verified email (for_user source)
  slack/format.ts     # mention stripping, mrkdwn, tool trace
```

## Who requests are filed for

The bot has two identity modes, controlled by `LUMOS_ACT_AS_SLACK_USER`:

**Acting-as mode (default, `true`)** files requests for the Slack user chatting with
the bot. For each message it resolves the sender's *verified Slack email* and forces
it into the `for_user` parameter on every MCP tool that supports it. `for_user` is
always derived from the authenticated Slack identity, never from the model or the
message text, so a user can't request as someone else. Requirements and limits:

- The API key must belong to a Lumos admin (the MCP server rejects `for_user` from
  non-admins).
- The user's Slack email must match their Lumos identity (email or user UUID). If it
  can't be resolved, the bot says so and does nothing; it never silently falls back to
  the admin's identity.
- Every tool the server exposes supports `for_user`, so all of them, including listing
  the user's existing requests, run scoped to that person. (If a future tool ever lacks
  `for_user`, the bot automatically withholds it in this mode rather than running it
  unscoped as the admin.)

**Security model: can a user act as someone else?** No, by design:

- `for_user` is set server-side from the sender's verified Slack email and is never
  taken from the model or the message text. The bot overrides any `for_user` the model
  produced (and strips it entirely in single-identity mode), so prompt-injection like
  "request access for victim@co.com" can't change who a request is for.
- The sender id (`event.user` / `message.user`) is set by Slack and isn't spoofable by a
  regular user.
- The MCP server provides no second check here: an admin key means it honors whatever
  `for_user` the bot sends (scoped to the key's own Lumos domain, no cross-org). So the
  bot is the only gatekeeper, which is why `for_user` is locked down server-side.
- The remaining trust anchor is the integrity of the Slack email from `users.info`. Slack
  verifies email ownership, and SSO/SCIM-managed workspaces treat it as authoritative, so
  a user can't masquerade as a colleague. If your workspace lets members set arbitrary
  unverified emails, validate that before trusting acting-as attribution.

**Single-identity mode (`false`)** files every request as the API key's owner,
regardless of who's chatting. Use this with a non-admin key when you just want to
demo the MCP tools without per-user attribution.

> [!NOTE]
> The Lumos REST API also has an `X-Acting-As` header for on-behalf-of calls,
> but the MCP server doesn't read it. `for_user` is the MCP-native mechanism, so
> that's what this bot uses.

## Notes & caveats (it's a demo)

- **Shared admin key.** In the default acting-as mode the bot uses one admin API key
  to file requests for everyone via `for_user` (see
  [Who requests are filed for](#who-requests-are-filed-for)). That key is powerful —
  protect it accordingly. A hardened deployment might give each Slack user their own
  per-user Lumos credential (or per-user OAuth — which the Lumos MCP server supports
  via dynamic client registration) instead of a shared admin key.
- **In-memory conversation history.** Thread/DM context is kept in memory and lost
  on restart. Persist it for production.
- **Write actions are real.** `submit_access_request` creates actual Lumos
  requests. The bot is prompted to confirm specifics before submitting, but treat
  the connected workspace/key accordingly.

## License

MIT — see [LICENSE](./LICENSE).
