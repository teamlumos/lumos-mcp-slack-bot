import type { WebClient } from '@slack/web-api';

// Slack user id -> verified email. Cached because it doesn't change within a run
// and `users.info` is rate-limited. Only successful lookups are cached, so adding
// the `users:read.email` scope (and reinstalling) takes effect without a restart.
const emailCache = new Map<string, string>();

/**
 * Resolve a Slack user's verified email via `users.info`. Returns null if the
 * lookup fails or the profile has no email (e.g. the `users:read.email` scope is
 * missing). Requires the `users:read` and `users:read.email` scopes.
 */
export async function resolveUserEmail(
  client: WebClient,
  userId: string,
): Promise<string | null> {
  const cached = emailCache.get(userId);
  if (cached) return cached;

  try {
    const result = await client.users.info({ user: userId });
    const email = result.user?.profile?.email;
    if (email) {
      emailCache.set(userId, email);
      return email;
    }
    return null;
  } catch (err) {
    console.error('[lumos-bot] users.info lookup failed:', err);
    return null;
  }
}
