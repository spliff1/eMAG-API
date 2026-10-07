import { EventEmitter } from 'node:events';

/**
 * Process-wide event bus.
 *  - 'request'  : a logged API request (summary)       -> pushed to the UI via SSE
 *  - 'data'     : { collection }                       -> a collection changed
 *  - 'notify'   : { event, payload }                   -> a marketplace event that should hit seller callbacks
 *  - 'callback' : a callback log entry                 -> UI SSE
 */
export const bus = new EventEmitter();
bus.setMaxListeners(100);
