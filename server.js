/**
 * @fileoverview KuGouMusic API 服务器核心模块 (多用户隔离 + 限流防封版)
 */

const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const decode = require('safe-decode-uri-component');
const { cookieToJson, randomString, getGuid, calculateMid, generateWebGLHash } = require('./util/util');
const { cryptoMd5 } = require('./util/crypto');
const { createRequest } = require('./util/request');
const dotenv = require('dotenv');
const cache = require('./util/apicache').middleware;
const rateLimit = require('express-rate-limit'); // 【优化 1：引入限流模块】

const serverDev = randomString(10).toUpperCase();
const envPath = path.join(process.cwd(), '.env');

if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath, quiet: true });
}

async function getModulesDefinitions(modulesPath, specificRoute, doRequire = true) {
  const files = await fs.promises.readdir(modulesPath);

  const parseRoute = (fileName) =>
    specificRoute && fileName in specificRoute ? specificRoute[fileName] : `/${fileName.replace(/\.(js)$/i, '').replace(/_/g, '/')}`;

  return (
    files
      .reverse()
      .filter((fileName) => fileName.endsWith('.js') && !fileName.startsWith('_'))
      .map((fileName) => {
        const identifier = fileName.split('.').shift();
        const route = parseRoute(fileName);
        const modulePath = path.resolve(modulesPath, fileName);
        const module = doRequire ? require(modulePath) : modulePath;
        return { identifier, route, module };
      })
  );
}

