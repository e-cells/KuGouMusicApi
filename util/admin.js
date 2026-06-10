// util/admin.js
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { cryptoMd5 } = require('./crypto');
const { randomString } = require('./util');
const rateLimit = require('express-rate-limit'); 

const configPath = path.join(process.cwd(), '.admin_config.json');
const devicesPath = path.join(process.cwd(), '.admin_devices.json'); 

let adminConfig = {
  isSetup: false,
  username: '',
  password: '',
  mode: 'unrestricted', 
  whitelist: [],
  blacklist: [] 
};

if (fs.existsSync(configPath)) {
  try {
    const loadedConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    adminConfig = { ...adminConfig, ...loadedConfig };
    if (!adminConfig.blacklist) adminConfig.blacklist = []; 
    if (!adminConfig.whitelist) adminConfig.whitelist = []; 
  } catch (e) {
    console.error('[Admin] 配置文件解析失败，使用默认配置');
  }
}

// 【性能优化】：将配置保存改为异步非阻塞操作
const saveConfig = () => {
  fs.promises.writeFile(configPath, JSON.stringify(adminConfig, null, 2), 'utf8')
    .catch(e => console.error('[Admin] 异步保存配置失败:', e));
};

const adminTokens = new Map(); 
const connectedDevices = new Map();

if (fs.existsSync(devicesPath)) {
  try {
    const savedDevices = JSON.parse(fs.readFileSync(devicesPath, 'utf8'));
    for (const [k, v] of Object.entries(savedDevices)) {
      connectedDevices.set(k, v);
    }
  } catch (e) {}
}

const getNickScore = (name) => {
  if (!name) return 0;
  const str = String(name).trim();
  if (str === '访客') return 1;
  if (str === '已登录用户') return 2;
  if (str.startsWith('用户_')) return 3;
  if (/^\d+$/.test(str)) return 4; 
  if (str.toLowerCase().startsWith('kugou')) return 4;
  return 5; 
};

setInterval(() => {
  const now = Date.now();
  const DEVICE_EXPIRY = 7 * 24 * 60 * 60 * 1000;
  for (const [guid, device] of connectedDevices.entries()) {
    if (now - device.lastSeen > DEVICE_EXPIRY && !adminConfig.whitelist.includes(guid)) {
      connectedDevices.delete(guid);
    }
  }
  for (const [token, expireAt] of adminTokens.entries()) {
    if (now > expireAt) {
      adminTokens.delete(token);
    }
  }
  
  // 【性能优化】：后台异步静默写入硬盘，不阻塞主线程
  try {
    const obj = {};
    for (const [k, v] of connectedDevices.entries()) {
      obj[k] = v;
    }
    fs.promises.writeFile(devicesPath, JSON.stringify(obj), 'utf8')
      .catch(e => console.error('[Admin] 后台持久化设备数据失败:', e));
  } catch(e) {
    console.error('[Admin] 组装设备数据失败:', e);
  }
}, 5 * 60 * 1000); 

const adminMiddleware = (req, res, next) => {
  if (req.path.startsWith('/admin') || req.path.includes('.') || req.path.startsWith('/docs')) {
    return next();
  }

  const guid = req.cookies?.KUGOU_API_GUID || req.headers['x-guid'] || 'unknown';

  if (guid !== 'unknown') {
    const realIp = req.headers['x-forwarded-for']?.split(',')[0] || req.ip;
    const authStr = req.headers.authorization || (req.query && req.query.cookie) || req.headers.cookie || '';
    const hasToken = /token=([^;]+)/i.test(authStr);
    const existingDevice = connectedDevices.get(guid);
    
    let currentIsLogged = hasToken || (existingDevice?.isLogged || false);
    let bestNickname = existingDevice?.nickname || '访客';

    if (hasToken) {
      currentIsLogged = true;
      const nameMatch = authStr.match(/(?:nickname|username|kugouId)=([^;]+)/i);
      if (nameMatch) {
        try { 
          const decoded = decodeURIComponent(nameMatch[1]); 
          if (getNickScore(decoded) > getNickScore(bestNickname)) bestNickname = decoded;
        } catch (e) {}
      } 
      
      const useridMatch = authStr.match(/userid=([^;]+)/i);
      if (useridMatch) {
        const fallbackName = `用户_${useridMatch[1]}`;
        if (getNickScore(fallbackName) > getNickScore(bestNickname)) bestNickname = fallbackName;
      } else if (getNickScore('已登录用户') > getNickScore(bestNickname)) {
        bestNickname = '已登录用户';
      }
    }
    
    connectedDevices.set(guid, {
      guid,
      ip: realIp.replace('::ffff:', '').trim(), 
      lastSeen: Date.now(),
      userAgent: req.headers['user-agent'] || 'unknown',
      isLogged: currentIsLogged,      
      nickname: bestNickname       
    });

    if (req.path.includes('/login') || req.path.includes('/user')) {
      const originalSend = res.send;
      res.send = function (body) {
        try {
          if (res.statusCode === 200 && body) {
            const parsed = typeof body === 'string' ? JSON.parse(body) : body;
            const dataObj = parsed.data || parsed;
            const candidates = [
              dataObj.nickname, dataObj.userinfo?.nickname, dataObj.user_name, dataObj.username
            ];
            let bestSniffed = '';
            for (const c of candidates) {
              if (c && typeof c === 'string' && getNickScore(c) > getNickScore(bestSniffed)) {
                bestSniffed = c;
              }
            }
            if (bestSniffed && guid !== 'unknown') {
              const dev = connectedDevices.get(guid);
              if (dev && getNickScore(bestSniffed) >= getNickScore(dev.nickname)) {
                dev.nickname = bestSniffed;
                dev.isLogged = true;
              }
            }
          }
        } catch (err) {}
        return originalSend.apply(this, arguments);
      };
    }
  }

  // 黑名单最高优先级拦截
  if (adminConfig.blacklist && adminConfig.blacklist.includes(guid)) {
    return res.status(403).json({ 
      code: 403, 
      data: null,
      msg: '访问被拒绝：您的设备已被服务器管理员列入黑名单，禁止连接API！' 
    });
  }

  // 白名单拦截逻辑
  if (adminConfig.mode === 'whitelist') {
    if (!adminConfig.whitelist.includes(guid)) {
      return res.status(403).json({ 
        code: 403, 
        data: null,
        msg: '访问被拒绝：当前设备未加入服务器白名单' 
      });
    }
  }

  next();
};

