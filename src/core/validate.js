/**
 * Small JSON-Schema (OpenAPI 3.0 flavour) validator driven by the official eMAG spec.
 * Supports: $ref, allOf, oneOf, type, enum, min/max (+ boolean exclusiveMinimum), minLength/maxLength,
 * pattern, format (uri/email/date/date-time), required, properties, items, minItems/maxItems.
 * Unknown properties are allowed (the real API ignores them).
 *
 * It also coerces PHP-style loose scalars ("12" -> 12, 12 -> "12") and reports each coercion as a note.
 */
import { isObj } from './util.js';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function createValidator(components) {
  const resolve = (s) => {
    let cur = s;
    let guard = 0;
    while (cur && cur.$ref && guard++ < 20) {
      const name = cur.$ref.replace('#/components/schemas/', '');
      const target = components[name];
      if (!target) throw new Error(`Unknown schema ref ${cur.$ref}`);
      const { $ref, ...rest } = cur;
      cur = { ...target, ...rest };
    }
    return cur;
  };

  function check(schema, value, path, out) {
    schema = resolve(schema || {});
    if (value === undefined) return value;

    if (schema.allOf) {
      for (const sub of schema.allOf) value = check(sub, value, path, out);
    }
    if (schema.oneOf) {
      let matched = false;
      for (const sub of schema.oneOf) {
        const probe = { errors: [], notes: [] };
        const v = check(sub, value, path, probe);
        if (!probe.errors.length) {
          matched = true;
          value = v;
          out.notes.push(...probe.notes);
          break;
        }
      }
      if (!matched) out.errors.push(`${path || 'value'}: invalid value`);
    }

    const type = schema.type;
    const label = path || 'value';

    if (type === 'integer' || type === 'number') {
      if (typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Number(value))) {
        out.notes.push(`${label}: numeric string coerced to ${type}`);
        value = Number(value);
      }
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        out.errors.push(`${label}: must be of type ${type}`);
        return value;
      }
      if (type === 'integer' && !Number.isInteger(value)) {
        out.errors.push(`${label}: must be an integer`);
        return value;
      }
      if (schema.minimum !== undefined) {
        if (schema.exclusiveMinimum === true ? value <= schema.minimum : value < schema.minimum) {
          out.errors.push(`${label}: must be ${schema.exclusiveMinimum === true ? 'greater than' : 'at least'} ${schema.minimum}`);
        }
      }
      if (schema.maximum !== undefined && value > schema.maximum) out.errors.push(`${label}: must be at most ${schema.maximum}`);
    } else if (type === 'string') {
      if (typeof value === 'number') {
        out.notes.push(`${label}: number coerced to string`);
        value = String(value);
      }
      if (typeof value !== 'string') {
        out.errors.push(`${label}: must be a string`);
        return value;
      }
      if (schema.minLength !== undefined && value.length < schema.minLength) out.errors.push(`${label}: must be at least ${schema.minLength} characters`);
      if (schema.maxLength !== undefined && value.length > schema.maxLength) out.errors.push(`${label}: must be at most ${schema.maxLength} characters`);
      if (schema.pattern && !new RegExp(schema.pattern).test(value)) out.errors.push(`${label}: invalid format`);
      if (schema.format === 'uri') {
        try {
          const u = new URL(value);
          if (!/^https?:$/.test(u.protocol)) throw new Error('protocol');
        } catch {
          out.errors.push(`${label}: must be a valid URL`);
        }
      } else if (schema.format === 'email' && !EMAIL.test(value)) out.errors.push(`${label}: must be a valid email`);
      else if (schema.format === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(value)) out.errors.push(`${label}: must be a date (YYYY-mm-dd)`);
      else if (schema.format === 'date-time' && Number.isNaN(Date.parse(value.replace(' ', 'T')))) out.errors.push(`${label}: must be a date-time (YYYY-mm-dd HH:ii:ss)`);
    } else if (type === 'boolean') {
      if (typeof value !== 'boolean') out.errors.push(`${label}: must be a boolean`);
      return value;
    } else if (type === 'array') {
      if (!Array.isArray(value)) {
        out.errors.push(`${label}: must be an array`);
        return value;
      }
      if (schema.maxItems !== undefined && value.length > schema.maxItems) out.errors.push(`${label}: at most ${schema.maxItems} items allowed`);
      if (schema.minItems !== undefined && value.length < schema.minItems) out.errors.push(`${label}: at least ${schema.minItems} items required`);
      if (schema.items) value = value.map((v, i) => check(schema.items, v, `${path}[${i}]`, out));
    } else if (type === 'object' || schema.properties || schema.required) {
      if (!isObj(value)) {
        out.errors.push(`${label}: must be an object`);
        return value;
      }
      const result = { ...value };
      for (const key of schema.required || []) {
        if (value[key] === undefined || value[key] === null) out.errors.push(`${path ? `${path}.` : ''}${key}: is required`);
      }
      for (const [key, sub] of Object.entries(schema.properties || {})) {
        if (value[key] === undefined || value[key] === null) continue;
        result[key] = check(sub, value[key], `${path ? `${path}.` : ''}${key}`, out);
      }
      value = result;
    }

    if (schema.enum && !schema.enum.includes(value)) {
      out.errors.push(`${label}: must be one of ${schema.enum.join(', ')}`);
    }
    return value;
  }

  /** validate(schema, value) -> { value (coerced), errors[], notes[] } */
  return function validate(schema, value) {
    const out = { errors: [], notes: [] };
    const coerced = check(schema, value, '', out);
    return { value: coerced, errors: out.errors, notes: out.notes };
  };
}
