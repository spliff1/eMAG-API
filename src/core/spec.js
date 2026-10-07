import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createValidator } from './validate.js';
import { clone } from './util.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** Loads the official OpenAPI document (spec/openapi.json) and exposes schema helpers. */
export function loadSpec(file = path.join(ROOT, 'spec/openapi.json')) {
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  const components = doc.components?.schemas || {};
  const validate = createValidator(components);

  const schema = (nameOrSchema) => (typeof nameOrSchema === 'string' ? { $ref: `#/components/schemas/${nameOrSchema}` } : nameOrSchema);

  return {
    doc,
    version: doc.info?.version,
    components,
    schema,
    validate: (nameOrSchema, value) => validate(schema(nameOrSchema), value),
    /** Deep-copy a named component schema and let the caller tweak it (e.g. raise a limit). */
    patched(name, fn) {
      const copy = clone(components[name]);
      fn(copy);
      return copy;
    },
  };
}

export { ROOT };
