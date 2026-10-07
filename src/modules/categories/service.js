import { CATEGORIES, CHARACTERISTICS, HANDLING_TIMES, VAT_RATES } from './seed.js';

/** Expand the compact seed definitions into the stored category documents. */
export function buildCategoryDocs() {
  return CATEGORIES.map((c) => {
    const chars = (c.chars || []).map((spec, i) => {
      const mandatory = spec.endsWith('*');
      const def = CHARACTERISTICS[spec.replace('*', '')];
      return {
        id: def.id,
        names: { en: def.en, ro: def.ro },
        type_id: def.type_id,
        display_order: i + 1,
        is_mandatory: mandatory ? 1 : 0,
        is_filter: def.filter ? 1 : 0,
        allow_new_value: def.allow_new_value ? 1 : 0,
        values: def.values.map(([en, ro], idx) => ({ id: def.id * 100 + idx + 1, names: { en, ro } })),
      };
    });
    const familyTypes = [];
    if (chars.some((x) => x.id === CHARACTERISTICS.color.id)) {
      familyTypes.push({ id: 1, name: 'Color', characteristics: [{ characteristic_id: CHARACTERISTICS.color.id, characteristic_family_type_id: 1, is_foldable: 0 }] });
    }
    if (chars.some((x) => x.id === CHARACTERISTICS.size.id)) {
      familyTypes.push({ id: 2, name: 'Size', characteristics: [{ characteristic_id: CHARACTERISTICS.size.id, characteristic_family_type_id: 1, is_foldable: 0 }] });
    }
    return {
      id: c.id,
      parent_id: c.parent_id,
      names: { en: c.en, ro: c.ro },
      is_allowed: 1,
      is_ean_mandatory: c.ean ? 1 : 0,
      is_warranty_mandatory: c.warranty ? 1 : 0,
      characteristics: chars,
      family_types: familyTypes,
      _gen: c.gen || null,
      _isLeaf: !!c.gen,
    };
  });
}

export const vatDocs = () => VAT_RATES.map((v) => ({ ...v }));
export const handlingTimeDocs = () => HANDLING_TIMES.map((v) => ({ id: v, value: v }));

export function presentCategory(doc, { lang = 'en', full = false, valuesPage = 1, valuesPerPage = 256 } = {}) {
  const nm = (names) => names[lang] || names.en || Object.values(names)[0];
  const base = {
    id: doc.id,
    name: nm(doc.names),
    is_allowed: doc.is_allowed,
    parent_id: doc.parent_id,
    is_ean_mandatory: doc.is_ean_mandatory,
    is_warranty_mandatory: doc.is_warranty_mandatory,
  };
  if (!full) return base;
  return {
    ...base,
    characteristics: doc.characteristics.map((ch) => ({
      id: ch.id,
      name: nm(ch.names),
      type_id: ch.type_id,
      display_order: ch.display_order,
      is_mandatory: ch.is_mandatory,
      is_filter: ch.is_filter,
      allow_new_value: ch.allow_new_value,
      values: ch.values.slice((valuesPage - 1) * valuesPerPage, valuesPage * valuesPerPage).map((v) => ({ id: v.id, name: nm(v.names) })),
    })),
    family_types: doc.family_types,
  };
}
