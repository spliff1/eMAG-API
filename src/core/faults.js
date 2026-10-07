/** Fault-injection rules: force a status/body (and delay) on matching requests. */
function matches(rule, method, path) {
  if (!rule.enabled) return false;
  if (rule.method && rule.method !== '*' && rule.method.toUpperCase() !== method) return false;
  const pat = rule.path || '*';
  if (pat === '*') return true;
  const re = new RegExp(`^${pat.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
  return re.test(path);
}

/** Returns the first matching rule (and consumes one use) or null. */
export function pickFault(settings, method, path) {
  const rules = settings.get().faults || [];
  for (const rule of rules) {
    if (!matches(rule, method, path)) continue;
    if (rule.remaining === 0) continue;
    if (typeof rule.remaining === 'number' && rule.remaining > 0) rule.remaining -= 1;
    return rule;
  }
  return null;
}

export function faultBody(rule) {
  if (rule.body !== undefined && rule.body !== null && rule.body !== '') {
    if (typeof rule.body === 'string') {
      try { return JSON.parse(rule.body); } catch { return { isError: true, messages: [rule.body], results: [] }; }
    }
    return rule.body;
  }
  if (rule.status === 429) return { message: 'API rate limit exceeded' };
  if (rule.status === 401) return { isError: true, messages: ['Unauthorized'], results: [] };
  if (rule.status === 403) return { isError: true, messages: ['Forbidden: IP address is not whitelisted'], results: [] };
  if (rule.status >= 500) return { isError: true, messages: ['Internal Server Error'], results: [] };
  return { isError: true, messages: [`Injected fault (HTTP ${rule.status})`], results: [] };
}
