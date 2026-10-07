import { ok, fail, countResults, paginate } from '../../core/response.js';
import { rnd, fmtDateTime, publicView } from '../../core/util.js';
import { attachInvoice, buildOrder, filterOrders, nextAttachmentId, saveOrder } from './service.js';
import { generateDummyAwb } from '../shipping/service.js';

/** The doc says order/read can return up to 1000 per page although the shared Pagination schema caps at 100. */
const orderFilterSchema = (spec) => spec.patched('OrderReadFilter', (s) => {
  const pagination = spec.components.Pagination;
  s.allOf[0] = { ...pagination, properties: { ...pagination.properties, itemsPerPage: { ...pagination.properties.itemsPerPage, maximum: 1000 } } };
});

const readOrders = (c, count) => {
  const { errors, list } = filterOrders(c.col('orders').all(), c.body, { count, strict: c.settings.strictRules });
  return { errors, list };
};

const mod = {
  id: 'orders',
  title: 'Orders',
  description: 'Orders placed by customers: read, acknowledge, edit, cancel, storno and invoice/warranty attachments. New orders can only be created here (the real API cannot create orders).',
  collections: [
    {
      name: 'orders', label: 'Orders', startAt: 51000001,
      columns: ['id', 'status', 'type', 'date', 'payment_mode', 'customer.name', 'customer.billing_city', 'products.0.name'],
    },
  ],

  routes: [
    {
      method: 'POST', path: '/order/read', name: 'order/read', summary: 'Read orders', rateGroup: 'orders', body: orderFilterSchema, readFilter: true,
      handler(c) {
        const { errors, list } = readOrders(c, false);
        if (errors.length) return fail(errors);
        const { currentPage = 1, itemsPerPage = 100 } = c.body;
        return ok(publicView(paginate(list, { currentPage, itemsPerPage })));
      },
    },
    {
      method: 'POST', path: '/order/count', name: 'order/count', summary: 'Count orders', rateGroup: 'orders', body: orderFilterSchema, readFilter: true,
      handler(c) {
        const { errors, list } = readOrders(c, true);
        if (errors.length) return fail(errors);
        return ok(countResults(list.length, c.body.itemsPerPage || 100));
      },
    },
    {
      method: 'POST', path: '/order/save', name: 'order/save', summary: 'Save/update order', rateGroup: 'orders',
      items: { schema: 'OrderSave', max: 50 },
      handler(c) {
        const messages = [];
        const results = [];
        let isError = false;
        for (const it of c.items) {
          if (it.errors.length) { messages.push(...it.errors); isError = true; continue; }
          const r = saveOrder(c.app, it.value, { strict: c.settings.strictRules });
          messages.push(...r.errors, ...r.warnings);
          if (r.errors.length) isError = true;
          else results.push(publicView(r.doc));
        }
        return { isError, messages, results };
      },
    },
    {
      method: 'POST', path: '/order/acknowledge/:orderId', name: 'order/acknowledge/{orderId}', summary: 'Acknowledge order', rateGroup: 'orders',
      handler(c) {
        const o = c.col('orders').get(c.params.orderId);
        if (!o) return fail(`Order ${c.params.orderId} not found`);
        if (o.type !== 3) return fail('Only orders fulfilled by the seller (type 3) can be acknowledged');
        if (o.status !== 1) return fail(`Order ${o.id} cannot be acknowledged: current status is ${o.status} (only New orders can be acknowledged)`);
        o.status = 2;
        o.modified = fmtDateTime();
        c.col('orders').touch();
        return ok([{ id: o.id, status: o.status }]);
      },
    },
    {
      method: 'POST', path: '/order/:orderId/unlock-courier', name: 'order/{orderId}/unlock-courier', summary: 'Unlock courier for order', rateGroup: 'orders',
      handler(c) {
        const o = c.col('orders').get(c.params.orderId);
        if (!o) return fail(`Order ${c.params.orderId} not found`);
        o.enforced_vendor_courier_accounts = null;
        o.modified = fmtDateTime();
        c.col('orders').touch();
        return ok([{ id: o.id }]);
      },
    },
    {
      method: 'POST', path: '/order/attachments/read', name: 'order/attachments/read', summary: 'Read order attachments', rateGroup: 'orders',
      body: { type: 'object', properties: { order_id: { type: 'integer' }, order_type: { type: 'integer', enum: [2, 3] } } }, readFilter: true,
      handler(c) {
        const { order_id: id, order_type: type } = c.body;
        const results = [];
        for (const o of c.col('orders').all()) {
          if ((id !== undefined && o.id !== id) || (type !== undefined && o.type !== type)) continue;
          for (const a of o.attachments) results.push({ order_id: o.id, order_type: o.type, ...a });
        }
        return ok(results.slice(0, 100));
      },
    },
    {
      method: 'POST', path: '/order/attachments/save', name: 'order/attachments/save', summary: 'Save order attachments', rateGroup: 'orders',
      items: { schema: 'OrderAttachment', max: 50 },
      handler(c) {
        const messages = [];
        let isError = false;
        const orders = c.col('orders');
        for (const it of c.items) {
          const fail1 = (m) => { messages.push(`${it.errors.length ? '' : `data[${it.index}] `}${m}`); isError = true; };
          if (it.errors.length) { messages.push(...it.errors); isError = true; continue; }
          const a = it.value;
          const type = a.type ?? 1;
          let order = a.order_id !== undefined ? orders.get(a.order_id) : undefined;
          if (type === 1 && a.order_id === undefined) { fail1('order_id: required for invoices'); continue; }
          if (type === 3) {
            if (a.order_product_id === undefined) { fail1('order_product_id: required for warranties'); continue; }
            order ??= orders.find((o) => o.products.some((p) => p.id === a.order_product_id));
          }
          if (!order) { fail1(`order not found${a.order_id ? ` (${a.order_id})` : ''}`); continue; }
          if (order.type !== a.order_type) { fail1(`order_type: ${a.order_type} does not match the order type (${order.type})`); continue; }
          if (type === 3 && !order.products.some((p) => p.id === a.order_product_id)) { fail1(`order_product_id: ${a.order_product_id} is not a product line of order ${order.id}`); continue; }
          if (c.settings.strictRules && !/\.pdf$/i.test(new URL(a.url).pathname)) { fail1('url: only .pdf files are accepted'); continue; }
          order.attachments.push({
            id: nextAttachmentId(c.app), name: a.name || `Attachment ${order.id}`, url: a.url, type, force_download: a.force_download ?? 0,
            ...(a.order_product_id ? { order_product_id: a.order_product_id } : {}),
          });
          order.modified = fmtDateTime();
        }
        orders.touch();
        return { isError, messages, results: [] };
      },
    },
  ],

  generators: [
    {
      id: 'orders',
      label: 'Orders',
      description: 'Creates orders from your offers (offers are generated first if you have none). New orders can fire the "order.new" callback.',
      params: [
        { name: 'count', label: 'How many', type: 'number', default: 10, min: 1, max: 300 },
        {
          name: 'status', label: 'Status', type: 'select', default: 'mixed',
          options: [{ value: 'mixed', label: 'Mixed' }, { value: '1', label: '1 - New' }, { value: '2', label: '2 - In progress' }, { value: '3', label: '3 - Prepared' }, { value: '4', label: '4 - Finalized' }, { value: '0', label: '0 - Canceled' }, { value: '5', label: '5 - Returned' }],
        },
        { name: 'type', label: 'Fulfilled by', type: 'select', default: '3', options: [{ value: '3', label: 'Seller (3)' }, { value: '2', label: 'eMAG (2)' }, { value: 'mixed', label: 'Mixed' }] },
        { name: 'payment', label: 'Payment', type: 'select', default: 'mixed', options: [{ value: 'mixed', label: 'Mixed' }, { value: '1', label: 'Cash on delivery' }, { value: '2', label: 'Bank transfer' }, { value: '3', label: 'Online card' }] },
        { name: 'notify', label: 'Fire "order.new" callbacks', type: 'boolean', default: false },
      ],
      run(app, p) {
        const count = Math.min(Number(p.count) || 10, 300);
        const orders = app.col('orders');
        let created = 0;
        for (let i = 0; i < count; i++) {
          const status = p.status && p.status !== 'mixed' ? Number(p.status) : rnd.weighted([[1, 25], [2, 20], [3, 15], [4, 30], [0, 7], [5, 3]]);
          const type = p.type === 'mixed' ? rnd.pick([3, 3, 3, 2]) : Number(p.type || 3);
          const payment = p.payment && p.payment !== 'mixed' ? Number(p.payment) : undefined;
          const order = buildOrder(app, { status: type === 2 && status === 1 ? 4 : status, type, payment });
          orders.insert(order);
          created += 1;
          if (p.notify && order.status === 1 && order.type === 3) app.notify('order.new', publicView(order));
        }
        return { message: `Created ${created} orders`, created };
      },
    },
  ],

  rowLinks: [
    { id: 'awb_pdf_a6', label: 'AWB PDF (A6) - generates one if missing', collection: 'orders', href: '/__ui/api/orders/{id}/awb-label?format=A6' },
    { id: 'awb_pdf_a4', label: 'AWB PDF (A4)', collection: 'orders', href: '/__ui/api/orders/{id}/awb-label?format=A4' },
    { id: 'awb_zpl', label: 'AWB ZPL', collection: 'orders', href: '/__ui/api/orders/{id}/awb-label?format=ZPL' },
  ],

  rowActions: [
    {
      id: 'dummy_awb', label: 'Generate dummy AWB (finalizes the order)', collection: 'orders',
      run(app, row) {
        const r = generateDummyAwb(app, row);
        if (r.error) throw Object.assign(new Error(r.error), { status: 400 });
        return { message: `${r.existing ? 'AWB already issued' : 'AWB issued'}: ${r.doc.awb[0].awb_number} (emag_id ${r.doc.emag_id}). Order ${row.id} status: ${row.status}` };
      },
    },
    {
      id: 'customer_cancel', label: 'Customer cancels (fires order.cancel)', collection: 'orders', danger: true,
      run(app, row) {
        row.status = 0; row.reason_cancellation = 2; row.modified = fmtDateTime();
        app.col('orders').touch();
        app.notify('order.cancel', publicView(row));
        return { message: `Order ${row.id} cancelled by the customer` };
      },
    },
    { id: 'mark_paid', label: 'Mark as paid', collection: 'orders', run(app, row) { row.payment_status = 1; row.modified = fmtDateTime(); app.col('orders').touch(); return { message: 'payment_status = 1' }; } },
    { id: 'reset_new', label: 'Reset to New (1)', collection: 'orders', run(app, row) { row.status = 1; delete row.reason_cancellation; row.modified = fmtDateTime(); app.col('orders').touch(); return { message: `Order ${row.id} is New again` }; } },
    { id: 'notify_new', label: 'Re-send order.new callback', collection: 'orders', run(app, row) { app.notify('order.new', publicView(row)); return { message: 'order.new queued' }; } },
    {
      id: 'finalize', label: 'Force finalize (4) + invoice', collection: 'orders',
      run(app, row) { row.status = 4; if (row.type === 3) attachInvoice(app, row); row.modified = fmtDateTime(); app.col('orders').touch(); return { message: `Order ${row.id} finalized` }; },
    },
  ],
};

export default mod;
