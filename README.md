# u-res

Private expense tracker for the U-Residence unit, hosted on GitHub Pages.
All data lives in `data.enc`, encrypted with AES-256-GCM (key derived from a
password via PBKDF2, 310k iterations). The site decrypts in the browser; after
one correct password entry the derived key is remembered on that device
(localStorage) and the dashboard opens instantly. The **Lock** button forgets it.

## Monthly workflow

Every month one utility invoice PDF arrives (electricity + water). Every
quarter (Dec/Mar/Jun/Sep consumption months) a second PDF arrives with the
sinking-fund bill, and the utility invoice also carries the quarterly IPL.

```sh
# regular month
node ingest.js ~/Downloads/BPU2-IUxxxxxxx_1.pdf

# quarter month — pass both
node ingest.js ~/Downloads/BPU2-IUxxxxxxx_1.pdf ~/Downloads/BPU2-IRxxxxxxx_1.pdf

git commit -am "add month" && git push
```

`ingest.js` needs `pdftotext` (`brew install poppler`) and prompts for the
password. Every parsed value is cross-checked against the invoice's own
subtotals — a layout change fails loudly instead of storing bad numbers.

## Automatic ingest from Gmail

`.github/workflows/ingest-mail.yml` runs daily at 08:00 WIB (or on demand from the
Actions tab, with a look-back `days` input). It calls the Apps Script web app in
`apps-script/Code.gs`, which returns `BPU2-IU*/BPU2-IR*.pdf` attachments from Gmail.
The workflow then runs `ingest.js` on each PDF and commits `data.enc` only if the data
changed. PDFs are never committed and amounts are never logged, because Actions logs
on a public repo are public.

Setup (one time):
1. Go to script.google.com and create a new project. Paste in `apps-script/Code.gs`.
   Under Project Settings → Script properties, add `TOKEN` = a long random string.
2. Deploy → New deployment → Web app. Set Execute as: **Me**, Who has access:
   **Anyone**, then authorize Gmail access. Copy the `/exec` URL.
3. Add the repo secrets `MAIL_URL` (the /exec URL), `MAIL_TOKEN` (the same TOKEN) and
   `URES_PASSWORD`.

## Other commands

```sh
node ingest.js --seed sheet.csv   # one-time seed from the Google Sheet CSV export
node ingest.js --rekey            # change the password
node ingest.js --dump             # print decrypted JSON
node test.js                      # self-check (parsers + crypto roundtrip)
```

The password never leaves the machine; only `data.enc` is committed.
