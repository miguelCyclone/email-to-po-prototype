import { Decimal } from 'decimal.js';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Draft, Issue, Validated } from '../../schema/contracts.js';

type Supplier = { id: string; name: string; status: string };
type CostCenter = { code: string; owner_employee_id: string; department: string };
type Employee = { id: string; email: string; role: string };
type Department = { code: string; head_employee_id: string };
export type Master = {
  _meta: { fx_rates_to_chf: Record<string, number> };
  suppliers: Supplier[];
  cost_centers: CostCenter[];
  departments: Department[];
  employees: Employee[];
  gl_accounts: { code: string; name: string }[];
};
export const master: Master = JSON.parse(readFileSync(new URL('../../master_data.json', import.meta.url), 'utf8')) as Master;
if (!master.suppliers?.length || !master.cost_centers?.length || !master.employees?.length || !master._meta?.fx_rates_to_chf) {
  throw new Error('Invalid master_data.json');
}

export const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const norm = (text: string): string => text.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
const present = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const money = (value: string): Decimal | null => {
  try {
    const amount = new Decimal(value.replace(/,/g, ''));
    return amount.isFinite() && amount.greaterThanOrEqualTo(0) ? amount : null;
  } catch { return null; }
};
export const validDate = (value: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.valueOf()) && d.toISOString().slice(0, 10) === value;
};
const today = (now: Date): string => now.toISOString().slice(0, 10);

export function validateDraft(draft: Draft, now: Date): { value: Validated | null; issues: Issue[] } {
  const issues: Issue[] = [];
  const add = (field: string, code: string, detail: string, kind: Issue['kind']): void => { issues.push({ field, code, detail, kind }); };
  for (const conflict of draft.conflicts ?? []) add(conflict.field, 'conflict', `${conflict.email_value} versus ${conflict.quote_value}`, 'procurement');

  let supplier: Supplier | undefined;
  if (!present(draft.supplier_name)) add('supplier_name', 'missing', 'Supplier name is required.', 'requester');
  else {
    const candidates = master.suppliers.filter(s => norm(s.name) === norm(draft.supplier_name!));
    if (candidates.length === 1) supplier = candidates[0];
    else if (candidates.length === 0) add('supplier_name', 'unknown_supplier', `Supplier ${draft.supplier_name} is not in master data.`, 'reject');
    else add('supplier_name', 'ambiguous_supplier', 'Supplier matches more than one record.', 'procurement');
    if (supplier && supplier.status !== 'active') add('supplier_name', 'inactive_supplier', `Supplier ${supplier.name} is ${supplier.status}.`, 'reject');
  }

  const cc = master.cost_centers.find(c => c.code === draft.cost_centre?.trim().toUpperCase());
  if (!present(draft.cost_centre)) add('cost_centre', 'missing', 'Cost centre is required.', 'requester');
  else if (!cc) add('cost_centre', 'invalid', `Unknown cost centre ${draft.cost_centre}.`, 'requester');

  const gl = draft.gl_account?.trim() || null;
  if (gl && !master.gl_accounts.some(account => account.code === gl)) add('gl_account', 'invalid', `Unknown GL account ${gl}.`, 'requester');

  const currency = draft.currency?.trim().toUpperCase();
  if (!currency) add('currency', 'missing', 'Currency is required.', 'requester');
  else if (!(currency in master._meta.fx_rates_to_chf)) add('currency', 'invalid', `Unsupported currency ${currency}.`, 'procurement');

  if (!present(draft.requested_delivery_date)) add('requested_delivery_date', 'missing', 'Requested delivery date is required (YYYY-MM-DD).', 'requester');
  else if (!validDate(draft.requested_delivery_date)) add('requested_delivery_date', 'invalid', 'Delivery date must be a real YYYY-MM-DD date.', 'requester');
  else if (draft.requested_delivery_date < today(now)) add('requested_delivery_date', 'past_date', 'Requested delivery date has passed.', 'procurement');

  if (present(draft.quote_valid_until)) {
    if (!validDate(draft.quote_valid_until)) add('quote_valid_until', 'invalid', 'Quote expiry must be a real YYYY-MM-DD date.', 'procurement');
    else if (draft.quote_valid_until < today(now)) add('quote_valid_until', 'expired_quote', 'Supplier quote has expired.', 'procurement');
  }

  if (!Array.isArray(draft.line_items) || !draft.line_items.length) add('line_items', 'missing', 'At least one priced line item is required.', 'requester');
  const lines: Validated['line_items'] = [];
  let subtotal = new Decimal(0);
  for (const [index, line] of (draft.line_items ?? []).entries()) {
    const label = `line_items[${index + 1}]`;
    if (!present(line.item_name)) add(`${label}.item_name`, 'missing', 'Item name is required.', 'requester');
    if (!present(line.unit)) add(`${label}.unit`, 'missing', 'Unit is required (for example pcs).', 'requester');
    if (!present(line.quantity)) add(`${label}.quantity`, 'missing', 'Quantity is required.', 'requester');
    if (!present(line.unit_price)) add(`${label}.unit_price`, 'missing', 'Unit price is required.', 'requester');
    const qty = present(line.quantity) ? money(line.quantity) : null;
    const price = present(line.unit_price) ? money(line.unit_price) : null;
    if (present(line.quantity) && (!qty || !qty.greaterThan(0))) add(`${label}.quantity`, 'invalid', 'Quantity must be positive.', 'requester');
    if (present(line.unit_price) && !price) add(`${label}.unit_price`, 'invalid', 'Unit price must be nonnegative.', 'requester');
    if (qty && price) subtotal = subtotal.plus(qty.times(price));
    if (present(line.item_name) && present(line.unit) && qty?.greaterThan(0) && price) lines.push({ item_name: line.item_name.trim(), quantity: qty.toString(), unit: line.unit.trim(), unit_price: price.toFixed(2), ...(present(line.item_code) ? { item_code: line.item_code.trim() } : {}) });
  }

  const charges: Record<'tax_amount' | 'freight_amount' | 'discount_amount', Decimal> = { tax_amount: new Decimal(0), freight_amount: new Decimal(0), discount_amount: new Decimal(0) };
  for (const field of Object.keys(charges) as (keyof typeof charges)[]) {
    const raw = draft[field];
    if (present(raw)) {
      const parsed = money(raw);
      if (!parsed) add(field, 'invalid', `${field} must be nonnegative.`, 'requester');
      else charges[field] = parsed;
    }
  }
  const computed = subtotal.plus(charges.tax_amount).plus(charges.freight_amount).minus(charges.discount_amount);
  if (computed.lessThanOrEqualTo(0)) add('total', 'invalid', 'Total must be positive.', 'requester');
  let stated: Decimal | null = null;
  if (present(draft.stated_total)) {
    stated = money(draft.stated_total);
    if (!stated) add('stated_total', 'invalid', 'Stated total must be nonnegative.', 'requester');
    else if (stated.minus(computed).abs().greaterThan(0.01)) add('stated_total', 'mismatch', `Stated total ${stated.toFixed(2)} differs from calculated total ${computed.toFixed(2)}.`, 'procurement');
  }
  if (issues.length || !supplier || !cc || !currency || !draft.requested_delivery_date) return { value: null, issues };
  const total = computed.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  const totalChf = total.times(master._meta.fx_rates_to_chf[currency]).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  return { value: {
    supplier_id: supplier.id, supplier_name: supplier.name, currency, total: total.toFixed(2), total_chf_minor: totalChf.times(100).toNumber(),
    requested_delivery_date: draft.requested_delivery_date, quote_valid_until: draft.quote_valid_until || null,
    cost_centre: cc.code, ...(gl ? { gl_account: gl } : {}), line_items: lines,
    tax_amount: charges.tax_amount.toFixed(2), freight_amount: charges.freight_amount.toFixed(2), discount_amount: charges.discount_amount.toFixed(2)
  }, issues };
}

