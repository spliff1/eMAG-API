import { clone, deepMerge, isObj } from './util.js';

export const PLATFORMS = {
  ro: { id: 'ro', label: 'eMAG Romania', currency: 'RON', locale: 'ro_RO', country: 'RO', host: 'marketplace-api.emag.ro' },
  bg: { id: 'bg', label: 'eMAG Bulgaria', currency: 'EUR', locale: 'bg_BG', country: 'BG', host: 'marketplace-api.emag.bg' },
  hu: { id: 'hu', label: 'eMAG Hungary', currency: 'HUF', locale: 'hu_HU', country: 'HU', host: 'marketplace-api.emag.hu' },
};

export const CALLBACK_EVENTS = [
  { id: 'order.new', label: 'New order' },
  { id: 'order.cancel', label: 'Order cancelled' },
  { id: 'rma.new', label: 'New return request' },
  { id: 'rma.status', label: 'Return request status change' },
  { id: 'awb.status', label: 'AWB status change' },
  { id: 'documentation.approved', label: 'Documentation approved' },
];

export const DEFAULT_SETTINGS = {
  platform: 'ro',
  auth: {
    // any   : any non-empty Basic credentials are accepted
    // strict: only the users listed below are accepted (401 otherwise)
    mode: 'any',
    users: [{ username: 'seller@example.ro', password: 'secret' }],
  },
  rateLimit: { enabled: true },
  awbFinalizesOrder: true, // issuing an AWB for an order moves it to status 4 (Finalized)
  strictRules: true, // enforce business rules (status transitions, mandatory fields, ...) like production does
  autoApproveSeconds: 20, // documentation validation: 0 = never auto-approve (use the UI)
  latencyMs: 0,
  errorRate: 0, // % of requests answered with a random 500/502/503
  callbacks: {
    timeoutMs: 10000,
    basicAuth: { username: '', password: '' },
    events: Object.fromEntries(CALLBACK_EVENTS.map((e) => [e.id, { enabled: false, url: '' }])),
  },
  // [{ id, enabled, method: '*'|'POST'..., path: '/order/read' | '/order/*' | '*', status, body, delayMs, remaining (-1 = unlimited) }]
  faults: [],
};

export function createSettings(store) {
  const state = deepMerge(clone(DEFAULT_SETTINGS), store.meta.settings || {});
  store.meta.settings = state;

  return {
    get: () => state,
    platform: () => PLATFORMS[state.platform] || PLATFORMS.ro,
    update(patch) {
      for (const [k, v] of Object.entries(patch || {})) {
        if (!Object.hasOwn(DEFAULT_SETTINGS, k)) continue;
        // arrays (faults, users) are replaced, objects merged
        if (isObj(v) && isObj(state[k])) deepMerge(state[k], v);
        else state[k] = clone(v);
      }
      store.meta.settings = state;
      store.changed('__settings');
      return state;
    },
    reset() {
      for (const k of Object.keys(state)) delete state[k];
      Object.assign(state, clone(DEFAULT_SETTINGS));
      store.changed('__settings');
      return state;
    },
  };
}
