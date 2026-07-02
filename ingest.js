#!/usr/bin/env node
// U-Residence expense ingester.
//   node ingest.js --seed sheet.csv      seed data.enc from the Google Sheet CSV export
//   node ingest.js bill.pdf [bill2.pdf]  add a month from invoice PDF(s) (needs pdftotext)
//   node ingest.js --rekey               change the password
//   node ingest.js --dump                print decrypted JSON
// Password is prompted (hidden), or taken from env URES_PASSWORD.
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ENC_FILE = path.join(__dirname, 'data.enc');
const ITER = 310000;

// ---------- crypto ----------
function encrypt(json, password) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.pbkdf2Sync(password, salt, ITER, 32, 'sha256');
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify(json), 'utf8'), cipher.final(), cipher.getAuthTag()]);
  return JSON.stringify({ v: 1, iter: ITER, salt: salt.toString('base64'), iv: iv.toString('base64'), ct: ct.toString('base64') });
}
function decrypt(encText, password) {
  const { iter, salt, iv, ct } = JSON.parse(encText);
  const key = crypto.pbkdf2Sync(password, Buffer.from(salt, 'base64'), iter, 32, 'sha256');
  const buf = Buffer.from(ct, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(buf.subarray(buf.length - 16));
  return JSON.parse(Buffer.concat([decipher.update(buf.subarray(0, buf.length - 16)), decipher.final()]).toString('utf8'));
}

// ---------- parsing helpers ----------
const num = (s) => parseFloat(String(s).replace(/[Rp,%\s]/g, '').replace(/,/g, ''));
const MONTHS = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };
const monthKey = (y, m) => `${y}-${String(m).padStart(2, '0')}`;

function req(text, re, what) {
  const m = text.match(re);
  if (!m) throw new Error(`could not find ${what} in PDF text`);
  return m;
}
function check(label, got, want) {
  if (Math.round(got) !== Math.round(want)) throw new Error(`sanity check failed: ${label} — parsed ${got}, expected ${want}. PDF layout may have changed; fix ingest.js before trusting this.`);
}

// Parse the utility invoice (electricity + water, optionally IPL). Returns partial month.
function parseUtilityInvoice(text) {
  const [, monName, year] = req(text, /Electricity\s+([A-Za-z]+)\s+(\d{4})/, 'billing month');
  const key = monthKey(+year, MONTHS[monName.slice(0, 3)]);
  const kva = num(req(text, /DAYA\s*:\s*([\d.,]+)\s*KVA/, 'DAYA')[1]);
  const startKwh = num(req(text, /START\s*:\s*([\d.,]+)\s*KWH/, 'START KWH')[1]);
  const finalKwh = num(req(text, /FINAL\s*:\s*([\d.,]+)\s*KWH/, 'FINAL KWH')[1]);
  const consumedKwh = num(req(text, /CONSUMED\s*:\s*([\d.,]+)\s*KWH/, 'CONSUMED KWH')[1]);
  const [, , rateStr, energyStr] = req(text, /KWH CONSUMED\s*:\s*([\d.,]+)\s*X\s*([\d.,]+)\s+([\d,]+)/, 'KWH CONSUMED line');
  const elecRate = num(rateStr), energy = num(energyStr);
  const maintenance = num(req(text, /([\d,]+)\s*\n\s*BIAYA PEMELIHARAAN/, 'maintenance fee')[1]);
  const preSub = num(req(text, /BIAYA PEMELIHARAAN JARINGAN\s*:\s*\n\s*([\d,]+)/, 'electricity pre-PPJ subtotal')[1]);
  const ppj = num(req(text, /([\d,]+)\s*\n\s*PPJ\s/, 'PPJ amount')[1]);
  const subTotals = [...text.matchAll(/SUB TOTAL\s+([\d,]+)/g)].map((m) => num(m[1]));
  if (subTotals.length < 2) throw new Error('expected at least 2 SUB TOTAL lines (electricity, water)');
  const [elecSub, waterSub] = subTotals;
  check('energy + maintenance', energy + maintenance, preSub);
  check('electricity subtotal', preSub + ppj, elecSub);

  const abodement = num(req(text, /ABODEMENT\s+([\d,]+)/, 'water abodement')[1]);
  const startM3 = num(req(text, /START\s*:\s*([\d.,]+)\s*M3/, 'START M3')[1]);
  const finalM3 = num(req(text, /FINAL\s*:\s*([\d.,]+)\s*M3/, 'FINAL M3')[1]);
  const consumedM3 = num(req(text, /CONSUMED\s*:\s*([\d.,]+)\s*M3/, 'CONSUMED M3')[1]);
  const waterRate = num(req(text, /M3 CONSUMPTION\s*:\s*[\d.,]+\s*X\s*([\d.,]+)/, 'water rate')[1]);
  const waterUse = num(req(text, /([\d,]+)\s*\n\s*M3 CONSUMPTION/, 'water consumption amount')[1]);
  check('water subtotal', abodement + waterUse, waterSub);

  let ipl = 0;
  const iplMatch = text.match(/Iuran Pengelolaan\s*\n\s*([\d,]+)/);
  if (iplMatch) {
    ipl = num(iplMatch[1]);
    check('IPL subtotal', ipl, subTotals[2]);
  }
  const total = num(req(text, /^\s*TOTAL\s+([\d,]+)/m, 'TOTAL')[1]);
  const ppn = num(req(text, /\nPPN\s+([\d,]+)/, 'PPN')[1]);
  const grand = num(req(text, /GRAND TOTAL NOW DUE\s+([\d,]+)/, 'GRAND TOTAL')[1]);
  check('invoice total', elecSub + waterSub + ipl, total);
  check('invoice grand total', total + ppn, grand);

  return {
    key,
    elec: { kva, startKwh, finalKwh, consumedKwh, rate: elecRate, energy, maintenance, ppj, subtotal: elecSub },
    water: { abodement, startM3, finalM3, consumedM3, rate: waterRate, consumption: waterUse, subtotal: waterSub },
    ipl, ppn,
  };
}

