export class InputError extends Error {}

export const SLA_HOURS = Object.freeze({ P1: 1, P2: 4, P3: 24, P4: 72 });
const categories = ['technical', 'billing', 'account', 'quote', 'general'];
const currencies = { AUD: 2, CAD: 2, EUR: 2, GBP: 2, JPY: 0, KRW: 0, KWD: 3, USD: 2 };
const dayPattern = '^\\d{4}-\\d{2}-\\d{2}$';
const utcPattern = '^\\d{4}-\\d{2}-\\d{2}T(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d{1,3})?Z$';
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const object = (properties, required = Object.keys(properties)) => ({
  type: 'object', properties, required, additionalProperties: false,
});
const choice = (values) => ({ type: 'string', enum: values });
const integer = (minimum, maximum) => ({ type: 'integer', minimum, maximum });
const string = (maxLength, pattern = '\\S') => ({ type: 'string', maxLength, pattern });
const array = (items, minItems, maxItems) => ({ type: 'array', items, minItems, maxItems });
const describe = (schema, description) => ({ ...schema, description });

// Validate the same constraints advertised to MCP clients. These tools use only this schema subset.
function validate(schema, value, path = 'arguments') {
  const fail = (rule) => { throw new InputError(`${path} ${rule}`); };
  switch (schema.type) {
    case 'object':
      if (!isObject(value)) fail('must be an object');
      for (const name of schema.required) {
        if (!Object.hasOwn(value, name)) throw new InputError(`${path}.${name} is required`);
      }
      for (const [name, field] of Object.entries(value)) {
        if (!Object.hasOwn(schema.properties, name)) fail('contains an unsupported field');
        validate(schema.properties[name], field, `${path}.${name}`);
      }
      break;
    case 'array':
      if (!Array.isArray(value) || value.length < schema.minItems || value.length > schema.maxItems) {
        fail(`must be an array with ${schema.minItems} to ${schema.maxItems} entries`);
      }
      value.forEach((entry, index) => validate(schema.items, entry, `${path}[${index}]`));
      break;
    case 'string':
      if (typeof value !== 'string') fail('must be a string');
      if (schema.enum && !schema.enum.includes(value)) fail(`must be one of ${schema.enum.join(', ')}`);
      if (schema.pattern && (!new RegExp(schema.pattern, 'u').test(value) || [...value].length > schema.maxLength)) {
        fail(`must match the required format and be at most ${schema.maxLength} characters`);
      }
      break;
    case 'integer':
      if (!Number.isSafeInteger(value) || value < schema.minimum || value > schema.maximum) {
        fail(`must be an integer from ${schema.minimum} to ${schema.maximum}`);
      }
      break;
    case 'boolean':
      if (typeof value !== 'boolean') fail('must be a boolean');
      break;
  }
}

function classifyTicket({ issueType, impact, workaroundAvailable }) {
  let priority = 'P4';
  let reason = 'The ticket is informational and work can continue.';
  if (impact === 'outage' && !workaroundAvailable) {
    priority = 'P1';
    reason = 'A shared service is down for multiple users with no workaround.';
  } else if (impact === 'outage' || (impact === 'blocked' && !workaroundAvailable)) {
    priority = 'P2';
    reason = 'A shared service is down with a workaround, or a core task is blocked without one.';
  } else if (impact !== 'question') {
    priority = 'P3';
    reason = 'A core task has a workaround or work can continue despite degraded functionality.';
  }
  return {
    priority, category: issueType, reason,
    sla: { target: 'first_human_response', elapsedHours: SLA_HOURS[priority], startsAt: 'ticket_received' },
  };
}

