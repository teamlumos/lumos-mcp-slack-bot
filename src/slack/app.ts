import { App } from '@slack/bolt';
import { config } from '../config.js';

export function createApp(): App {
  const app = new App({
    token: config.slack.botToken,
    appToken: config.slack.appToken,
    signingSecret: config.slack.signingSecret,
    socketMode: true,
  });

  app.error(async (error) => {
    console.error('[lumos-bot] Unhandled error:', error);
  });

  return app;
}
