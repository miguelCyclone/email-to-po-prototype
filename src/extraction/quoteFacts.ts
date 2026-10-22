import { Decimal } from 'decimal.js';
import type { Draft } from '../../schema/contracts.js';

const numeric = (text: string): string => text.replace(/[',]/g, '');
function isoDate(text: string): string | null {
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const match = text.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  return match ? `${match[3]}-${match[2].padStart(2, '0')}-${match[1].padStart(2, '0')}` : null;
}
type Row = { name: string; quantity: string; unit: string; unitPrice: string; total: string };
export function quoteFacts(text: string): { expiry: string | null; total: string | null; tax: string | null; currency: string | null; rows: Row[] } {
  const expiryLine = text.split(/\r?\n/).find(line => /(?:valid until|gültig bis|gueltig bis|valid through)\s*:/i.test(line));
  const expiryText = expiryLine?.match(/(?:valid until|gültig bis|gueltig bis|valid through)\s*:\s*(\d{1,4}[.-]\d{1,2}[.-]\d{2,4})/i)?.[1];
  const expiry = expiryText ? isoDate(expiryText) : null;
  const rows: Row[] = [];
  let total: string | null = null;
  let tax: string | null = null;
  let currency: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    const ending = trimmed.match(/([\d,.'’]+)\s*(CHF|EUR|USD|GBP)?\s*$/i);
    if (ending && /^(?:total\b|grand total\b|gesamtbetrag\b)/i.test(trimmed)) { total = numeric(ending[1].replace(/[’]/g, '')); currency = ending[2]?.toUpperCase() ?? null; }
    if (ending && /^(?:VAT\b|MwSt\b|USt\b)/i.test(trimmed) && /%/.test(trimmed)) tax = numeric(ending[1].replace(/[’]/g, ''));
    const parts = line.trim().split(/\s{2,}/).filter(Boolean);
    if (parts.length < 4) continue;
    const tail = parts.slice(-4);
    const [quantity, unit, unitPrice, lineTotal] = tail;
    if (!/^\d[\d',]*$/.test(quantity) || !/^(?:pcs|pc|stk|stück|stueck|m|kg|g|l|lot|set|sets|ea|unit|units|box|boxes|h|hrs)$/i.test(unit)) continue;
    if (!/^\d[\d',.]*(?:\s*\/\s*\d+)?$/.test(unitPrice) || !/^\d[\d',.]*$/.test(lineTotal)) continue;
    const description = parts.slice(0, -4).join(' ').replace(/^\d+\s+/, '').trim();
    const priceParts = unitPrice.split(/\s*\/\s*/);
    const per = priceParts.length === 2 ? Number(priceParts[1]) : 1;
    if (!Number.isInteger(per) || per <= 0) continue;
    const price = new Decimal(numeric(priceParts[0])).div(per);
    if (!price.isFinite() || price.lessThan(0)) continue;
    rows.push({ name: description, quantity: numeric(quantity), unit, unitPrice: price.toString(), total: numeric(lineTotal) });
  }
  return { expiry, total, tax, currency, rows };
}

export function reconcileQuote(draft: Draft, text: string, knownSuppliers: string[] = []): Draft {
  if (!text.trim()) return draft;
  const facts = quoteFacts(text);
  const result: Draft = { ...draft, line_items: draft.line_items.map(line => ({ ...line })), evidence: [...draft.evidence], conflicts: [...draft.conflicts] };
  const suppliers = knownSuppliers.filter(name => text.slice(0, 600).toLowerCase().includes(name.toLowerCase()));
  if (suppliers.length === 1) {
    if (result.supplier_name && result.supplier_name.toLowerCase() !== suppliers[0].toLowerCase()) result.conflicts.push({ field: 'supplier_name', email_value: result.supplier_name, quote_value: suppliers[0] });
    result.supplier_name = suppliers[0];
  }
  if (facts.currency) {
    if (result.currency && result.currency.toUpperCase() !== facts.currency) result.conflicts.push({ field: 'currency', email_value: result.currency, quote_value: facts.currency });
    result.currency = facts.currency;
  }
  if (facts.expiry) {
    result.quote_valid_until = facts.expiry;
    result.evidence.push({ field: 'quote_valid_until', source: 'quote', excerpt: `Valid until: ${facts.expiry}` });
  }
  if (facts.total) { result.stated_total = facts.total; result.evidence.push({ field: 'stated_total', source: 'quote', excerpt: `Total: ${facts.total}` }); }
  if (facts.tax) { result.tax_amount = facts.tax; result.evidence.push({ field: 'tax_amount', source: 'quote', excerpt: `Tax: ${facts.tax}` }); }
  if (facts.rows.length && facts.rows.length !== result.line_items.length) result.conflicts.push({ field: 'line_items', email_value: `${result.line_items.length} extracted lines`, quote_value: `${facts.rows.length} quoted lines` });
  if (facts.rows.length && facts.rows.length === result.line_items.length) {
    for (const [index, row] of facts.rows.entries()) {
      const line = result.line_items[index];
      line.quantity = row.quantity;
      line.unit = row.unit;
      line.unit_price = row.unitPrice;
      const calculated = new Decimal(row.quantity).times(row.unitPrice).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
      if (calculated.minus(row.total).abs().greaterThan(0.01)) result.conflicts.push({ field: `line_items[${index + 1}].total`, email_value: calculated.toFixed(2), quote_value: row.total });
      if (!line.item_name && row.name) line.item_name = row.name;
      if (/^\d+$/.test(line.item_code ?? '')) line.item_code = null;
      result.evidence.push({ field: `line_items[${index + 1}]`, source: 'quote', excerpt: `${row.name || line.item_name}: ${row.quantity} ${row.unit} @ ${row.unitPrice}` });
    }
  }
  return result;
}
