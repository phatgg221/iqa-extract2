/**
 * POST /api/extract - multipart form with a `file` field, returns JSON.
 *
 * The status code answers "did we manage to look at the document?", not
 * "did we like what we found". A document we read successfully and then
 * refused every line of is a 200 with a full body of refusals, because the
 * refusals are the result. Only a file we could never open is an error
 * status, and even then the body carries the real reason rather than a
 * generic message, because that reason has to reach the screen.
 */

import { extract, UnreadablePdfError } from '@/lib/extract/extract';
import type { ExtractionResult } from '@/lib/extract/types';

export const runtime = 'nodejs';
export const maxDuration = 60;

const MAX_BYTES = 25 * 1024 * 1024;

export type ApiErrorCode =
  | 'NO_FILE'
  | 'NOT_A_PDF'
  | 'FILE_TOO_LARGE'
  | 'PDF_UNREADABLE'
  | 'UNEXPECTED';

export interface ApiError {
  error: { code: ApiErrorCode; humanMessage: string };
}

export type ApiResponse = ExtractionResult | ApiError;

function fail(status: number, code: ApiErrorCode, humanMessage: string) {
  return Response.json({ error: { code, humanMessage } } satisfies ApiError, { status });
}

export async function POST(request: Request) {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return fail(
      400,
      'NO_FILE',
      'The upload did not arrive as a file. Please choose a PDF and try again.',
    );
  }

  const file = form.get('file');
  if (!(file instanceof File) || file.size === 0) {
    return fail(
      400,
      'NO_FILE',
      'No file was attached to the upload, so there was nothing to read.',
    );
  }

  if (file.size > MAX_BYTES) {
    return fail(
      413,
      'FILE_TOO_LARGE',
      `${file.name} is ${(file.size / 1024 / 1024).toFixed(1)} MB, which is over the ` +
        `25 MB limit this service accepts. Try splitting the document.`,
    );
  }

  const bytes = new Uint8Array(await file.arrayBuffer());

  // Checked before handing anything to the PDF library so that "you gave us a
  // Word document" reads as exactly that rather than as a parser stack trace.
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 1024));
  if (!head.includes('%PDF')) {
    return fail(
      415,
      'NOT_A_PDF',
      `${file.name} does not look like a PDF. The file does not begin with a PDF ` +
        `header, so it may be a different format or may have been damaged in transit.`,
    );
  }

  try {
    const result = await extract(bytes, file.name);
    return Response.json(result, { status: 200 });
  } catch (err) {
    if (err instanceof UnreadablePdfError) {
      return fail(
        422,
        'PDF_UNREADABLE',
        `${file.name} could not be opened. The PDF library reported: ` +
          `${err.message.replace(/\.$/, '')}. ` +
          `The file may be encrypted, password-protected or corrupt.`,
      );
    }

    // Deliberately surfaced rather than flattened into "something went wrong".
    // In production this would be paired with a server-side error report; the
    // point here is that the caller is told what actually happened.
    return fail(
      500,
      'UNEXPECTED',
      `Reading ${file.name} failed unexpectedly: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
