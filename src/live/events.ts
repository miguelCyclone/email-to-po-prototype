import { EventEmitter } from 'node:events';
export const events = new EventEmitter();
events.setMaxListeners(100);
export function publish(requestId: string, revision: number): void { events.emit('change', JSON.stringify({ request_id: requestId, revision })); }
