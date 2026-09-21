/**
 * Tests for the job layer's edges.
 *
 * Both cases here are bugs that only appeared when the worker was actually
 * run against a real database — the sort that a mocked client would have
 * agreed with rather than caught.
 */

import { describe, expect, test } from 'vitest';
import { asClaimedJob } from '@/lib/jobs/process';
import { isTerminal, toStatusResponse, type JobRow } from '@/lib/jobs/types';

const row = (over: Partial<JobRow> = {}): JobRow => ({
  id: '227f89cc-4e5a-4401-bdfb-72633f344bd1',
  folder_name: 'f0bf203a',
  object_key: 'f0bf203a/KBS-10255.pdf',
  file_name: 'KBS-10255.pdf',
  byte_size: 2239,
  content_type: 'application/pdf',
  status: 'processing',
  page_count: 1,
  pages_done: 1,
  result: null,
  failure_code: null,
  failure_message: null,
  attempts: 1,
  line_item_count: 4,
  refusal_count: 3,
  created_at: '2026-09-21T00:00:00Z',
  uploaded_at: null,
  started_at: null,
  finished_at: null,
  ...over,
});

describe('reading the result of a claim', () => {
  test('treats an empty queue as no job', () => {
    // A function declared `returns extraction_jobs` gives SQL NULL when it
    // matches nothing, but PostgREST hands it back as an object with every
    // field null. Taking that at face value made the worker announce
    // "processing null" and crash, twice a second, forever.
    const emptyRow = Object.fromEntries(Object.keys(row()).map((k) => [k, null]));

    expect(asClaimedJob(emptyRow)).toBeNull();
    expect(asClaimedJob(null)).toBeNull();
    expect(asClaimedJob(undefined)).toBeNull();
  });

  test('accepts a row that has an id', () => {
    expect(asClaimedJob(row())?.id).toBe('227f89cc-4e5a-4401-bdfb-72633f344bd1');
  });
});

describe('what the browser is told', () => {
  test('a failed job always carries a reason, even if none was recorded', () => {
    const response = toStatusResponse(row({ status: 'failed' }));

    expect(response.failure).not.toBeNull();
    expect(response.failure!.humanMessage.length).toBeGreaterThan(20);
    expect(response.failure!.humanMessage).not.toMatch(/something went wrong/i);
  });

  test('a result is only handed over once the job actually succeeded', () => {
    expect(toStatusResponse(row({ status: 'processing' })).result).toBeNull();
    expect(toStatusResponse(row({ status: 'failed' })).result).toBeNull();
  });

  test('knows which states are the end of the road', () => {
    expect(isTerminal('succeeded')).toBe(true);
    expect(isTerminal('failed')).toBe(true);
    expect(isTerminal('queued')).toBe(false);
    expect(isTerminal('processing')).toBe(false);
  });
});