function calculateQuote({ currency, items, discountBps = 0, taxBps = 0 }) {
  // Amounts are nonnegative, so adding half the divisor implements half-up rounding.
  const portion = (minor, bps) => (minor * BigInt(bps) + 5000n) / 10000n;
  let subtotal = 0n;
  const lines = items.map(({ description, quantity, unitPriceMinor }) => {
    const lineSubtotal = BigInt(quantity) * BigInt(unitPriceMinor);
    subtotal += lineSubtotal;
    return { description, quantity, unitPriceMinor: String(unitPriceMinor), subtotalMinor: String(lineSubtotal) };
  });
  const discount = portion(subtotal, discountBps);
  const taxable = subtotal - discount;
  const tax = portion(taxable, taxBps);
  return {
    currency, minorUnitDigits: currencies[currency], lines, discountBps, taxBps,
    subtotalMinor: String(subtotal), discountMinor: String(discount),
    taxableMinor: String(taxable), taxMinor: String(tax), totalMinor: String(taxable + tax),
  };
}

function draftSupportReply({ language, kind, customerName, topic, details, nextStep, signature }) {
  const name = customerName.trim();
  const context = topic.trim();
  const quote = kind === 'quote';
  if (language === 'ko') {
    return {
      subject: `[${quote ? '견적 안내' : '처리 결과'}] ${context}`,
      body: `안녕하세요, ${name}님.\n\n${quote ? '견적을 문의해 주셔서 감사합니다. 아래와 같이 안내드립니다.' : '기다려 주셔서 감사합니다. 문의하신 건의 처리 결과를 안내드립니다.'}\n\n${details.trim()}\n\n${nextStep.trim()}\n\n추가로 궁금한 점이 있으시면 이 메일에 회신해 주세요.\n감사합니다.\n${signature.trim()}`,
      reviewRequired: true,
      reviewNote: '발송 전에 수신자, 처리 내용, 금액과 조건, 다음 단계 및 서명을 확인해 주세요.',
    };
  }
  return {
    subject: `${quote ? 'Quote' : 'Support update'}: ${context}`,
    body: `Hi ${name},\n\n${quote ? 'Thank you for requesting a quote. Here are the details.' : 'Thank you for your patience. Here is the update on your support request.'}\n\n${details.trim()}\n\n${nextStep.trim()}\n\nPlease reply if you have any questions.\n\nBest,\n${signature.trim()}`,
    reviewRequired: true,
    reviewNote: 'Before sending, verify the recipient, resolution details, amounts and terms, next step, and signature.',
  };
}

function utcMidnight(day, path) {
  const instant = new Date(`${day}T00:00:00.000Z`);
  if (!Number.isFinite(+instant) || !instant.toISOString().startsWith(`${day}T`)) {
    throw new InputError(`${path} must be a real UTC calendar date`);
  }
  return instant;
}

const csvCell = (cell) => {
  const text = String(cell);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};
