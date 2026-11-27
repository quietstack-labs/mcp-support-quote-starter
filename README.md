# MCP Support & Quote Starter

Run a local MCP server for ticket triage, quote calculations, support email drafts, and daily ticket reports. The JavaScript source uses ES modules and Node built-ins. The server has no npm dependencies, API keys, network calls, persistent storage, or email delivery. Your MCP client or model provider may handle inputs and results under its own data policies.

> 💼 **Get the packaged kit on Gumroad:** [MCP Support & Quote Starter Kit ($49)](https://playmaster72.gumroad.com/l/mcp-support-quote-starter) — ZIP with buyer license for internal and paid client work.

## Run and connect

Use **Node.js 22 or later** and npm for the test command. The server supports **MCP 2025-11-25 over stdio**. Extract the ZIP and open a terminal in the folder containing `package.json`.

```sh
node --version
npm test
```

The suite runs 12 unit tests and two real-process stdio tests. Start the server directly with `node src/server.js` or launch it manually with `npm start`. For client configuration, use `node` directly so npm's script banner stays out of protocol output. Configure your client's local stdio server with an absolute path to `src/server.js`. For clients using an `mcpServers` configuration, the Windows example below shows both absolute paths. On macOS or Linux, use your installed Node path and extracted script path.

```json
{
  "mcpServers": {
    "support-quote": {
      "command": "C:/Program Files/nodejs/node.exe",
      "args": ["C:/tools/mcp-support-quote-starter/src/server.js"]
    }
  }
}
```

Reload the client and check for the four tool names below. If discovery fails, confirm both paths, restart the client connection and check its server diagnostics. The server exchanges newline-delimited UTF-8 JSON-RPC messages. A client initializes with `initialize`, sends `notifications/initialized`, and then uses `tools/list` and `tools/call`. The `ping` method works during setup. The server replies with its supported revision when the client proposes a different one. A client that lacks support for the returned revision should disconnect. Successful tools return structured data and a JSON text copy. Invalid tool inputs return an `isError` tool result. Malformed protocol requests and unknown tools return JSON-RPC errors. [MCP stdio transport](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports) · [MCP lifecycle](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle)

## `classify_ticket`

Supply the category as `issueType`. Choose `technical`, `billing`, `account`, `quote`, or `general`. The caller identifies the category and impact. The tool applies a rule to those inputs and returns the category, priority, reason, and SLA target.

| Impact | Effective workaround exists | Priority | First human response |
| --- | --- | --- | --- |
| Shared service outage affecting multiple users | No | P1 | 1 hour |
| Shared service outage affecting multiple users | Yes | P2 | 4 hours |
| Core task blocked | No | P2 | 4 hours |
| Core task blocked | Yes | P3 | 24 hours |
| Degraded functionality, work can continue | Either | P3 | 24 hours |
| Informational question | Either | P4 | 72 hours |

The target measures elapsed clock hours from ticket receipt, including weekends and holidays. It is a sample first-response policy with no resolution deadline, due-date computation, or escalation scheduling.

```json
{"issueType":"technical","impact":"outage","workaroundAvailable":false}
```

Expected result: `technical`, `P1`, first human response within 1 elapsed hour.

## `calculate_quote`

Use one currency per quote. AUD, CAD, EUR, GBP and USD use two decimal places. JPY and KRW use zero. KWD uses three. Enter each tax-exclusive `unitPriceMinor` as a nonnegative safe JSON integer. Line quantity must be an integer from 1 through 1,000,000. Supply 1 to 100 lines. The order discount and tax/VAT rate are caller-supplied integers from 0 to 10,000 basis points (100 basis points = 1%). Both default to zero.

1. Multiply each unit price by its quantity and sum the line subtotals.
2. Apply the order discount to the subtotal and round it half up to one minor unit.
3. Subtract that rounded discount. Apply the single tax/VAT rate to the resulting taxable subtotal and round tax half up to one minor unit.
4. Add tax to the taxable subtotal. Amounts are returned as decimal strings in minor units, with `minorUnitDigits` for display. Keep the strings or parse them as `BigInt` when consuming large totals.

This pricing model uses one rate for all lines, regardless of item type. It has no currency conversion, inclusive tax, exemptions, mixed rates, or per-line tax rounding. Supply the rate required for your transaction from your approved pricing workflow. These synthetic examples demonstrate arithmetic only.

```json
{
  "currency":"USD",
  "items":[{"description":"Sample session","quantity":2,"unitPriceMinor":50},{"description":"Sample add-on","quantity":1,"unitPriceMinor":5}],
  "discountBps":1000,
  "taxBps":2500
}
```

The result is subtotal `105`, discount `11`, taxable subtotal `94`, tax `24`, total `118` (USD 1.18).

## `draft_support_reply`

Choose English (`en`) or Korean (`ko`) and a `resolution` or `quote` template. Supply the details and next step in the desired language. The template uses your facts verbatim apart from trimming surrounding whitespace. Review the intended recipient, facts, amounts and terms, next step, and signature before copying the draft into your mail client.

```json
{
  "language":"en","kind":"resolution","customerName":"Avery","topic":"Example portal access",
  "details":"Your test account access has been restored.","nextStep":"Please try signing in again.","signature":"Example Support"
}
```

The result includes `subject`, `body`, `reviewRequired: true`, and a localized `reviewNote`.

## `summarize_daily_tickets`

Provide one `date` in `YYYY-MM-DD` format and up to 1,000 tickets with unique IDs. Use UTC `createdAt` timestamps ending in `Z`, with full hours, minutes, and seconds and optional 1–3 fractional digits. The window includes UTC midnight at the start and excludes UTC midnight on the next day. Counts group matching queue, category, priority and supplied status (`open`, `pending`, `resolved`). Use creation time regardless of later changes. Status is the one in your input snapshot. IDs serve only to prevent duplicate records. Empty results return a CSV header and a Markdown empty state.

```json
{
  "date":"2026-02-28",
  "tickets":[
    {"id":"sample-01","createdAt":"2026-02-28T00:00:00Z","queue":"Support, East","category":"technical","priority":"P2","status":"open"},
    {"id":"sample-02","createdAt":"2026-03-01T00:00:00Z","queue":"Support, East","category":"technical","priority":"P2","status":"open"}
  ]
}
```

The report contains one included ticket and one outside the window. CSV uses CRLF between rows, doubles embedded quotes, and quotes fields containing commas, quotes, or line breaks. Import the `queue` field as text in spreadsheet software to preserve queue labels and avoid interpreting formula-like values. Markdown uses an escaped table and shows embedded line breaks as `↵`.

## Buyer license

Both tiers permit internal business use, modifications, paid client work and delivery within client implementations under `LICENSE.txt`. Keep the license with client copies. The setup guide is a separate download in the Commercial + Setup Guide tier.

Buy a license: [https://playmaster72.gumroad.com/l/mcp-support-quote-starter](https://playmaster72.gumroad.com/l/mcp-support-quote-starter)
