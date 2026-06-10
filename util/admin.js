// util/admin.js
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { cryptoMd5 } = require('./crypto');
const { randomString } = require('./util');
const rateLimit = require('express-rate-limit'); 

const configPath = path.join(process.cwd(), '.admin_config.json');
// 【新增】：设备持久化文件，防重启失忆
const devicesPath = path.join(process.cwd(), '.admin_devices.json'); 

// 默认配置
let adminConfig = {
  isSetup: false,
  username: '',
  password: '',
  mode: 'unrestricted', 
  whitelist: []
};

if (fs.existsSync(configPath)) {
  try {
    adminConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (e) {
    console.error('[Admin] 配置文件解析失败，使用默认配置');
  }
}

const saveConfig = () => {
  fs.writeFileSync(configPath, JSON.stringify(adminConfig, null, 2), 'utf8');
};

const adminTokens = new Map(); 
const connectedDevices = new Map();

// 【新增】：启动时从本地硬盘恢复设备记录，防重启丢失真实昵称
if (fs.existsSync(devicesPath)) {
  try {
    const savedDevices = JSON.parse(fs.readFileSync(devicesPath, 'utf8'));
    for (const [k, v] of Object.entries(savedDevices)) {
      connectedDevices.set(k, v);
    }
  } catch (e) {}
}

/**
 * 【核心优化】：昵称质量评分系统
 * 分数越高的名字质量越好，系统强制不允许低分名字覆盖高分名字
 */
const getNickScore = (name) => {
  if (!name) return 0;
  const str = String(name).trim();
  if (str === '访客') return 1;
  if (str === '已登录用户') return 2;
  if (str.startsWith('用户_')) return 3;
  if (/^\d+$/.test(str)) return 4; // 纯数字的酷狗 ID
  if (str.toLowerCase().startsWith('kugou')) return 4;
  return 5; // 真正的高质量中文/英文昵称
};

// 定时清洁工 (改为每 5 分钟执行一次，同时负责保存数据)
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
  
  // 【新增】：每隔5分钟自动将设备记录保存到硬盘，防容器重启
  try {
    const obj = {};
    for (const [k, v] of connectedDevices.entries()) {
      obj[k] = v;
    }
    fs.writeFileSync(devicesPath, JSON.stringify(obj), 'utf8');
  } catch(e) {}
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
    
    // 默认先继承旧名字（如果有的话）
    let bestNickname = existingDevice?.nickname || '访客';

    if (hasToken) {
      currentIsLogged = true;
      
      // 1. 尝试直接从头部获取
      const nameMatch = authStr.match(/(?:nickname|username|kugouId)=([^;]+)/i);
      if (nameMatch) {
        try { 
          const decoded = decodeURIComponent(nameMatch[1]); 
          // 只有新提取的名字质量比当前的好，才允许替换
          if (getNickScore(decoded) > getNickScore(bestNickname)) bestNickname = decoded;
        } catch (e) {}
      } 
      
      // 2. 如果头部没有好名字，使用 userid 兜底
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

    // =========================================================================
    // 【黑科技：响应拦截器】
    // =========================================================================
    if (req.path.includes('/login') || req.path.includes('/user')) {
      const originalSend = res.send;
      res.send = function (body) {
        try {
          if (res.statusCode === 200 && body) {
            const parsed = typeof body === 'string' ? JSON.parse(body) : body;
            const dataObj = parsed.data || parsed;
            
            // 将所有可能藏着昵称的字段扫一遍
            const candidates = [
              dataObj.nickname,
              dataObj.userinfo?.nickname,
              dataObj.user_name,
              dataObj.username
            ];
            
            let bestSniffed = '';
            for (const c of candidates) {
              if (c && typeof c === 'string' && getNickScore(c) > getNickScore(bestSniffed)) {
                bestSniffed = c;
              }
            }
            
            if (bestSniffed && guid !== 'unknown') {
              const dev = connectedDevices.get(guid);
              // 【严格把关】：抓到的名字，必须质量大于等于现在的名字才能覆盖！
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

adminRouter.get('/api/status', (req, res) => {
  res.json({ isSetup: adminConfig.isSetup });
});

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
  message: { code: 429, msg: '密码尝试次数过多，为保护账户安全，请 15 分钟后再试' },
  standardHeaders: true,
  legacyHeaders: false,
});

adminRouter.post('/api/login', loginLimiter, (req, res) => {
  const { username, password } = req.body;
  if (username === adminConfig.username && cryptoMd5(password) === adminConfig.password) {
    const token = randomString(32);
    adminTokens.set(token, Date.now() + 24 * 60 * 60 * 1000);
    res.json({ token });
  } else {
    res.status(401).json({ msg: '账号或密码错误' });
  }
});

adminRouter.use((req, res, next) => {
  const token = (req.headers['authorization'] || '').replace('Bearer ', '');
  const expireAt = adminTokens.get(token);
  
  if (!expireAt || Date.now() > expireAt) {
    if (expireAt) adminTokens.delete(token); 
    return res.status(401).json({ msg: '登录已过期或未授权，请重新登录' });
  }
  next();
});

adminRouter.get('/api/devices', (req, res) => {
  const devices = Array.from(connectedDevices.values()).sort((a, b) => b.lastSeen - a.lastSeen);
  res.json(devices);
});

adminRouter.get('/api/config', (req, res) => {
  res.json({ mode: adminConfig.mode, whitelist: adminConfig.whitelist });
});

adminRouter.post('/api/config/mode', (req, res) => {
  const { mode } = req.body;
  if (mode === 'unrestricted' || mode === 'whitelist') {
    adminConfig.mode = mode;
    saveConfig();
    res.json({ msg: '模式更新成功', mode });
  } else {
    res.status(400).json({ msg: '无效的模式' });
  }
});

adminRouter.post('/api/whitelist', (req, res) => {
  const { guid, action } = req.body;
  if (action === 'add') {
    if (!adminConfig.whitelist.includes(guid)) adminConfig.whitelist.push(guid);
  } else if (action === 'remove') {
    adminConfig.whitelist = adminConfig.whitelist.filter(g => g !== guid);
  }
  saveConfig();
  res.json({ whitelist: adminConfig.whitelist });
});

module.exports = { adminMiddleware, adminRouter };