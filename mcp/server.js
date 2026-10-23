#!/usr/bin/env node
/**
 * @fileoverview KuGouMusicApi MCP 服务入口
 *
 * 面向大模型 Agent 的酷狗音乐工具服务，基于 @modelcontextprotocol/sdk。
 *
 * 传输方式：
 * - 默认 stdio（本地 Agent 标准接入，如 Claude Code / Claude Desktop / Cursor）：
 *   node mcp/server.js
 * - HTTP 流式传输（远程 Agent 接入）：
 *   node mcp/server.js --http 3010
 *
 * 会话说明：登录态与设备指纹持久化在 data/.mcp_session.json，
 * 重启服务后无需重新登录（除非调用 kugou_logout）。
 */

const express = require('express');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { registerTools } = require('./tools');

const argv = process.argv.slice(2);
const httpIdx = argv.indexOf('--http');
const httpPort = httpIdx !== -1 ? Number(argv[httpIdx + 1] || 3010) : null;

const createServer = () => {
  const server = new McpServer(
    { name: 'kugou-music', version: require('../package.json').version },
    { capabilities: { tools: {}, resources: {} } }
  );
  registerTools(server);
  return server;
};

const startStdio = async () => {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[kugou-mcp] stdio 服务已启动');
};

const startHttp = async (port) => {
  const app = express();
  app.use(express.json());

  // 每个会话独立 transport + server 实例（无状态模式，便于多客户端）
  app.post('/mcp', async (req, res) => {
    try {
      const server = createServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on('close', () => {
        transport.close();
        server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: String(e.message || e) }, id: null });
    }
  });

  app.get('/mcp', (_req, res) => res.status(405).json({ error: 'GET 不支持，请用 POST（Streamable HTTP）' }));

  app.listen(port, () => {
    console.log(`[kugou-mcp] HTTP 服务已启动: http://localhost:${port}/mcp`);
  });
};

if (httpPort) {
  startHttp(httpPort).catch((e) => {
    console.error('[kugou-mcp] HTTP 启动失败:', e);
    process.exit(1);
  });
} else {
  startStdio().catch((e) => {
    console.error('[kugou-mcp] stdio 启动失败:', e);
    process.exit(1);
  });
}
