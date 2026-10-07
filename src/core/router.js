/** Builds a route table from module definitions. Paths use :param syntax (relative to /api-3). */
export function buildRouter(modules) {
  const routes = [];
  for (const mod of modules) {
    for (const route of mod.routes || []) {
      const keys = [];
      const pattern = route.path
        .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
        .replace(/:([A-Za-z_]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; });
      routes.push({
        ...route,
        method: route.method.toUpperCase(),
        regex: new RegExp(`^${pattern}$`),
        keys,
        module: mod,
        section: mod.title,
      });
    }
  }

  return {
    routes,
    match(method, path) {
      let pathMatched = false;
      for (const r of routes) {
        const m = r.regex.exec(path);
        if (!m) continue;
        pathMatched = true;
        if (r.method !== method) continue;
        const params = {};
        r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
        return { route: r, params };
      }
      return pathMatched ? { methodNotAllowed: true } : null;
    },
  };
}
