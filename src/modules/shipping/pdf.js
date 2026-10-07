/** Dependency-free AWB label writers (PDF + ZPL) for the dummy courier labels. */
const SIZES = { A4: [595, 842], A5: [420, 595], A6: [298, 420] };
const BASE_W = 298; // label layout is designed on A6 (298 x 420 pt) and scaled for A5 / A4
const BASE_H = 420;

const ascii = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\x20-\x7e]/g, '?');
const esc = (s) => ascii(s).replace(/[\\()]/g, '\\$&');

// ---------------------------------------------------------------- Code 128 (subset B)
const PATTERNS = ('212222 222122 222221 121223 121322 131222 122213 122312 132212 221213 221312 231212 112232 122132 122231 113222 123122 123221 223211 221132 '
  + '221231 213212 223112 312131 311222 321122 321221 312212 322112 322211 212123 212321 232121 111323 131123 131321 112313 132113 132311 211313 231113 231311 '
  + '112133 112331 132131 113123 113321 133121 313121 211331 231131 213113 213311 213131 311123 311321 331121 312113 312311 332111 314111 221411 431111 111224 '
  + '111422 121124 121421 141122 141221 112214 112412 122114 122411 142112 142211 241211 221114 413111 241112 134111 111242 121142 121241 114212 124112 124211 '
  + '411212 421112 421211 212141 214121 412121 111143 111341 131141 114113 114311 411113 411311 113141 114131 311141 411131 211412 211214 211232 2331112').split(' ');
const START_B = 104;
const STOP = 106;

/** Code 128-B symbol list for `text`: [startB, ...chars, checksum, stop]. Characters outside 32..126 become '?'. */
export function code128Symbols(text) {
  const codes = [...ascii(text)].map((c) => c.charCodeAt(0) - 32);
  let sum = START_B;
  codes.forEach((v, i) => { sum += v * (i + 1); });
  return [START_B, ...codes, sum % 103, STOP];
}

/** Alternating bar/space widths (in modules) for `text`, ready to draw (starts with a bar). */
export function code128Widths(text) {
  return code128Symbols(text).flatMap((v) => [...PATTERNS[v]].map(Number));
}

// ------------------------------------------------------------------------- PDF label
function barcodeOps(text, x, y, width, height) {
  const widths = code128Widths(text);
  const total = widths.reduce((a, b) => a + b, 0) + 20; // 10 modules quiet zone each side
  const mod = width / total;
  let cx = x + 10 * mod;
  const ops = [];
  widths.forEach((w, i) => {
    if (i % 2 === 0) ops.push(`${cx.toFixed(2)} ${y} ${(w * mod).toFixed(2)} ${height} re f`);
    cx += w * mod;
  });
  return ops;
}

const text = (s, x, y, size, bold = false, gray = 0) => `${gray} g BT /${bold ? 'F2' : 'F1'} ${size} Tf ${x} ${y} Td (${esc(s)}) Tj ET`;
const clip = (s, n) => (String(s ?? '').length > n ? `${String(s).slice(0, n - 3)}...` : String(s ?? ''));

/**
 * label = { courier, awbNumber, orderId, rmaId, receiver:{name,contact,phone,street,city,county,zip}, sender:{...},
 *           cod, currency, weight, parcels, envelopes, date, service, observation }
 */
