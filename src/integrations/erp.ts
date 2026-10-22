export async function postPurchaseOrder(payloadJson: string, key: string, url = process.env.MOCK_ERP_URL ?? 'http://127.0.0.1:8080/purchase-orders'): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
    body: payloadJson, signal: AbortSignal.timeout(15_000)
  });
  const body = await response.json() as Record<string, unknown>;
  if (!response.ok) throw new Error(`Mock ERP HTTP ${response.status}: ${JSON.stringify(body)}`);
  return body;
}
