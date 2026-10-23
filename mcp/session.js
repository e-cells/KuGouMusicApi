/**
 * @fileoverview MCP 会话管理
 *
 * 负责：
 * 1. 设备标识（GUID/MID/DEV/MAC/WebGL）的生成与持久化，与 server.js 的
 *    多用户隔离策略保持一致（稳定设备指纹可显著降低风控触发率）
 * 2. 通过 register_dev 注册设备获取 dfid
 * 3. 登录态（token/userid 等）的持久化（data/.mcp_session.json）与合并
 *
 * 会话文件保存在 process.cwd()/data 下，重启后免重新登录/注册。
 */

const fs = require('node:fs');
const path = require('node:path');
const { randomString } = require('../util/util');
const { cryptoMd5 } = require('../util/crypto');

const api = require('../main');

// 固定使用项目根目录下的 data/，避免从任意 cwd 启动时会话漂移
const DATA_DIR = path.join(__dirname, '..', 'data');
const SESSION_FILE = path.join(DATA_DIR, '.mcp_session.json');

class McpSession {
  /**
   * @param {Object} [options]
   * @param {string} [options.file] 会话文件路径；缺省为主（标准版）会话。
   *   概念版（lite）登录态与标准版 token 互不兼容，由 mcp/lite-worker.js
   *   用独立文件（.mcp_session_lite.json）实例化。
   */
  constructor({ file } = {}) {
    this.file = file || SESSION_FILE;
    this.cookie = {};
    this.load();
  }

  load() {
    try {
      if (fs.existsSync(this.file)) {
        const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        if (saved && typeof saved.cookie === 'object') this.cookie = saved.cookie;
      }
    } catch (e) {
      // 会话文件损坏时静默重建
      this.cookie = {};
    }
  }

  save() {
    try {
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify({ cookie: this.cookie, saved_at: new Date().toISOString() }, null, 2), 'utf8');
    } catch (e) {
      // 持久化失败不影响当次会话
    }
  }

  /**
   * 将模块响应中的 cookie 数组（["token=xxx", "userid=123", ...]）合并进会话
   * @param {string[]} cookieArray
   */
  mergeCookieStrings(cookieArray) {
    for (const item of cookieArray || []) {
      const idx = item.indexOf('=');
      if (idx > 0) {
        this.cookie[item.slice(0, idx).trim()] = item.slice(idx + 1).trim();
      }
    }
    if (cookieArray && cookieArray.length) this.save();
  }

  isLoggedIn() {
    return Boolean(this.cookie.token && Number(this.cookie.userid) > 0);
  }

  requireLogin() {
    if (!this.isLoggedIn()) {
      throw new Error('此操作需要登录：请先调用 kugou_login_qr 生成二维码并用酷狗 App 扫码（或 kugou_login_wx 微信扫码），登录成功后再重试。');
    }
  }

  /**
   * 确保设备标识齐备（GUID/MID/DEV/MAC/WebGL/dfid），返回可用的 cookie 对象
   * 首次调用会通过 register_dev 注册设备获取 dfid
   */
  async ensureDevice() {
    if (!this.cookie.KUGOU_API_GUID) {
      this.cookie.KUGOU_API_GUID = cryptoMd5(`${randomString()}-${Date.now()}`);
      this.save();
    }
    if (!this.cookie.KUGOU_API_MID) {
      // 与 util/util.js 的 calculateMid 一致（延迟 require 避免循环依赖）
      const { calculateMid } = require('../util/util');
      this.cookie.KUGOU_API_MID = calculateMid(this.cookie.KUGOU_API_GUID);
      this.save();
    }
    if (!this.cookie.KUGOU_API_DEV) {
      this.cookie.KUGOU_API_DEV = randomString(10).toUpperCase();
      this.save();
    }
    if (!this.cookie.KUGOU_API_MAC) {
      this.cookie.KUGOU_API_MAC = '02:00:00:00:00:00';
      this.save();
    }

    if (!this.cookie.dfid) {
      try {
        const res = await api.register_dev({ cookie: { ...this.cookie } });
        if (res && Array.isArray(res.cookie) && res.cookie.length) {
          this.mergeCookieStrings(res.cookie);
        }
      } catch (e) {
        // 注册失败时保持 dfid 缺省（'-'），多数接口仍可用
      }
    }
    return { ...this.cookie };
  }

  /** 退出登录：仅清除用户态，保留设备标识（避免重复注册设备） */
  logout() {
    delete this.cookie.token;
    delete this.cookie.userid;
    delete this.cookie.vip_type;
    delete this.cookie.vip_token;
    this.save();
  }
}

module.exports = { McpSession, session: new McpSession() };
