/**
 * @fileoverview 概念版（lite）调用通道（父进程侧）
 *
 * - 主进程为标准版（默认部署）：fork mcp/lite-worker.js（env platform=lite），
 *   经 stdin/stdout JSON 行协议转发模块调用，概念版登录态独立持久化
 *   （data/.mcp_session_lite.json）。stdin 有缓冲，worker 启动期间写入的
 *   请求会在其就绪后按序处理。
 * - 主进程本身已以 platform=lite 运行：无需子进程，直接进程内调用
 *   （此时主会话就是概念版会话）。
 */

const { spawn } = require('node:child_process');
const path = require('node:path');

const WORKER = path.join(__dirname, 'lite-worker.js');
const inProcessLite = () => process.env.platform === 'lite';

/** @type {import('node:child_process').ChildProcess | null} */
let child = null;
let seq = 0;
const pending = new Map();

const handleMessage = (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch (e) {
    return;
  }
  if (msg?.id === 'ready') return; // worker 就绪通知
  const waiter = pending.get(msg?.id);
  if (!waiter) return;
  pending.delete(msg.id);
  clearTimeout(waiter.timer);
  if (msg.ok) waiter.resolve(msg.body);
  else {
    const err = new Error(msg.error || '概念版调用失败');
    err.code = msg.code;
    err.status = msg.status;
    waiter.reject(err);
  }
};

const startChild = () => {
  child = spawn(process.execPath, [WORKER], {
    env: { ...process.env, platform: 'lite' },
    stdio: ['pipe', 'pipe', 'inherit'],
  });

  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (line) handleMessage(line);
    }
  });
  child.on('error', (e) => {
    child = null;
    for (const [, waiter] of pending) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(`概念版工作进程异常: ${e.message}`));
    }
    pending.clear();
  });
  child.on('exit', () => {
    child = null;
    for (const [, waiter] of pending) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error('概念版工作进程已退出，请重试'));
    }
    pending.clear();
  });
};

const request = (payload, timeoutMs = 30000) =>
  new Promise((resolve, reject) => {
    if (!child) startChild();
    if (!child || !child.stdin.writable) {
      reject(new Error('概念版工作进程不可用，请重试'));
      return;
    }
    const id = `p${++seq}`;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`概念版调用超时（${Math.round(timeoutMs / 1000)}s）：${payload.fn || payload.action}`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ ...payload, id }) + '\n');
  });

process.on('exit', () => {
  if (child) child.kill();
});

// ------------------------------------------------------------
// 进程内通道（部署本身为 platform=lite 时）
// ------------------------------------------------------------
let inProcessCall = null;
const inProcess = () => {
  if (!inProcessCall) {
    const { session } = require('./session');
    inProcessCall = require('./call').makeCaller(session);
  }
  return inProcessCall;
};

/**
 * 以概念版身份调用 API 模块（自动管理概念版会话）
 * @param {string} fn 模块名
 * @param {Object} [params] 业务参数
 * @returns {Promise<any>} 响应 body；失败抛 Error（带 code 属性，如 131001）
 */
const callLite = (fn, params = {}) =>
  inProcessLite() ? inProcess()(fn, params) : request({ action: 'call', fn, params });

/** 概念版登录态摘要 */
const liteStatus = () => {
  if (!inProcessLite()) return request({ action: 'status' });
  const { session } = require('./session');
  return Promise.resolve({
    logged_in: session.isLoggedIn(),
    userid: session.cookie.userid || 0,
    vip_type: session.cookie.vip_type || 0,
    has_vip_token: Boolean(session.cookie.vip_token),
  });
};

/** 退出概念版登录（保留设备标识） */
const liteLogout = () => {
  if (!inProcessLite()) return request({ action: 'logout' });
  const { session } = require('./session');
  session.logout();
  return Promise.resolve({ logged_in: false });
};

module.exports = { callLite, liteStatus, liteLogout };
