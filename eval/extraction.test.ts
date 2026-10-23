import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { Decimal } from 'decimal.js';
import type { Draft } from '../schema/contracts.js';
import { parseMail } from '../src/intake/mail.js';
import { readPdf } from '../src/intake/pdfText.js';
import { extract } from '../src/extraction/ollama.js';
import { reconcileQuote } from '../src/extraction/quoteFacts.js';
import { master } from '../src/domain/policy.js';

// Human-labeled facts from the supplied source files. Null means the source does not state a usable value.
type ExpectedLine = { name: string; quantity: string; unitPrice: string | null };
type Case = {
  file: string;
  supplier: string | null;
  costCentre: string | null;
  currency?: string | null;
  deliveryDate: string | null;
  quoteValidUntil?: string | null;
  total?: string | null;
  lines: ExpectedLine[];
};
const cases: Case[] = [
  { file: 'email_01_clean_with_pdf', supplier: 'Acme Bearings GmbH', costCentre: 'CC-1002', currency: 'EUR', deliveryDate: null, quoteValidUntil: '2026-06-03', total: '1751.40', lines: [
    { name: '6205-2RS', quantity: '40', unitPrice: '8.50' }, { name: '30210', quantity: '12', unitPrice: '42' },
    { name: '22216', quantity: '4', unitPrice: '189.50' }, { name: 'grease', quantity: '6', unitPrice: '24.90' }
  ] },
  { file: 'email_02_inline_request', supplier: 'Office Plus Schweiz', costCentre: null, deliveryDate: null, lines: [
    { name: 'monitor', quantity: '6', unitPrice: null }
  ] },
  { file: 'email_04_ambiguous', supplier: null, costCentre: null, deliveryDate: null, lines: [] },
  { file: 'email_05', supplier: 'SwissElectro AG', costCentre: 'CC-2002', currency: 'CHF', deliveryDate: null, quoteValidUntil: '2026-06-06', total: '10485.70', lines: [
    { name: 'SCX-220', quantity: '1', unitPrice: '7450' }, { name: 'BP-10', quantity: '2', unitPrice: '1125' }
  ] },
  { file: 'email_06', supplier: 'Global Fastener Supply', costCentre: 'CC-1003', currency: 'USD', deliveryDate: null, total: '8400', lines: [
    { name: 'bolt', quantity: '20000', unitPrice: '0.21' }, { name: 'washer', quantity: '20000', unitPrice: '0.06' },
    { name: 'nut', quantity: '12000', unitPrice: '0.25' }
  ] },
  { file: 'email_08', supplier: 'Stahlhandel Wyss AG', costCentre: 'CC-1004', currency: 'CHF', deliveryDate: '2026-05-29', total: '3200', lines: [
    { name: 'Stahlplatte', quantity: '4', unitPrice: '480' }, { name: 'Rundstahl', quantity: '6', unitPrice: '95' },
    { name: 'Zuschnitt', quantity: '1', unitPrice: '710' }
  ] },
  { file: 'email_12', supplier: 'Office Plus Schweiz', costCentre: 'CC-3001', currency: 'CHF', deliveryDate: null, total: '999', lines: [
    { name: 'chair', quantity: '3', unitPrice: '333' }
  ] },
  { file: 'email_13', supplier: 'Office Plus Schweiz', costCentre: 'CC-3001', currency: 'CHF', deliveryDate: null, total: '1000', lines: [
    { name: 'lamp', quantity: '4', unitPrice: '85' }, { name: 'box', quantity: '12', unitPrice: '55' }
  ] },
  { file: 'email_14', supplier: 'Elektro Buehler', costCentre: 'CC-1002', currency: 'CHF', deliveryDate: null, total: '1001', lines: [
    { name: 'SK-12', quantity: '7', unitPrice: '143' }
  ] },
  { file: 'email_26', supplier: 'Verpackung Schneider', costCentre: 'CC-1005', currency: 'EUR', deliveryDate: '2026-05-29', total: '2100', lines: [
    { name: 'wrap', quantity: '800', unitPrice: '1.05' }, { name: 'film', quantity: '60', unitPrice: '12.50' },
    { name: 'silica', quantity: '85', unitPrice: '6' }
  ] }
];
const emailFolder = resolve('docs/emails-20261022T095541Z-1-001/emails');
const quoteFolder = resolve('docs/quotes-20261022T095543Z-1-001/quotes');

