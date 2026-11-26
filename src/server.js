import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { InputError, hasTool, runTool, toolList } from './tools.js';

const protocolVersion = '2025-11-25';
const serverInfo = { name: 'mcp-support-quote-starter', version: '1.0.0' };
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const success = (id, result) => ({ jsonrpc: '2.0', id, result });
const error = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
const content = (text) => [{ type: 'text', text }];
let initialized = false;
let negotiated = false;

function handle(message) {
  if (!isObject(message) || message.jsonrpc !== '2.0') return error(null, -32600, 'Invalid request');
  const { id, method, params } = message;
  const hasId = Object.hasOwn(message, 'id');
  const validId = typeof id === 'string' || Number.isSafeInteger(id);
  // The server never initiates requests. Ignore responses to avoid a protocol error loop.
  if (!Object.hasOwn(message, 'method') && hasId && ('result' in message || 'error' in message)) return;
  if (typeof method !== 'string' || (hasId && !validId)) return error(null, -32600, 'Invalid request');
  if (!hasId) {
    if (method === 'notifications/initialized' && negotiated && (params === undefined || isObject(params))) {
      initialized = true;
    }
    return;
  }

  if (params !== undefined && !isObject(params)) return error(id, -32602, 'params must be an object');
  if (method === 'ping') return success(id, {});
  if (method === 'initialize') {
    if (negotiated) return error(id, -32600, 'Already initialized');
    if (typeof params?.protocolVersion !== 'string' || !params.protocolVersion || !isObject(params.capabilities) ||
      !isObject(params.clientInfo) || typeof params.clientInfo.name !== 'string' ||
      typeof params.clientInfo.version !== 'string') {
      return error(id, -32602, 'Expected protocolVersion, capabilities, and clientInfo with name and version');
    }
    // Return our supported version when the client proposed a different version.
    negotiated = true;
    return success(id, { protocolVersion, capabilities: { tools: {} }, serverInfo });
  }

  if (method !== 'tools/list' && method !== 'tools/call') return error(id, -32601, 'Method not found');
  if (!initialized) return error(id, -32002, 'Send initialize and notifications/initialized first');
  if (method === 'tools/list') {
    if (params?.cursor !== undefined) return error(id, -32602, 'The server did not issue a pagination cursor');
    return success(id, { tools: toolList });
  }

  if (typeof params?.name !== 'string' || (params.arguments !== undefined && !isObject(params.arguments))) {
    return error(id, -32602, 'Expected a tool name and optional arguments object');
  }
  if (!hasTool(params.name)) return error(id, -32602, 'Unknown tool');
  try {
    const structuredContent = runTool(params.name, params.arguments ?? {});
    return success(id, { content: content(JSON.stringify(structuredContent)), structuredContent });
  } catch (cause) {
    if (cause instanceof InputError) return success(id, { content: content(cause.message), isError: true });
    return error(id, -32603, 'Internal error');
  }
}

function processLine(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return error(null, -32700, 'Parse error');
  }
  return handle(message);
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of input) {
  const reply = processLine(line);
  if (reply && !process.stdout.write(`${JSON.stringify(reply)}\n`)) await once(process.stdout, 'drain');
}
