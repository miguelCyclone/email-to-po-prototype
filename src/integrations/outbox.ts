import type { Issue, Validated } from '../../schema/contracts.js';
export function clarification(id: string, issues: Issue[]): string {
  return `Hello,\n\nPlease provide or correct these details for purchase request ${id}:\n${issues.map(i => `- ${i.detail}`).join('\n')}\n\nReply with reference ${id}.`;
}
export function confirmationSummary(id: string, revision: number, value: Validated): string {
  return `Please check request ${id}, revision ${revision}:\nSupplier: ${value.supplier_name} (${value.supplier_id})\nCost centre: ${value.cost_centre}\nGL account: ${value.gl_account ?? 'not supplied'}\nDelivery date: ${value.requested_delivery_date}\nItems:\n${value.line_items.map(l => `- ${l.quantity} ${l.unit} ${l.item_name} @ ${l.unit_price} ${value.currency}`).join('\n')}\nTax: ${value.tax_amount}; freight: ${value.freight_amount}; discount: ${value.discount_amount}\nTotal: ${value.total} ${value.currency} (CHF ${(value.total_chf_minor / 100).toFixed(2)}).\n\nConfirm this exact revision in the demo requester view. This message is a draft and was not sent.`;
}