const markdownCell = (cell) => String(cell)
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('|', '&#124;')
  .replace(/\r\n|[\r\n]/g, ' ↵ ')
  .replace(/[\\`*_~\[\]!]/g, '\\$&');

function summarizeDailyTickets({ date, tickets }) {
  const start = utcMidnight(date, 'arguments.date');
  const end = new Date(+start + 86_400_000);
  const groups = new Map();
  const seen = new Set();
  let included = 0;
  for (const [index, ticket] of tickets.entries()) {
    const { id, createdAt, queue, category, priority, status } = ticket;
    if (seen.has(id)) throw new InputError(`arguments.tickets[${index}].id must be unique in the batch`);
    seen.add(id);
    utcMidnight(createdAt.slice(0, 10), `arguments.tickets[${index}].createdAt`);
    const instant = new Date(createdAt);
    if (instant < start || instant >= end) continue;
    const key = JSON.stringify([queue, category, priority, status]);
    groups.set(key, (groups.get(key) ?? 0) + 1);
    included++;
  }
  const columns = ['queue', 'category', 'priority', 'status', 'count'];
  const rows = [...groups.keys()].sort().map((key) => [...JSON.parse(key), groups.get(key)]);
  const csv = [columns, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
  const table = [columns, columns.map(() => '---'), ...rows]
    .map((row) => `| ${row.map(markdownCell).join(' | ')} |`).join('\n');
  const heading = `# Tickets created on ${date} (UTC)\n\nIncluded: ${included}. Outside window: ${tickets.length - included}.`;
  const markdown = `${heading}\n\n${rows.length ? table : 'No tickets in this window.'}\n`;
  return {
    window: { startInclusive: start.toISOString(), endExclusive: end.toISOString() },
    included, outsideWindow: tickets.length - included, markdown, csv,
  };
}

const singleLine = (max) => string(max, '^(?=[^\\x00-\\x1f\\x7f]*\\S)[^\\x00-\\x1f\\x7f\\u2028\\u2029]+$(?![\\s\\S])');
const exactString = (max, pattern) => string(max, `${pattern}(?![\\s\\S])`);
const tools = [
  {
    name: 'classify_ticket',
    description: 'Apply a sample ticket triage policy to a declared issue category and impact. Return priority and an elapsed-hours first-response target.',
    inputSchema: object({
      issueType: describe(choice(categories), 'Observed issue type, used as the category. Use general if uncertain.'),
      impact: describe(choice(['outage', 'blocked', 'degraded', 'question']), 'Outage: shared service down for multiple users. Blocked: a core task cannot proceed. Degraded: work can continue with friction. Question: informational.'),
      workaroundAvailable: describe({ type: 'boolean' }, 'Whether an effective workaround is already available.'),
    }),
    run: classifyTicket,
  },
  {
    name: 'calculate_quote',
    description: 'Calculate a single-currency quote from tax-exclusive integer minor unit prices. Apply an order discount before a single caller-supplied tax/VAT rate.',
    inputSchema: object({
      currency: describe(choice(Object.keys(currencies)), 'Currency of every line. No conversion.'),
      items: array(object({
        description: singleLine(200), quantity: integer(1, 1_000_000),
        unitPriceMinor: describe(integer(0, Number.MAX_SAFE_INTEGER), 'Price per unit in minor units, e.g. 1250 for USD 12.50.'),
      }), 1, 100),
      discountBps: describe(integer(0, 10000), 'Order discount in basis points, e.g. 1250 for 12.50%. Defaults to zero.'),
      taxBps: describe(integer(0, 10000), 'Tax/VAT rate in basis points for the full discounted subtotal. Defaults to zero.'),
    }, ['currency', 'items']),
    run: calculateQuote,
  },
  {
    name: 'draft_support_reply',
    description: 'Draft a support resolution or quote email in English or Korean using supplied facts. Returns a subject, body and mandatory human review reminder.',
    inputSchema: object({
      language: choice(['en', 'ko']), kind: choice(['resolution', 'quote']),
      customerName: singleLine(120), topic: singleLine(150),
      details: describe(string(4000), 'Approved resolution facts or quote amounts and terms in the desired language.'),
      nextStep: describe(string(1000), 'Known next action or follow-up text in the desired language.'),
      signature: singleLine(120),
    }),
    run: draftSupportReply,
  },
  {
    name: 'summarize_daily_tickets',
    description: 'Count tickets created within one UTC day, grouped by queue, category, priority and supplied status. Return a Markdown table and CSV text.',
    inputSchema: object({
      date: describe(exactString(10, dayPattern), 'UTC calendar day, YYYY-MM-DD.'),
      tickets: array(object({
        id: describe(singleLine(120), 'Unique identifier across the supplied batch.'),
        createdAt: describe(exactString(24, utcPattern), 'UTC timestamp YYYY-MM-DDTHH:mm:ssZ with optional 1–3 fractional digits.'),
        queue: string(160), category: choice(categories),
        priority: choice(Object.keys(SLA_HOURS)), status: choice(['open', 'pending', 'resolved']),
      }), 0, 1000),
    }),
    run: summarizeDailyTickets,
  },
];

export const toolList = tools.map(({ name, description, inputSchema }) => ({
  name, description, inputSchema,
  annotations: { readOnlyHint: true, openWorldHint: false },
}));
const toolsByName = new Map(tools.map((tool) => [tool.name, tool]));

export function hasTool(name) {
  return toolsByName.has(name);
}

export function runTool(name, args) {
  const tool = toolsByName.get(name);
  validate(tool.inputSchema, args);
  return tool.run(args);
}
