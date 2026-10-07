import * as fake from '../core/faker.js';
import { rnd } from '../core/util.js';

/**
 * Replaces personal data in imported orders / returns with fake values. The same real customer always maps to the
 * same fake one within a run (so repeat customers stay linked). Coarse location data (city, county, locality ids,
 * postal code) is kept because AWB tests need valid localities.
 */
export function createAnonymizer() {
  const customers = new Map();

  function fakeCustomerFor(real) {
    const key = real.id ?? JSON.stringify([real.name, real.phone_1]);
    if (customers.has(key)) return customers.get(key);
    const { name, gender } = fake.person();
    const phone = fake.phone();
    const legal = real.legal_entity === 1;
    const f = {
      id: rnd.int(1_000_000, 90_000_000), name, gender, email: fake.maskedEmail(), phone,
      company: legal ? fake.company() : '', code: legal ? fake.cui() : '', registration_number: legal ? fake.regNumber() : '',
      iban: legal ? fake.iban() : '', bank: legal ? fake.bank() : '', street: fake.street(), shippingStreet: fake.street(),
    };
    customers.set(key, f);
    return f;
  }

  return {
    order(order) {
      const c = order.customer;
      if (c) {
        const f = fakeCustomerFor(c);
        const legal = c.legal_entity === 1;
        Object.assign(c, {
          id: f.id, name: f.name, gender: f.gender, email: f.email, company: legal ? f.company : '', code: legal ? f.code : '',
          registration_number: legal ? f.registration_number : '', bank: legal ? f.bank : '', iban: legal ? f.iban : '', fax: '',
          phone_1: f.phone, phone_2: '', phone_3: '', billing_name: legal ? f.company : f.name, billing_phone: f.phone,
          billing_street: f.street, shipping_contact: f.name, shipping_phone: f.phone, shipping_street: f.shippingStreet,
        });
      }
      order.observation = '';
      for (const p of order.products || []) { if (p.details) p.details = ''; if (p.serial_numbers) p.serial_numbers = ''; }
      return order;
    },
    rma(rma) {
      const f = fakeCustomerFor({ id: `rma:${rma.customer_name}:${rma.customer_phone}` });
      Object.assign(rma, {
        customer_name: f.name, customer_phone: f.phone, customer_company: rma.customer_company ? f.company : '',
        customer_account_iban: rma.customer_account_iban ? f.iban || fake.iban() : '', customer_account_bank: rma.customer_account_bank ? fake.bank() : '',
        customer_account_beneficiary: rma.customer_account_beneficiary ? f.name : '',
      });
      return rma;
    },
  };
}