export function issueState(issues: Issue[]): 'rejected' | 'review' | 'needs_info' {
  if (issues.some(i => i.kind === 'reject')) return 'rejected';
  if (issues.some(i => i.kind === 'procurement')) return 'review';
  return 'needs_info';
}

export function approvalChain(value: Validated, requesterEmail: string): { steps: { role: string; employee_id: string }[]; conflict: string | null } {
  const cc = master.cost_centers.find(c => c.code === value.cost_centre)!;
  const dep = master.departments.find(d => d.code === cc.department)!;
  const cents = value.total_chf_minor;
  const roles = ['cost_center_owner'];
  if (cents > 100000) roles.push('department_head');
  if (cents > 1000000) roles.push('finance');
  if (cents > 5000000) roles.push('cfo');
  if (cents > 25000000) roles.push('ceo');
  const steps: { role: string; employee_id: string }[] = [];
  for (const role of roles) {
    const employeeId = role === 'cost_center_owner' ? cc.owner_employee_id : role === 'department_head' ? dep.head_employee_id : master.employees.find(e => e.role === role)?.id;
    if (!employeeId) return { steps, conflict: `No employee for ${role}.` };
    if (steps.some(s => s.employee_id === employeeId)) continue;
    const employee = master.employees.find(e => e.id === employeeId);
    if (employee?.email.toLowerCase() === requesterEmail.toLowerCase() || (role === 'finance' && master.employees.some(e => e.role === 'finance' && e.email.toLowerCase() === requesterEmail.toLowerCase()))) {
      return { steps, conflict: `Self-approval conflict for ${role}; procurement must assign a reviewer.` };
    }
    steps.push({ role, employee_id: employeeId });
  }
  return { steps, conflict: null };
}
