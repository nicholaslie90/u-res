// Used by the ingest-mail workflow: decode the Apps Script response into numbered PDFs.
// node fetch-decode.js mail.json outDir
'use strict';
const fs = require('fs');
const path = require('path');

const [file, outDir] = process.argv.slice(2);
let res;
try { res = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw new Error('Apps Script did not return JSON (check MAIL_URL / deployment access)'); }
if (!Array.isArray(res.files)) throw new Error(`Apps Script error: ${res.error || 'no files array'}`);
// index-only names: attachment names come from email and are untrusted
res.files.forEach((f, i) => fs.writeFileSync(path.join(outDir, `${String(i).padStart(3, '0')}.pdf`), Buffer.from(f.data, 'base64')));
console.log(`${res.files.length} invoice PDF(s) fetched`);