export function makeLabelPdf(label, size = 'A6') {
  const [w, h] = SIZES[size] || SIZES.A6;
  const scale = Math.min(w / BASE_W, h / BASE_H);
  const L = 14;
  const R = BASE_W - 14;
  const ops = [`q ${scale.toFixed(4)} 0 0 ${scale.toFixed(4)} 0 ${(h - BASE_H * scale).toFixed(2)} cm`];

  // header band
  ops.push('0.09 0.10 0.13 rg 0 382 298 38 re f');
  ops.push(text(label.courier || 'Courier', L, 395, 16, true, 1));
  ops.push(text(label.rmaId ? 'RETURN' : (label.service || 'STANDARD'), R - 70, 396, 10, true, 1));

  // AWB + barcode
  ops.push(text(label.awbNumber, L, 355, 20, true));
  ops.push(...barcodeOps(label.awbNumber, L, 288, R - L, 58));
  ops.push(text(label.awbNumber, L, 276, 9));
  ops.push('0.6 G 0.5 w 14 268 m 284 268 l S');

  // receiver
  const r = label.receiver || {};
  ops.push(text(label.rmaId ? 'PICKUP FROM' : 'TO', L, 256, 7, true, 0.4));
  ops.push(text(clip(r.name, 34), L, 241, 14, true));
  ops.push(text(clip([r.contact, r.phone].filter(Boolean).join('  -  '), 52), L, 227, 9));
  ops.push(text(clip(r.street, 56), L, 214, 10));
  ops.push(text(clip([r.zip, r.city, r.county].filter(Boolean).join(', '), 56), L, 201, 10, true));

  // sender
  const s = label.sender || {};
  ops.push('0.6 G 0.5 w 14 192 m 284 192 l S');
  ops.push(text('FROM', L, 182, 7, true, 0.4));
  ops.push(text(clip([s.name, s.contact].filter(Boolean).join(' / '), 56), L, 171, 9));
  ops.push(text(clip([s.street, s.city].filter(Boolean).join(', '), 62), L, 160, 8));

  // COD box
  const cod = Number(label.cod) || 0;
  ops.push('0 G 1.2 w 14 108 270 44 re S');
  ops.push(text(cod > 0 ? 'CASH ON DELIVERY' : 'PREPAID', L + 8, 136, 8, true, 0.4));
  ops.push(text(cod > 0 ? `${cod.toFixed(2)} ${label.currency || ''}` : 'No payment due', L + 8, 116, cod > 0 ? 20 : 14, true));

  // details
  ops.push(text(`Order: ${label.orderId}${label.rmaId ? `   RMA: ${label.rmaId}` : ''}`, L, 92, 10, true));
  ops.push(text(`Parcels: ${label.parcels ?? 1}   Envelopes: ${label.envelopes ?? 0}   Weight: ${label.weight ?? 1} kg`, L, 78, 9));
  ops.push(text(`Issued: ${label.date || ''}`, L, 65, 9));
  if (label.observation) ops.push(text(clip(`Note: ${label.observation}`, 60), L, 52, 8));

  // footer
  ops.push('0.85 g 0 0 298 30 re f');
  ops.push(text('DUMMY LABEL - not a valid shipment - generated by dummy-emag', L, 12, 7, false, 0.3));
  ops.push('Q');

  const content = ops.join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Contents 4 0 R /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> >>`,
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

// ------------------------------------------------------------------------------ ZPL
export function makeZpl(label) {
  const r = label.receiver || {};
  const s = label.sender || {};
  const cod = Number(label.cod) || 0;
  return [
    '^XA^CI28^PW800^LL1200',
    `^FO30,30^GB740,90,90^FS^FO45,50^FR^A0N,60,60^FD${ascii(label.courier)}^FS`,
    `^FO30,140^A0N,70,70^FD${ascii(label.awbNumber)}^FS`,
    `^FO30,230^BY3,3,140^BCN,140,Y,N,N^FD${ascii(label.awbNumber)}^FS`,
    `^FO30,430^A0N,24,24^FD${label.rmaId ? 'PICKUP FROM' : 'TO'}^FS`,
    `^FO30,465^A0N,48,48^FD${ascii(r.name)}^FS`,
    `^FO30,525^A0N,30,30^FD${ascii([r.contact, r.phone].filter(Boolean).join(' - '))}^FS`,
    `^FO30,565^A0N,34,34^FD${ascii(r.street)}^FS`,
    `^FO30,610^A0N,34,34^FD${ascii([r.zip, r.city, r.county].filter(Boolean).join(', '))}^FS`,
    '^FO30,670^GB740,2,2^FS',
    `^FO30,690^A0N,24,24^FDFROM^FS^FO30,720^A0N,30,30^FD${ascii([s.name, s.contact].filter(Boolean).join(' / '))}^FS`,
    `^FO30,760^A0N,26,26^FD${ascii([s.street, s.city].filter(Boolean).join(', '))}^FS`,
    '^FO30,820^GB740,150,4^FS',
    `^FO50,835^A0N,26,26^FD${cod > 0 ? 'CASH ON DELIVERY' : 'PREPAID'}^FS`,
    `^FO50,880^A0N,70,70^FD${cod > 0 ? `${cod.toFixed(2)} ${ascii(label.currency)}` : 'No payment due'}^FS`,
    `^FO30,1000^A0N,36,36^FDOrder: ${label.orderId}${label.rmaId ? `  RMA: ${label.rmaId}` : ''}^FS`,
    `^FO30,1045^A0N,30,30^FDParcels: ${label.parcels ?? 1}  Envelopes: ${label.envelopes ?? 0}  Weight: ${label.weight ?? 1} kg^FS`,
    `^FO30,1085^A0N,30,30^FDIssued: ${ascii(label.date)}^FS`,
    '^FO30,1140^A0N,24,24^FDDUMMY LABEL - not a valid shipment^FS',
    '^XZ',
  ].join('\n');
}
