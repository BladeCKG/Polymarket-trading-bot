/**
 * copy/feedFactory.js
 * Creates the configured copy-trade signal feed without leaking source-specific
 * details into the copy runtime.
 */
import { ActivityFeed } from './activityFeed.js';
import { ChainActivityFeed } from './chainActivityFeed.js';

export function createCopyFeed({ mode, targets, pollMs }) {
  switch (mode) {
    case 'CHAIN':
      return new ChainActivityFeed(targets);
    case 'REST':
    default:
      return new ActivityFeed(targets, pollMs);
  }
}
