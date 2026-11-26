import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const server = fileURLToPath(new URL('../src/server.js', import.meta.url));
const version = '2025-11-25';
const initParams = (protocolVersion = version) => ({
  protocolVersion, capabilities: {}, clientInfo: { name: 'stdio-test', version: '1.0.0' },
});

function connect(t) {
  const child = spawn(process.execPath, [server], { stdio: ['pipe', 'pipe', 'pipe'] });
  const closed = once(child, 'close');
  const output = createInterface({ input: child.stdout });
  const responses = output[Symbol.asyncIterator]();
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
  const raw = (message) => child.stdin.write(message);
  const send = (message) => raw(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\r\n`);
  async function receive(id) {
    const frame = await responses.next();
    assert.equal(frame.done, false, `Expected ${id}, stderr: ${stderr}`);
    const response = JSON.parse(frame.value);
    assert.equal(response.jsonrpc, '2.0');
    assert.equal(response.id, id);
    return response;
  }
  let nextId = 1;
  function request(method, params) {
    const id = nextId++;
    send({ id, method, params });
    return receive(id);
  }
  async function finish() {
    child.stdin.end();
    assert.deepEqual(await closed, [0, null]);
    assert.equal((await responses.next()).done, true, 'Unexpected frame on stdout');
    assert.equal(stderr, '');
  }
  return { raw, send, receive, request, finish };
}

test('stdio negotiates, lists the four schemas, and calls every tool', { timeout: 6000 }, async (t) => {
  const client = connect(t);
  const init = await client.request('initialize', initParams());
  assert.deepEqual(init.result, {
    protocolVersion: version, capabilities: { tools: {} },
    serverInfo: { name: 'mcp-support-quote-starter', version: '1.0.0' },
  });
  client.send({ method: 'notifications/initialized' });
  const names = ['classify_ticket', 'calculate_quote', 'draft_support_reply', 'summarize_daily_tickets'];
  const tools = (await client.request('tools/list')).result.tools;
  assert.deepEqual(tools.map(({ name }) => name), names);
  for (const { inputSchema, annotations } of tools) {
    assert.equal(inputSchema.type, 'object');
    assert.equal(inputSchema.additionalProperties, false);
    assert.ok(inputSchema.required.length > 0);
    assert.equal(annotations.readOnlyHint, true);
  }

  async function call(name, args) {
    const response = await client.request('tools/call', { name, arguments: args });
    assert.ok(response.result, JSON.stringify(response));
    assert.ok(!response.result.isError, response.result.content[0].text);
    const { structuredContent, content } = response.result;
    assert.deepEqual(JSON.parse(content[0].text), structuredContent);
    return structuredContent;
  }
  const classification = await call('classify_ticket', { issueType: 'account', impact: 'blocked', workaroundAvailable: false });
  assert.equal(classification.priority, 'P2');
  assert.equal(classification.category, 'account');
  assert.equal(classification.sla.elapsedHours, 4);

  const quote = await call('calculate_quote', {
    currency: 'USD', items: [{ description: 'Workshop', quantity: 1, unitPriceMinor: 105 }], discountBps: 1000, taxBps: 2500,
  });
  assert.equal(quote.discountMinor, '11');
  assert.equal(quote.taxMinor, '24');
  assert.equal(quote.totalMinor, '118');

  const draft = await call('draft_support_reply', {
    language: 'ko', kind: 'quote', customerName: '이지우', topic: '설정 워크숍', details: '합계는 USD 1.18입니다.',
    nextStep: '진행을 원하시면 회신해 주세요.', signature: '예시 지원팀',
  });
  assert.equal(draft.subject, '[견적 안내] 설정 워크숍');
  assert.match(draft.body, /이지우님[\s\S]+USD 1\.18/);
  assert.equal(draft.reviewRequired, true);

  const daily = await call('summarize_daily_tickets', {
    date: '2026-02-28', tickets: [
      { id: 'A', createdAt: '2026-02-28T00:00:00Z', queue: 'Ops, "East"\nAM', category: 'quote', priority: 'P4', status: 'open' },
      { id: 'B', createdAt: '2026-03-01T00:00:00Z', queue: 'Quotes', category: 'quote', priority: 'P4', status: 'open' },
    ],
  });
  assert.equal(daily.included, 1);
  assert.equal(daily.outsideWindow, 1);
  assert.ok(daily.csv.includes('"Ops, ""East""\nAM",quote,P4,open,1\r\n'));
  assert.match(daily.markdown, /Tickets created on 2026-02-28 \(UTC\)/);
  await client.finish();
});

test('stdio keeps protocol errors, tool errors, and silent notifications distinct', { timeout: 6000 }, async (t) => {
  const client = connect(t);
  client.raw('{invalid JSON}\n');
  assert.equal((await client.receive(null)).error.code, -32700);
  client.raw('[]\n');
  assert.equal((await client.receive(null)).error.code, -32600);
  client.send({ id: 'ping-a', method: 'ping' });
  assert.deepEqual((await client.receive('ping-a')).result, {});
  assert.equal((await client.request('initialize', {})).error.code, -32602);
  const init = await client.request('initialize', initParams('2099-01-01'));
  assert.equal(init.result.protocolVersion, version);
  assert.equal((await client.request('tools/list')).error.code, -32002);
  client.send({ method: 'notifications/initialized' });
  client.send({ method: 'notifications/example' });
  assert.equal((await client.request('tools/list', { cursor: 'unissued' })).error.code, -32602);
  assert.equal((await client.request('unknown')).error.code, -32601);
  assert.equal((await client.request('tools/call', { name: 'unknown' })).error.code, -32602);
  assert.equal((await client.request('tools/call', { name: 'calculate_quote', arguments: [] })).error.code, -32602);
  const invalidToolInput = await client.request('tools/call', { name: 'calculate_quote', arguments: { currency: 'USD', items: [] } });
  assert.equal(invalidToolInput.result.isError, true);
  assert.match(invalidToolInput.result.content[0].text, /arguments\.items/);
  assert.deepEqual((await client.request('ping')).result, {});
  await client.finish();
});
