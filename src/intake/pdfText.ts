import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
const run = promisify(execFile);
export type PdfResult = { text: string; pages: number };
export class PdfLimitError extends Error {}
export async function readPdf(buffer: Buffer): Promise<PdfResult> {
  if (buffer.length > 2_000_000) throw new PdfLimitError('PDF exceeds 2 MB. Provide only relevant pages or the required fields.');
  const folder = await mkdtemp(join(tmpdir(), 'procurement-pdf-'));
  const path = join(folder, 'quote.pdf');
  try {
    await writeFile(path, buffer);
    const info = await run('pdfinfo', [path], { timeout: 10_000, maxBuffer: 100_000 });
    const pages = Number(info.stdout.match(/^Pages:\s*(\d+)/m)?.[1]);
    if (!Number.isInteger(pages) || pages < 1) throw new Error('PDF page count unavailable');
    if (pages > 5) throw new PdfLimitError('PDF exceeds 5 pages. Provide only relevant pages or the required fields.');
    const outputPath = join(folder, 'quote.txt');
    await run('pdftotext', ['-layout', path, outputPath], { timeout: 10_000, maxBuffer: 100_000 });
    const text = await readFile(outputPath, 'utf8');
    if (text.length > 8_000) throw new PdfLimitError('PDF text exceeds 8,000 characters. Provide a shorter quote or relevant pages.');
    if (!text.trim()) throw new Error('PDF has no extractable text; scanned PDF needs human review');
    return { text, pages };
  } finally { await rm(folder, { recursive: true, force: true }); }
}
