import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const day = (offset: number): string => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
const path = resolve('data/demo_current.eml');
const date = new Date().toUTCString();
const demoDay = new Date().toISOString().slice(0, 10);
const body = `From: Tobias Weber <tobias.weber@customer.com>\nTo: procurement@customer.com\nSubject: Current demo request for relays\nDate: ${date}\nMessage-ID: <demo-relays-${demoDay}@customer.com>\nMIME-Version: 1.0\nContent-Type: text/plain; charset=UTF-8\n\nHello Procurement,\n\nPlease buy from SwissElectro AG for cost centre CC-1001:\n2 pcs industrial relays at CHF 600.00 each. Total CHF 1200.00.\nTax CHF 0.00; freight CHF 0.00; discount CHF 0.00.\nWe need delivery on ${day(35)}. The supplier's quote is valid until ${day(20)}.\n\nThanks,\nTobias\n`;
mkdirSync(resolve('data'), { recursive: true });
writeFileSync(path, body);
console.log(path);
