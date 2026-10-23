/**
 * @fileoverview MCP 模块调用器（标准版 / 概念版共用）
 *
 * 封装「注入会话 cookie → 调用 main.js 模块函数 → 回收响应 cookie」的通用流程，
 * 并把模块抛出的 {status, body} 统一格式化为带 error_code 的 Error，
 * 供 mcp/tools.js（进程内标准版）与 mcp/lite-worker.js（概念版子进程）复用。
 */

const api = require('../main');

/**
 * 从模块抛出的错误中提取 error_code（酷狗业务错误码，如 131001=今日已领取）
 * @param {any} e 模块 reject 的 {status, body} 或 Error
 * @returns {number | undefined}
 */
const extractErrorCode = (e) => {
  const code = e?.body?.error_code ?? e?.body?.errcode ?? e?.body?.code;
  const n = Number(code);
  return Number.isFinite(n) && n !== 0 ? n : undefined;
};

/** 把模块错误格式化为 Error（附带 code / status 属性） */
const formatApiError = (fn, e) => {
  const body = e?.body;
  const msg =
    body?.error || body?.error_msg || body?.errmsg || body?.msg || body?.info ||
    (e?.message ? String(e.message) : JSON.stringify(body ?? e).slice(0, 300));
  const ssaHint = body?.ssaCode || body?.edt ? '（触发了酷狗风控验证，建议稍后重试或重新登录）' : '';
  const err = new Error(
    `接口 ${fn} 调用失败${e?.status ? ` [${e.status}]` : ''}: ${typeof msg === 'string' ? msg.slice(0, 300) : JSON.stringify(msg).slice(0, 300)}${ssaHint}`
  );
  err.code = extractErrorCode(e);
  err.status = e?.status;
  return err;
};

/**
 * 构造绑定到指定会话的模块调用器
 * @param {import('./session').McpSession} session
 * @returns {(fn: string, params?: Object, options?: {requireLogin?: boolean}) => Promise<any>}
 */
const makeCaller = (session) => {
  return async function call(fn, params = {}, options = {}) {
    if (options.requireLogin && !session.isLoggedIn()) {
      throw new Error('此操作需要登录：请先调用登录工具（标准版 kugou_login_qr / kugou_login_wx，概念版 kugou_login_concept）扫码后再重试。');
    }
    const cookie = await session.ensureDevice();
    let res;
    try {
      res = await api[fn]({ ...params, cookie });
    } catch (e) {
      throw formatApiError(fn, e);
    }
    if (res && Array.isArray(res.cookie) && res.cookie.length) {
      session.mergeCookieStrings(res.cookie);
    }
    return res?.body ?? res;
  };
};

module.exports = { makeCaller, formatApiError, extractErrorCode };
