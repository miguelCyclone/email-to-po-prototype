import { simpleParser } from 'mailparser';

export type ParsedMail = { sender: string; subject: string; receivedAt: string; body: string; attachments: { name: string; content: Buffer }[]; referenceNames: string[] };
export async function parseMail(raw: Buffer): Promise<ParsedMail> {
  const parsed = await simpleParser(raw);
  const sender = parsed.from?.value[0]?.address?.toLowerCase() ?? '';
  if (!sender) throw new Error('Email has no sender address');
  const body = parsed.text ?? '';
  return {
    sender,
    subject: parsed.subject ?? '(no subject)',
    receivedAt: parsed.date?.toISOString() ?? new Date().toISOString(),
    body,
    attachments: parsed.attachments.filter(a => a.contentType === 'application/pdf' || a.filename?.toLowerCase().endsWith('.pdf')).map(a => ({ name: a.filename ?? 'attachment.pdf', content: a.content })),
    referenceNames: [...body.matchAll(/\[Attachment:\s*([^\]\r\n]+\.pdf)\s*\]/gi)].map(m => m[1].trim())
  };
}
