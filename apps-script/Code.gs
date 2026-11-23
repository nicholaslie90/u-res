// Google Apps Script web app: hands the U-Residence invoice PDFs from Gmail to the
// GitHub Action (.github/workflows/ingest-mail.yml). Setup steps are in README.md.
// Script property TOKEN must match the repo secret MAIL_TOKEN.
const NAME_RE = /^BPU2-I[UR].*\.pdf$/i; // utility (IU) and sinking-fund (IR) invoices only

function doPost(e) {
  const want = PropertiesService.getScriptProperties().getProperty('TOKEN');
  if (!want || !e || e.parameter.token !== want) return json({ error: 'unauthorized' });
  const days = Math.min(Math.max(parseInt(e.parameter.days, 10) || 45, 1), 400);
  const files = [];
  for (const thread of GmailApp.search(`has:attachment filename:pdf newer_than:${days}d`))
    for (const msg of thread.getMessages())
      for (const a of msg.getAttachments())
        if (NAME_RE.test(a.getName()))
          files.push({ date: msg.getDate().toISOString(), data: Utilities.base64Encode(a.getBytes()) });
  files.sort((a, b) => a.date.localeCompare(b.date)); // oldest first, so a reissued invoice wins
  return json({ files });
}

const json = (o) => ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
