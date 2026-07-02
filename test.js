// Self-check: PDF parsing + encrypt/decrypt roundtrip (incl. the WebCrypto path index.html uses).
// Run: node test.js
'use strict';
const assert = require('assert');
const { parseUtilityInvoice, parseSinkingFundInvoice, encrypt, decrypt, grandTotal } = require('./ingest.js');

// pdftotext -layout output shape, values from a real quarter invoice, identity lines removed
const UTILITY_TEXT = `                                                  INVOICE
                                                                                 Invoice Date       :   01/07/2026
   Charge For :                                                                                                Amount

Electricity Jun 2026
DAYA                                    :         3.50 KVA
START                                   :    11,922.70 KWH
FINAL                                   :    12,693.90 KWH
CONSUMED                                :       771.20 KWH
KWH CONSUMED                            :      771.20   X        1,699.53               1,310,678
                                                                                           85,000
BIAYA PEMELIHARAAN JARINGAN :
                                                                                                                  1,395,678
                                                                                                                     97,697
PPJ 7 %
SUB TOTAL                                                                                                         1,493,375
Water Jun 2026
ABODEMENT                                                                                 35,000
START                                   :          118.00 M3
FINAL                                   :          122.00 M3
CONSUMED                                :            4.00 M3
                                                                                          60,172
M3 CONSUMPTION                          :         4.00   X       15,043.00
SUB TOTAL                                                                                                               95,172
Iuran Pengelolaan
                                                                                        1,741,410
Iuran Pengelolaan Per 01 Jul 2026 - 30 Sep 2026
SUB TOTAL                                                                                                         1,741,410

TOTAL                                                                                                             3,329,957
PPN                                                                                                                 366,295

GRAND TOTAL NOW DUE                                                                                            3,696,252
`;

const SF_TEXT = `                                                 INVOICE
                                                                                 Invoice Date     :   01/07/2026
Lot No.    Description                                                                                         Sub Total

5222       Sinking Fund Lot : 5222 From 01 Jul 2026 - 30 Sep 2026                                                 174,141

           GRAND TOTAL NOW DUE                                                                                    174,141
`;

const u = parseUtilityInvoice(UTILITY_TEXT);
assert.strictEqual(u.key, '2026-06');
assert.strictEqual(u.elec.consumedKwh, 771.2);
assert.strictEqual(u.elec.subtotal, 1493375);
assert.strictEqual(u.water.subtotal, 95172);
assert.strictEqual(u.ipl, 1741410);
assert.strictEqual(u.ppn, 366295);

const s = parseSinkingFundInvoice(SF_TEXT);
assert.strictEqual(s.key, '2026-06'); // invoice month - 1
assert.strictEqual(s.sinkingFund, 174141);

const month = Object.assign({ sinkingFund: s.sinkingFund }, u);
assert.strictEqual(grandTotal(month), 3870393); // matches the sheet row

// Node encrypt → Node decrypt
const enc = encrypt({ months: [month] }, 'hunter2');
assert.strictEqual(decrypt(enc, 'hunter2').months[0].key, '2026-06');
assert.throws(() => decrypt(enc, 'wrong'));

// Node encrypt → WebCrypto decrypt (exactly what index.html does)
(async () => {
  const { subtle } = require('crypto').webcrypto;
  const p = JSON.parse(enc);
  const b64 = (x) => Buffer.from(x, 'base64');
  const km = await subtle.importKey('raw', Buffer.from('hunter2'), 'PBKDF2', false, ['deriveBits']);
  const bits = await subtle.deriveBits({ name: 'PBKDF2', salt: b64(p.salt), iterations: p.iter, hash: 'SHA-256' }, km, 256);
  const key = await subtle.importKey('raw', bits, 'AES-GCM', false, ['decrypt']);
  const pt = await subtle.decrypt({ name: 'AES-GCM', iv: b64(p.iv) }, key, b64(p.ct));
  assert.strictEqual(JSON.parse(Buffer.from(pt).toString()).months[0].elec.subtotal, 1493375);
  console.log('all checks pass');
})();