const adminRouter = express.Router();
adminRouter.use(express.json());

adminRouter.get('/api/status', (req, res) => res.json({ isSetup: adminConfig.isSetup }));

adminRouter.post('/api/setup', (req, res) => {
  if (adminConfig.isSetup) return res.status(400).json({ msg: '系统已被初始化' });
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ msg: '账号和密码不能为空' });
  adminConfig.isSetup = true;
  adminConfig.username = username;
  adminConfig.password = cryptoMd5(password);
  saveConfig();
  res.json({ msg: '管理员初始化成功' });
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, 
  max: 5, 
  message: { code: 429, msg: '密码尝试次数过多，请 15 分钟后再试' },
  standardHeaders: true, legacyHeaders: false,
});

adminRouter.post('/api/login', loginLimiter, (req, res) => {
  const { username, password } = req.body;
  if (username === adminConfig.username && cryptoMd5(password) === adminConfig.password) {
    const token = randomString(32);
    adminTokens.set(token, Date.now() + 24 * 60 * 60 * 1000);
    res.json({ token });
  } else res.status(401).json({ msg: '账号或密码错误' });
});

adminRouter.use((req, res, next) => {
  const token = (req.headers['authorization'] || '').replace('Bearer ', '');
  const expireAt = adminTokens.get(token);
  if (!expireAt || Date.now() > expireAt) {
    if (expireAt) adminTokens.delete(token); 
    return res.status(401).json({ msg: '登录已过期，请重新登录' });
  }
  next();
});

adminRouter.get('/api/devices', (req, res) => {
  res.json(Array.from(connectedDevices.values()).sort((a, b) => b.lastSeen - a.lastSeen));
});

adminRouter.post('/api/devices/delete', (req, res) => {
  const { guids } = req.body;
  if (Array.isArray(guids)) {
    guids.forEach(g => connectedDevices.delete(g));
  }
  res.json({ msg: '删除成功' });
});

adminRouter.get('/api/config', (req, res) => {
  res.json({ mode: adminConfig.mode, whitelist: adminConfig.whitelist, blacklist: adminConfig.blacklist || [] });
});

adminRouter.post('/api/config/mode', (req, res) => {
  const { mode } = req.body;
  if (['unrestricted', 'whitelist'].includes(mode)) {
    adminConfig.mode = mode;
    saveConfig();
    res.json({ msg: '模式更新成功', mode });
  } else res.status(400).json({ msg: '无效的模式' });
});

// 统一权限控制接口
adminRouter.post('/api/permission', (req, res) => {
  const { guid, target } = req.body;
  
  if (!adminConfig.whitelist) adminConfig.whitelist = [];
  if (!adminConfig.blacklist) adminConfig.blacklist = [];

  if (target === 'whitelist') {
    if (!adminConfig.whitelist.includes(guid)) adminConfig.whitelist.push(guid);
    adminConfig.blacklist = adminConfig.blacklist.filter(g => g !== guid);
  } 
  else if (target === 'blacklist') {
    if (!adminConfig.blacklist.includes(guid)) adminConfig.blacklist.push(guid);
    adminConfig.whitelist = adminConfig.whitelist.filter(g => g !== guid);
  } 
  else if (target === 'normal') {
    adminConfig.whitelist = adminConfig.whitelist.filter(g => g !== guid);
    adminConfig.blacklist = adminConfig.blacklist.filter(g => g !== guid);
  }

  saveConfig();
  res.json({ whitelist: adminConfig.whitelist, blacklist: adminConfig.blacklist });
});

module.exports = { adminMiddleware, adminRouter };