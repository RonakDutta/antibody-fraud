import { setTimeout as wait } from 'node:timers/promises';
import type { LearningService } from './learning.js';

/** Drain the durable outbox independently of event intake. */
export function startPublicationWorker(learning: LearningService, onError: () => void, intervalMs = 1500) {
  const stop = new AbortController();
  const loop = (async () => {
    while (!stop.signal.aborted) {
      try {
        await learning.workOne();
      } catch {
        onError();
      }
      try {
        await wait(intervalMs, undefined, { signal: stop.signal });
      } catch {
        break;
      }
    }
  })();
  return async () => {
    stop.abort();
    await loop;
  };
}
