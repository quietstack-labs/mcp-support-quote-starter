import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InputError, runTool } from '../src/tools.js';

const classify = (impact, workaroundAvailable) => runTool('classify_ticket', {
  issueType: 'technical', impact, workaroundAvailable,
});
const quote = (input) => runTool('calculate_quote', {
  currency: 'USD', items: [{ description: 'Setup', quantity: 1, unitPriceMinor: 105 }], ...input,
});
const draft = (input = {}) => runTool('draft_support_reply', {
  language: 'en', kind: 'resolution', customerName: 'Avery', topic: 'Sample portal',
  details: 'Your access has been restored.', nextStep: 'Please try signing in.', signature: 'Example Support', ...input,
});
const summarize = (tickets, date = '2026-02-28') => runTool('summarize_daily_tickets', { date, tickets });
const ticket = (id, createdAt = '2026-02-28T12:00:00Z', extra = {}) => ({
  id, createdAt, queue: 'Portal', category: 'technical', priority: 'P3', status: 'open', ...extra,
});

test('classify covers all priority boundaries and returns category and elapsed first-response target', () => {
  const cases = [
    ['outage', false, 'P1', 1], ['outage', true, 'P2', 4],
    ['blocked', false, 'P2', 4], ['blocked', true, 'P3', 24],
    ['degraded', false, 'P3', 24], ['degraded', true, 'P3', 24],
    ['question', false, 'P4', 72], ['question', true, 'P4', 72],
  ];
  for (const [impact, workaround, priority, hours] of cases) {
    const result = classify(impact, workaround);
    assert.equal(result.priority, priority);
    assert.equal(result.category, 'technical');
    assert.deepEqual(result.sla, { target: 'first_human_response', elapsedHours: hours, startsAt: 'ticket_received' });
    assert.ok(result.reason);
  }
});

test('classify rejects unknown impacts and requires a real Boolean', () => {
  assert.throws(() => classify('urgent', false), InputError);
  assert.throws(() => classify('outage', 'false'), InputError);
});

test('quote uses quantities, rounds the order discount half up, then taxes the discounted order', () => {
  const result = quote({
    items: [{ description: 'Session', quantity: 2, unitPriceMinor: 50 }, { description: 'Add-on', quantity: 1, unitPriceMinor: 5 }],
    discountBps: 1000, taxBps: 5000,
  });
  assert.deepEqual(result.lines.map((line) => line.subtotalMinor), ['100', '5']);
  assert.equal(result.subtotalMinor, '105');
  assert.equal(result.discountMinor, '11');
  assert.equal(result.taxableMinor, '94');
  assert.equal(result.taxMinor, '47');
  assert.equal(result.totalMinor, '141');
});

test('quote rounds tax once at order level and distinguishes below-half from half', () => {
  const items = [1, 2].map((n) => ({ description: `Item ${n}`, quantity: 1, unitPriceMinor: 1 }));
  assert.equal(quote({ items, taxBps: 2499 }).taxMinor, '0');
  assert.equal(quote({ items, taxBps: 2500 }).taxMinor, '1');
  assert.equal(quote({ items, taxBps: 5000 }).taxMinor, '1');
});

test('quote handles defaults, a full discount, a zero-price line and currency exponents', () => {
  const fullDiscount = quote({ currency: 'KRW', discountBps: 10000, taxBps: 10000 });
  assert.equal(fullDiscount.minorUnitDigits, 0);
  assert.equal(fullDiscount.taxMinor, '0');
  assert.equal(fullDiscount.totalMinor, '0');
  const zero = quote({ currency: 'KWD', items: [{ description: 'Included', quantity: 1, unitPriceMinor: 0 }] });
  assert.equal(zero.minorUnitDigits, 3);
  assert.equal(zero.discountBps, 0);
  assert.equal(zero.taxBps, 0);
  assert.equal(zero.totalMinor, '0');
});

test('quote returns exact decimal strings for totals larger than safe JSON integers', () => {
  const result = quote({ items: [{ description: 'Large', quantity: 100, unitPriceMinor: Number.MAX_SAFE_INTEGER }], taxBps: 10000 });
  assert.equal(result.lines[0].subtotalMinor, '900719925474099100');
  assert.equal(result.totalMinor, '1801439850948198200');
});

