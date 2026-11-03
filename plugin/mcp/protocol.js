// 极简 MCP（Model Context Protocol）服务端实现，零依赖。
// 只实现工具相关的部分：initialize / ping / tools/list / tools/call。
// 同一个 handler 既用于本地 stdio 插件（server.js），也用于平台的远程 HTTP 端点（/mcp）。

const SUPPORTED = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

export function createMcpHandler({ name, version, instructions, tools, call }) {
  return async function handle(msg) {
    if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
      if (msg && msg.id !== undefined && msg.method === undefined) return null; // 客户端发来的响应，忽略
      return error(msg?.id ?? null, -32600, 'Invalid Request');
    }
    const isNotification = msg.id === undefined || msg.id === null;
    try {
      switch (msg.method) {
        case 'initialize': {
          const requested = msg.params?.protocolVersion;
          return result(msg.id, {
            protocolVersion: SUPPORTED.includes(requested) ? requested : SUPPORTED[1],
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name, version },
            instructions,
          });
        }
        case 'ping':
          return isNotification ? null : result(msg.id, {});
        case 'tools/list':
          return result(msg.id, { tools });
        case 'tools/call': {
          const toolName = msg.params?.name;
          if (!tools.some((t) => t.name === toolName)) return error(msg.id, -32602, `Unknown tool: ${toolName}`);
          try {
            const text = await call(toolName, msg.params?.arguments ?? {});
            return result(msg.id, { content: [{ type: 'text', text }] });
          } catch (e) {
            return result(msg.id, { content: [{ type: 'text', text: `出错了：${e.message}` }], isError: true });
          }
        }
        default:
          if (isNotification) return null; // notifications/initialized 等
          return error(msg.id, -32601, `Method not found: ${msg.method}`);
      }
    } catch (e) {
      return isNotification ? null : error(msg.id, -32603, e.message);
    }
  };
}

function result(id, value) {
  return { jsonrpc: '2.0', id, result: value };
}

function error(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}