// Parse the sinking-fund invoice. Month = invoice month - 1 (bills the coming quarter,
// booked on the same row as the utility invoice issued the same day).
function parseSinkingFundInvoice(text) {
  const sf = num(req(text, /Sinking Fund Lot\s*:\s*\d+[^\n]*?([\d,]+)\s*\n/, 'sinking fund amount')[1]);
  const grand = num(req(text, /GRAND TOTAL NOW DUE\s+([\d,]+)/, 'GRAND TOTAL')[1]);
  check('sinking fund grand total', sf, grand);
  const [, d, m, y] = req(text, /Invoice Date\s*:\s*(\d{2})\/(\d{2})\/(\d{4})/, 'invoice date');
  const prev = new Date(+y, +m - 2, 1); // month is 1-based in the PDF, -2 = previous month, 0-based
  return { key: monthKey(prev.getFullYear(), prev.getMonth() + 1), sinkingFund: sf };
}

function parsePdf(file) {
  const text = execFileSync('pdftotext', ['-layout', file, '-'], { encoding: 'utf8' });
  return /Sinking Fund Lot/.test(text) ? parseSinkingFundInvoice(text) : parseUtilityInvoice(text);
}

// ---------- CSV seed ----------
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQ = false;
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field.replace(/\r$/, '')); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function seedFromCsv(file) {
  const rows = parseCsv(fs.readFileSync(file, 'utf8'));
  const header = rows[0];
  const col = (r, name) => r[header.indexOf(name)];
  return rows.slice(1).filter((r) => r.length > 1 && col(r, 'month-year')).map((r) => {
    const month = {
      key: monthKey(num(col(r, 'year')), num(col(r, 'month'))),
      elec: {
        kva: num(col(r, 'elec-daya-kva')), startKwh: num(col(r, 'elec-start-kwh')), finalKwh: num(col(r, 'elec-final-kwh')),
        consumedKwh: num(col(r, 'elec-consumed')), rate: num(col(r, 'elec-kwh-consumed-multiplier')),
        energy: num(col(r, 'elec-kwh-consumed-med')), maintenance: num(col(r, 'elec-biaya-pemeliharaan-jaringan')),
        ppj: num(col(r, 'elec-ppj')), subtotal: num(col(r, 'elec-total')),
      },
      water: {
        abodement: num(col(r, 'water-abodement')), startM3: num(col(r, 'water-start-m3')), finalM3: num(col(r, 'water-final-m3')),
        consumedM3: num(col(r, 'water-consumed-m3')), rate: num(col(r, 'water-m3-consumption-multiplier')),
        consumption: num(col(r, 'water-m3-consumption')), subtotal: num(col(r, 'water-subtotal')),
      },
      ipl: num(col(r, 'ipl')), sinkingFund: num(col(r, 'sinking-fund')), ppn: num(col(r, 'ppn')),
    };
    // ponytail: sheet totals are hand-typed — warn on mismatch, trust the components
    if (Math.round(grandTotal(month)) !== Math.round(num(col(r, 'grand-total'))))
      console.warn(`warning: ${month.key} sheet grand-total ${num(col(r, 'grand-total')).toLocaleString()} != component sum ${grandTotal(month).toLocaleString()} — using component sum`);
    return month;
  });
}

