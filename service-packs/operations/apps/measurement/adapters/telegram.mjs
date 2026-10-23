import { metric } from './shared.mjs';

export function createTelegramAdapter() {
  return async function readTelegramItem() {
    // The Bot API does not provide channel-post view analytics. Avoid a Bot API
    // request whose response could not supply the requested metric.
    return {
      views: metric(null, { source: 'telegram.bot-api', reason: 'bot_api_does_not_expose_post_views' }),
    };
  };
}

