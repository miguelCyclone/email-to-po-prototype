import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseMail } from '../src/intake/mail.js';
import { readPdf } from '../src/intake/pdfText.js';

async function check(): Promise<void> {
  const emails = resolve('docs/emails-20261022T095541Z-1-001/emails');
  const quotes = resolve('docs/quotes-20261022T095543Z-1-001/quotes');
  let emlOk = 0; let pdfOk = 0; const errors: string[] = [];
  for (const name of (await readdir(emails)).filter(n => n.endsWith('.eml'))) {
    try { await parseMail(await readFile(join(emails, name))); emlOk++; } catch (error) { errors.push(`${name}: ${String(error)}`); }
  }
  for (const name of (await readdir(quotes)).filter(n => n.endsWith('.pdf'))) {
    try { await readPdf(await readFile(join(quotes, name))); pdfOk++; } catch (error) { errors.push(`${name}: ${String(error)}`); }
  }
  console.log(JSON.stringify({ eml_ok: emlOk, pdf_ok: pdfOk, errors }, null, 2));
  if (errors.length) process.exitCode = 1;
}
void check();