const grandTotal = (m) => (m.elec ? m.elec.subtotal : 0) + (m.water ? m.water.subtotal : 0) + (m.ipl || 0) + (m.sinkingFund || 0) + (m.ppn || 0);

// ---------- password prompt ----------
function promptHidden(question) {
  if (process.env.URES_PASSWORD) return Promise.resolve(process.env.URES_PASSWORD);
  return new Promise((resolve) => {
    process.stdout.write(question);
    const stdin = process.stdin;
    stdin.resume();
    stdin.setRawMode(true);
    let pw = '';
    const onData = (c) => {
      c = c.toString('utf8');
      if (c === '\r' || c === '\n') {
        stdin.setRawMode(false); stdin.pause(); stdin.off('data', onData);
        process.stdout.write('\n'); resolve(pw);
      } else if (c === '\u0003') process.exit(1);
      else if (c === '\u007f') pw = pw.slice(0, -1);
      else pw += c;
    };
    stdin.on('data', onData);
  });
}
async function newPassword() {
  const a = await promptHidden('New password: ');
  if (process.env.URES_PASSWORD) return a;
  const b = await promptHidden('Repeat password: ');
  if (a !== b) { console.error('Passwords do not match.'); process.exit(1); }
  if (!a) { console.error('Empty password.'); process.exit(1); }
  return a;
}
async function loadData() {
  const pw = await promptHidden('Password: ');
  try {
    return { data: decrypt(fs.readFileSync(ENC_FILE, 'utf8'), pw), pw };
  } catch {
    console.error('Wrong password (or corrupt data.enc).'); process.exit(1);
  }
}
function save(data, pw) {
  data.months.sort((a, b) => a.key.localeCompare(b.key));
  fs.writeFileSync(ENC_FILE, encrypt(data, pw));
}

// ---------- main ----------
async function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--seed') {
    const months = seedFromCsv(args[1]);
    save({ months }, await newPassword());
    console.log(`Seeded ${months.length} months into data.enc`);
  } else if (args[0] === '--rekey') {
    const { data } = await loadData();
    save(data, await newPassword());
    console.log('Re-encrypted data.enc with new password.');
  } else if (args[0] === '--dump') {
    const { data } = await loadData();
    console.log(JSON.stringify(data, null, 2));
  } else if (args.length && !args[0].startsWith('--')) {
    const parsed = args.map(parsePdf);
    const { data, pw } = await loadData();
    for (const p of parsed) {
      let m = data.months.find((x) => x.key === p.key);
      if (!m) { m = { key: p.key, ipl: 0, sinkingFund: 0, ppn: 0 }; data.months.push(m); }
      Object.assign(m, p);
      console.log(`${p.key}: ${p.sinkingFund != null ? `sinking fund ${p.sinkingFund.toLocaleString()}` : `utilities updated, grand total ${grandTotal(m).toLocaleString()}`}`);
    }
    save(data, pw);
    console.log('data.enc updated. Commit and push to publish.');
  } else {
    console.log('Usage: node ingest.js --seed sheet.csv | bill.pdf [bill2.pdf] | --rekey | --dump');
    process.exit(1);
  }
}
if (require.main === module) main();
module.exports = { parseUtilityInvoice, parseSinkingFundInvoice, encrypt, decrypt, grandTotal, seedFromCsv };