test('quote rejects unsupported currency, empty lines, invalid amounts, fractional rates and extra fields', () => {
  const line = { description: 'Example', quantity: 1, unitPriceMinor: 100 };
  for (const input of [
    { currency: 'ZZZ' }, { items: [] }, { taxBps: 10001 }, { discountBps: 1.5 },
    { items: [{ ...line, quantity: 0 }] }, { items: [{ ...line, quantity: 1.5 }] },
    { items: [{ ...line, unitPriceMinor: -1 }] }, { items: [{ ...line, unitPriceMinor: '100' }] },
    { items: [{ ...line, unitPriceMinor: Number.MAX_SAFE_INTEGER + 1 }] },
    { items: [{ ...line, currency: 'EUR' }] },
  ]) assert.throws(() => quote(input), InputError);
});

test('draft covers both kinds in both languages, preserves supplied facts and requests review', () => {
  for (const [language, kind, subjectPrefix] of [
    ['en', 'resolution', 'Support update:'], ['en', 'quote', 'Quote:'],
    ['ko', 'resolution', '[처리 결과]'], ['ko', 'quote', '[견적 안내]'],
  ]) {
    const result = draft({ language, kind });
    assert.ok(result.subject.startsWith(subjectPrefix));
    assert.ok(result.body.includes('Your access has been restored.'));
    assert.ok(result.body.includes('Please try signing in.'));
    assert.equal(result.reviewRequired, true);
    assert.match(result.reviewNote, /Before sending|발송 전에/);
  }
});

test('draft rejects multiline subjects and blank or missing content', () => {
  assert.throws(() => draft({ topic: 'Example\r\nNext line' }), InputError);
  assert.throws(() => draft({ topic: 'Example\n' }), InputError);
  assert.throws(() => draft({ details: '   ' }), InputError);
  assert.throws(() => draft({ nextStep: undefined }), InputError);
});

test('summary includes UTC start and excludes next midnight while grouping exact dimensions', () => {
  const result = summarize([
    ticket('before', '2026-02-27T23:59:59.999Z'), ticket('start', '2026-02-28T00:00:00Z'),
    ticket('same', '2026-02-28T23:59:59.999Z'), ticket('different', '2026-02-28T15:01:02.1Z', { status: 'pending' }),
    ticket('end', '2026-03-01T00:00:00Z'),
  ]);
  assert.deepEqual(result.window, { startInclusive: '2026-02-28T00:00:00.000Z', endExclusive: '2026-03-01T00:00:00.000Z' });
  assert.equal(result.included, 3);
  assert.equal(result.outsideWindow, 2);
  assert.equal(result.csv, 'queue,category,priority,status,count\r\nPortal,technical,P3,open,2\r\nPortal,technical,P3,pending,1\r\n');
  assert.match(result.markdown, /\| Portal \| technical \| P3 \| open \| 2 \|/);
});

test('summary preserves CSV comma, quotes and CRLF and escapes Markdown table cells', () => {
  const input = ticket('one', undefined, { queue: 'Ops, "East"\r\nA|B <QA>' });
  const result = summarize([input]);
  assert.equal(result.csv, 'queue,category,priority,status,count\r\n"Ops, ""East""\r\nA|B <QA>",technical,P3,open,1\r\n');
  assert.ok(result.markdown.includes('Ops, "East" ↵ A&#124;B &lt;QA&gt;'));
});

test('summary handles an empty leap day, rejects duplicate IDs and invalid dates and offsets', () => {
  const empty = summarize([], '2028-02-29');
  assert.equal(empty.included, 0);
  assert.equal(empty.csv, 'queue,category,priority,status,count\r\n');
  assert.match(empty.markdown, /No tickets in this window/);
  assert.throws(() => summarize([], '2026-02-29'), InputError);
  assert.throws(() => summarize([ticket('a', '2026-02-30T12:00:00Z')]), InputError);
  assert.throws(() => summarize([ticket('a', '2026-02-28T12:00:00+00:00')]), InputError);
  assert.throws(() => summarize([ticket('a'), ticket('a', '2026-03-01T00:00:00Z')]), InputError);
});