async function draftFor(file: string): Promise<{ draft: Draft; latencyMs: number }> {
  const mail = await parseMail(await readFile(join(emailFolder, `${file}.eml`)));
  const quotes = [...mail.attachments];
  for (const name of mail.referenceNames) {
    if (!quotes.some(quote => quote.name === name)) quotes.push({ name, content: await readFile(join(quoteFolder, name)) });
  }
  const quoteText = (await Promise.all(quotes.map(async quote => `\n--- ${quote.name} ---\n${(await readPdf(quote.content)).text}`))).join('');
  const result = await extract(mail.subject, mail.sender, mail.body, quoteText);
  return { draft: reconcileQuote(result.draft, quoteText, master.suppliers.map(supplier => supplier.name)), latencyMs: result.latencyMs };
}
function equalNumber(actual: string | null, expected: string): boolean {
  try { return actual !== null && new Decimal(actual.replace(/[',’]/g, '')).equals(new Decimal(expected)); }
  catch { return false; }
}
function compare(draft: Draft, expected: Case): string[] {
  const errors: string[] = [];
  if (expected.supplier === null ? draft.supplier_name !== null : !draft.supplier_name?.toLowerCase().includes(expected.supplier.toLowerCase()))
    errors.push(`supplier: expected ${expected.supplier}, got ${draft.supplier_name}`);
  if (draft.cost_centre !== expected.costCentre) errors.push(`cost centre: expected ${expected.costCentre}, got ${draft.cost_centre}`);
  if (draft.requested_delivery_date !== expected.deliveryDate) errors.push(`delivery date: expected ${expected.deliveryDate}, got ${draft.requested_delivery_date}`);
  if (expected.currency !== undefined && draft.currency !== expected.currency) errors.push(`currency: expected ${expected.currency}, got ${draft.currency}`);
  if (expected.quoteValidUntil !== undefined && draft.quote_valid_until !== expected.quoteValidUntil) errors.push(`quote expiry: expected ${expected.quoteValidUntil}, got ${draft.quote_valid_until}`);
  if (expected.total !== undefined && (expected.total === null ? draft.stated_total !== null : !equalNumber(draft.stated_total, expected.total)))
    errors.push(`total: expected ${expected.total}, got ${draft.stated_total}`);
  if (draft.line_items.length !== expected.lines.length) errors.push(`line count: expected ${expected.lines.length}, got ${draft.line_items.length}`);
  for (const [index, line] of expected.lines.entries()) {
    const got = draft.line_items[index];
    if (!got) continue;
    if (!got.item_name?.toLowerCase().includes(line.name.toLowerCase())) errors.push(`line ${index + 1} item: expected ${line.name}, got ${got.item_name}`);
    if (!equalNumber(got.quantity, line.quantity)) errors.push(`line ${index + 1} quantity: expected ${line.quantity}, got ${got.quantity}`);
    if (line.unitPrice === null ? got.unit_price !== null : !equalNumber(got.unit_price, line.unitPrice))
      errors.push(`line ${index + 1} unit price: expected ${line.unitPrice}, got ${got.unit_price}`);
  }
  return errors;
}

for (const expected of cases) {
  test(`live extraction: ${expected.file}`, { timeout: 120_000 }, async () => {
    const { draft, latencyMs } = await draftFor(expected.file);
    const errors = compare(draft, expected);
    console.log(`${expected.file}: ${errors.length ? 'FAIL' : 'PASS'} (${latencyMs} ms)${errors.length ? `\n  ${errors.join('\n  ')}` : ''}`);
    assert.deepEqual(errors, []);
  });
}
