/** Standard eMAG response envelope. */
export const ok = (results = [], messages = []) => ({ isError: false, messages, results });
export const fail = (messages, results = []) => ({ isError: true, messages: [].concat(messages), results });

/** Thrown from handlers to short-circuit with a given HTTP status. */
export class ApiError extends Error {
  constructor(status, messages, body) {
    super(Array.isArray(messages) ? messages.join('; ') : String(messages));
    this.status = status;
    this.messages = [].concat(messages);
    this.body = body;
  }
}

const RAW = Symbol('raw');
/** Return a non-JSON response (PDF, ZPL, ...). */
export const raw = (status, headers, body) => ({ [RAW]: true, status, headers, body });
export const isRaw = (v) => v && v[RAW] === true;

/** eMAG count envelope: results is an object, not an array. */
export const countResults = (total, itemsPerPage = 100) => ({
  noOfItems: total,
  noOfPages: Math.ceil(total / itemsPerPage),
  itemsPerPage,
});

export function paginate(items, { currentPage = 1, itemsPerPage = 100 } = {}) {
  const start = (currentPage - 1) * itemsPerPage;
  return items.slice(start, start + itemsPerPage);
}
