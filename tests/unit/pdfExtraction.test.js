// Unit test for the pdf-parse integration in routes/aiRoutes.js.
//
// This exists because of a real bug: pdf-parse jumped from v1 (a callable
// default export: `pdf(buffer)`) to v2 (a `PDFParse` class:
// `new PDFParse({data}).getText()`) with no compatibility shim. The old
// v1-style call (`(await import('pdf-parse')).default(dataBuffer)`) crashed
// with "pdf is not a function" on every single Quiz/Flashcard request - this
// test pins the fix by running the REAL pdf-parse package (not mocked)
// against a real PDF fixture, independent of the database or HTTP layer.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { extractFileText, findUploadedFilePath } from '../../routes/aiRoutes.js';

const UPLOAD_DIR = path.join(process.cwd(), 'public', 'uploads');
const PDF_FIXTURE = path.join(process.cwd(), 'tests', 'fixtures', 'sample.pdf');
const TXT_FIXTURE = path.join(process.cwd(), 'tests', 'fixtures', 'sample.txt');

function placeFixture(fileId, filename, fixture) {
  const dest = path.join(UPLOAD_DIR, `${fileId}-${filename}`);
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  fs.copyFileSync(fixture, dest);
  return dest;
}

describe('extractFileText (real pdf-parse, no mocks)', () => {
  it('extracts text from a real PDF using the installed pdf-parse API', async () => {
    const fileId = 'pdftest-' + Date.now();
    const dest = placeFixture(fileId, 'notes.pdf', PDF_FIXTURE);
    try {
      const text = await extractFileText(fileId);
      expect(typeof text).toBe('string');
      // Would throw "pdf is not a function" / return undefined before the fix -
      // asserting it's a non-empty string proves the v2 PDFParse API call works.
      expect(text.length).toBeGreaterThan(0);
    } finally {
      fs.unlinkSync(dest);
    }
  });

  it('throws UNSUPPORTED_TYPE for a non-PDF file', async () => {
    const fileId = 'pdftest-txt-' + Date.now();
    const dest = placeFixture(fileId, 'notes.txt', TXT_FIXTURE);
    try {
      await expect(extractFileText(fileId)).rejects.toMatchObject({ code: 'UNSUPPORTED_TYPE' });
    } finally {
      fs.unlinkSync(dest);
    }
  });

  it('throws NOT_FOUND when no uploaded file matches the id', async () => {
    await expect(extractFileText('no-such-file-id-' + Date.now())).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('findUploadedFilePath', () => {
  it('returns null when nothing matches', () => {
    expect(findUploadedFilePath('definitely-not-a-real-id-' + Date.now())).toBeNull();
  });
});
