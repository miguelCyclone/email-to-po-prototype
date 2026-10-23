import { createHash } from 'node:crypto';
import { simpleParser } from 'mailparser';

export type ParsedMail = { sender: string; messageId: string | null; subject: string; receivedAt: string; body: string; attachments: { name: string; content: Buffer }[]; referenceNames: string[] };
export const emailContentHash = (mail: ParsedMail): string => createHash('sha256').update(JSON.stringify({
  sender: mail.sender, subject: mail.subject, body: mail.body,
  attachments: mail.attachments.map(a => [a.name, createHash('sha256').update(a.content).digest('hex')])
})).digest('hex');
export async function parseMail(raw: Buffer): Promise<ParsedMail> {
  const parsed = await simpleParser(raw);
  const sender = parsed.from?.value[0]?.address?.toLowerCase() ?? '';
  if (!sender) throw new Error('Email has no sender address');
  const body = parsed.text ?? '';
  return {
    sender,
    messageId: parsed.messageId?.trim().replace(/^<|>$/g, '') || null,
    subject: parsed.subject ?? '(no subject)',
    receivedAt: parsed.date?.toISOString() ?? new Date().toISOString(),
    body,
    attachments: parsed.attachments.filter(a => a.contentType === 'application/pdf' || a.filename?.toLowerCase().endsWith('.pdf')).map(a => ({ name: a.filename ?? 'attachment.pdf', content: a.content })),
    referenceNames: [...body.matchAll(/\[Attachment:\s*([^\]\r\n]+\.pdf)\s*\]/gi)].map(m => m[1].trim())
  };
}
