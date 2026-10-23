#!/usr/bin/env node
/**
 * @fileoverview 概念版（lite）工作进程
 *
 * 概念版 VIP 是「业务线隔离」的会员：只有以概念版身份（appid=3116）+ 概念版
 * token 发起的请求才会被服务端授予下载权限，且概念版 token 与标准版 token
 * 互不兼容（标准版 token 在概念版请求下报 20018 token api error）。
 * 因此主进程为标准版部署时，由 mcp/lite.js 以 platform=lite 环境变量拉起
 * 本子进程，专门承载概念版登录 / 签到 / VIP 直链等调用。
 *
 * 协议：stdin 每行一个 JSON 请求，stdout 每行一个 JSON 应答
 *   请求 {id, action: 'call', fn, params}   → {id, ok: true, body}
 *   请求 {id, action: 'status'}             → {id, ok: true, body: {logged_in, ...}}
 *   请求 {id, action: 'logout'}             → {id, ok: true, body: {logged_in: false}}
 *   失败                                    → {id, ok: false, error, code?, status?}
 *
 * 会话：data/.mcp_session_lite.json；设备标识复用主会话，避免重复注册设备。
 */

// 必须在 require ../main 之前设置：appid/签名盐等在模块加载期与调用期都会读取
process.env.platform = 'lite';

const path = require('node:path');
const readline = require('node:readline');
const { McpSession, session: mainSession } = require('./session');
const { makeCaller } = require('./call');

const session = new McpSession({ file: path.join(__dirname, '..', 'data', '.mcp_session_lite.json') });
const call = makeCaller(session);

// 设备标识（GUID/MID/DEV/MAC/dfid）与平台无关，直接复用主会话
let seeded = false;
for (const k of ['KUGOU_API_GUID', 'KUGOU_API_MID', 'KUGOU_API_DEV', 'KUGOU_API_MAC', 'dfid']) {
  if (!session.cookie[k] && mainSession.cookie[k]) {
    session.cookie[k] = mainSession.cookie[k];
    seeded = true;
  }
}
if (seeded) session.save();

const write = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');

const actions = {
  call: async ({ fn, params }) => call(fn, params || {}),

  status: async () => ({
    logged_in: session.isLoggedIn(),
    userid: session.cookie.userid || 0,
    vip_type: session.cookie.vip_type || 0,
    has_vip_token: Boolean(session.cookie.vip_token),
  }),

  logout: async () => {
    session.logout();
    return { logged_in: false };
  },
};

readline
  .createInterface({ input: process.stdin, terminal: false })
  .on('line', (line) => {
    let req;
    try {
      req = JSON.parse(line);
    } catch (e) {
      return; // 无法解析的行直接丢弃
    }
    const handler = actions[req?.action];
    if (!handler) {
      write({ id: req?.id, ok: false, error: `未知 action: ${req?.action}` });
      return;
    }
    Promise.resolve()
      .then(() => handler(req))
      .then((body) => write({ id: req.id, ok: true, body }))
      .catch((e) => write({ id: req.id, ok: false, error: String(e?.message || e), code: e?.code, status: e?.status }));
  })
  .on('close', () => process.exit(0));

// 通知父进程 worker 就绪（require ../main 较重，就绪后再处理请求也来得及）
write({ id: 'ready', ok: true });