async function consturctServer(moduleDefs) {
  const app = express();
  const { CORS_ALLOW_ORIGIN } = process.env;

  // 必须启用 trust proxy，否则限流模块获取到的都会是反向代理服务器的局域网 IP
  app.set('trust proxy', true);

  /**
   * ============================================================
   * 【优化 1：接口限流防护中间件】
   * 防止因车机、手机客户端 Bug 导致疯狂轮询，避免服务器出口 IP 被酷狗封禁
   * ============================================================
   */
  const apiLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 分钟统计时间
    max: 200, // 单个 IP 每分钟最多允许请求 200 次（可根据实际车机并发需求微调）
    message: { code: 429, data: null, msg: '请求过于频繁，系统已触发限流保护，请稍后再试' },
    standardHeaders: true, // 在响应头中返回标准的 RateLimit-* 信息
    legacyHeaders: false, // 禁用过时的 X-RateLimit-* 头
  });
  app.use(apiLimiter);

  app.use((req, res, next) => {
    if (req.path !== '/' && !req.path.includes('.')) {
      res.set({
        'Access-Control-Allow-Credentials': true,
        'Access-Control-Allow-Origin': CORS_ALLOW_ORIGIN || req.headers.origin || '*',
        'Access-Control-Allow-Headers': 'Authorization,X-Requested-With,Content-Type,Cache-Control',
        'Access-Control-Allow-Methods': 'PUT,POST,GET,DELETE,OPTIONS',
        'Content-Type': 'application/json; charset=utf-8',
      });
    }
    req.method === 'OPTIONS' ? res.status(204).end() : next();
  });

  app.use((req, _, next) => {
    req.cookies = {};
    (req.headers.cookie || '').split(/;\s+|(?<!\s)\s+$/g).forEach((pair) => {
      const crack = pair.indexOf('=');
      if (crack < 1 || crack === pair.length - 1) {
        return;
      }
      req.cookies[decode(pair.slice(0, crack)).trim()] = decode(pair.slice(crack + 1)).trim();
    });
    next();
  });

  app.use((req, res, next) => {
    const cookies = req.cookies || {};
    const isHttps = req.protocol === 'https';
    const cookieSuffix = isHttps ? '; PATH=/; SameSite=None; Secure' : '; PATH=/';

    const ensureCookie = (key, value) => {
      if (Object.prototype.hasOwnProperty.call(cookies, key)) return;
      cookies[key] = String(value);
      res.append('Set-Cookie', `${key}=${cookies[key]}${cookieSuffix}`);
    };

    let clientGuid = cookies.KUGOU_API_GUID;
    if (!clientGuid) {
        const authStr = req.headers.authorization || (req.query && req.query.cookie) || '';
        const tokenMatch = authStr.match(/token=([^;]+)/);

        if (tokenMatch && tokenMatch[1]) {
            // 已登录用户：基于 Token 派生唯一的永久 GUID
            clientGuid = cryptoMd5('kugou_device_seed_' + tokenMatch[1]);
        } else {
            // 未登录的访客：提取真实 IP 和 User-Agent 生成稳定的访客 GUID
            const realIp = req.headers['x-forwarded-for']?.split(',')[0] || req.ip;
            const ua = req.headers['user-agent'] || 'unknown_guest';
            // 只要 IP 和设备环境不突变，即使客户端不存 Cookie，产生的 GUID 也永远是同一个
            clientGuid = cryptoMd5('kugou_guest_' + realIp.replace('::ffff:', '').trim() + '_' + ua);
        }
    }

    const clientMid = calculateMid(clientGuid);

    ensureCookie('KUGOU_API_PLATFORM', process.env.platform || 'android');
    ensureCookie('KUGOU_API_MID', clientMid);
    ensureCookie('KUGOU_API_GUID', clientGuid);
    ensureCookie('KUGOU_API_DEV', (process.env.KUGOU_API_DEV ?? serverDev).toUpperCase());
    ensureCookie('KUGOU_API_MAC', (process.env.KUGOU_API_MAC ?? '02:00:00:00:00:00').toUpperCase());
    // WebGL 指纹（听歌识曲 / 行为指纹模拟依赖），未配置则按设备生成
    ensureCookie('KUGOU_API_WEBGL', process.env.KUGOU_API_WEBGL ?? generateWebGLHash());

    req.cookies = cookies;
    next();
  });

  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  // 听歌识曲接口以 application/octet-stream 传输 PCM 二进制，需 raw 解析
  app.use(express.raw({ type: 'application/octet-stream', limit: '10mb' }));
  // 纯 API 服务：根路径仅返回状态 JSON，无首页（用户信息由客户端自行保存）
  app.get('/', (_req, res) => {
    res.status(200).json({
      code: 200,
      service: 'KuGouMusicApi',
      message: '服务运行中，接口文档见 /docs',
    });
  });
  app.use(express.static(path.join(__dirname, 'public')));
  app.use('/docs', express.static(path.join(__dirname, 'docs')));
  // ==========================================
  // 【新增功能】加载管理控制台路由与白名单拦截器
  // ==========================================
  const { adminMiddleware, adminRouter } = require('./util/admin');
  
  // 挂载管理员的 API 路由接口
  app.use('/admin', adminRouter);

  // 挂载拦截器 (必须在缓存和实际 API 路由前执行)
  app.use(adminMiddleware);

  // ==========================================
  // 【新增功能】MCP 端点（与 API 同进程在线提供，Streamable HTTP）
  // 部署一份即同时提供 HTTP API 与 MCP 服务，AI 客户端直连 /mcp
  // ==========================================
  const { handleMcpRequest, mcpGetHandler } = require('./mcp/server');
  app.post('/mcp', handleMcpRequest);
  app.get('/mcp', mcpGetHandler);
  // ==========================================
  app.use(cache('2 minutes', (req, res) => {
    const noCachePaths = [
        '/login',
        '/captcha',
        '/song/url',
        '/user',
        '/vip'
    ];
    const isNoCachePath = noCachePaths.some(p => req.path.includes(p));
    if (isNoCachePath) return false;

    const hasAuth = 
      req.headers.authorization || 
      req.cookies.token || 
      (req.query && req.query.token) || 
      (req.query && req.query.cookie && req.query.cookie.includes('token='));
      
    return res.statusCode === 200 && !hasAuth;
  }));

  const moduleDefinitions = moduleDefs || (await getModulesDefinitions(path.join(__dirname, 'module'), {}));

  for (const moduleDef of moduleDefinitions) {
    app.use(moduleDef.route, async (req, res) => {
      [req.query, req.body].forEach((item) => {
        if (typeof item.cookie === 'string') {
          item.cookie = cookieToJson(decode(item.cookie));
        }
      });

      const { cookie, ...params } = req.query;
      const query = Object.assign({}, { cookie: Object.assign({}, req.cookies, cookie) }, params, { body: req.body });

      const authHeader = req.headers['authorization'];
      if (authHeader) {
        query.cookie = {
          ...query.cookie,
          ...cookieToJson(authHeader),
        };
      }

      try {
        const moduleResponse = await moduleDef.module(query, (config) => {
          let ip = req.ip;
          if (ip.substring(0, 7) === '::ffff:') {
            ip = ip.substring(7);
          }
          config.ip = ip;
          return createRequest(config);
        });

        console.log('[OK]', decode(req.originalUrl));

        const cookies = moduleResponse.cookie;
        if (!query.noCookie) {
          if (Array.isArray(cookies) && cookies.length > 0) {
            if (req.protocol === 'https') {
              res.append('Set-Cookie', cookies.map((cookie) => `${cookie}; PATH=/; SameSite=None; Secure`));
            } else {
              res.append('Set-Cookie', cookies.map((cookie) => `${cookie}; PATH=/`));
            }
          }
        }

        res.header(moduleResponse.headers).status(moduleResponse.status).send(moduleResponse.body);
      } catch (e) {
        const moduleResponse = e;

        console.log('[ERR]', decode(req.originalUrl), {
          status: moduleResponse.status,
          body: moduleResponse.body,
        });

        if (!moduleResponse.body) {
          res.status(404).send({
            code: 404,
            data: null,
            msg: 'Not Found',
          });
          return;
        }

        res.header(moduleResponse.headers).status(moduleResponse.status).send(moduleResponse.body);
      }
    });
  }

  return app;
}

async function startService() {
  const port = Number(process.env.PORT || '3000');
  const host = process.env.HOST || '';

  const app = await consturctServer();
  const appExt = app;

  appExt.service = app.listen(port, host, () => {
    console.log(`server running @ http://${host || 'localhost'}:${port}`);
  });

  return appExt;
}

module.exports = { startService, getModulesDefinitions };