const axios = require('axios');
const CryptoJS = require('crypto-js');
const { signKey, signatureAndroidParams, signatureRegisterParams, signatureWebParams } = require('./helper');
const { parseCookieString } = require('./util');
const { appid, clientver, liteAppid, liteClientver } = require('./config.json');
const { cryptoMd5, rsaEncrypt2, publicLiteRasKey, publicRasKey } = require('./crypto');
const { resolveProxy } = require('./runtime');
const { generateSimulate } = require('./generate_simulate');

// 酷狗云歌单服务（cloudlist）加密协议配置，区分标准版/概念版 lite
// appkey/apprsa 为客户端内置配置（listen.usersdkparam.appkey / .apprsa）
const CLOUDLIST_CONF = {
  lite: {
    appid: liteAppid,
    clientver: liteClientver,
    appkey: 'LnT6xpN3khm36zse0QzvmgTZ3waWdRSA',
    publicKey: publicLiteRasKey,
  },
  default: {
    appid,
    clientver,
    appkey: 'OIlwieks28dk2k092lksi2UIkp',
    publicKey: publicRasKey,
  },
};

/**
 * @typedef {{status: number;body: any, cookie: string[], headers?: Record<string, string>}} UseAxiosResponse
 */

/**
 * 请求创建
 * @param {Object} options
 * @param {'get' | 'GET' | 'post' | 'POST'} options.method 请求方法
 * @param {string} options.url 请求 url
 * @param {string?} options.baseURL
 * @param {Record<string, any>?} options.params 请求参数
 * @param {Record<string, any>?} options.data 请求Body
 * @param {Record<string, string | number>?} options.headers 请求headers
 * @param {'android' | 'web' | 'register'} options.encryptType signature加密方式
 * @param {{ [key: string]: string | number }} options.cookie 请求cookie
 * @param {boolean?} options.encryptKey
 * @param {boolean?} options.clearDefaultParams 清除默认请求参数
 * @param {boolean?} options.notSignature
 * @param {string?} options.ip
 * @param {string?} options.realIP
 * @returns {Promise<UseAxiosResponse>}
 */

const createRequest = (options) => {
  return new Promise(async (resolve, reject) => {
    const isLite = process.env.platform === 'lite';
    const dfid = options?.cookie?.dfid || '-'; // 自定义
    const mid = `${options?.cookie?.KUGOU_API_MID}`; //'334689572176563962868706300678062568191';
    const uuid = '-'; //cryptoMd5(`${dfid}${mid}`); // 可以自定义
    const token = options?.cookie?.token || '';
    const userid = options?.cookie?.userid || 0;
    const clienttime = Math.floor(Date.now() / 1000);
    const ip = options?.realIP || options?.ip || '';
    const webglHash = options?.cookie?.KUGOU_API_WEBGL; // WebGL 指纹哈希（用于行为指纹模拟）
    const headers = { dfid, clienttime, mid, 'kg-rc': '1', 'kg-thash': '5d816a0', 'kg-rec': 1, 'kg-rf': 'B9EDA08A64250DEFFBCADDEE00F8F25F' };

    if (ip) {
      headers['X-Real-IP'] = ip;
      headers['X-Forwarded-For'] = ip;
    }

    const defaultParams = {
      dfid,
      mid,
      uuid,
      appid: isLite ? liteAppid : appid,
      clientver: isLite ? liteClientver : clientver,
      clienttime,
    };

    if (token) defaultParams['token'] = token;
    if (userid && userid !== 0) defaultParams['userid'] = userid;
    const params = options?.clearDefaultParams ? options?.params || {} : Object.assign({}, defaultParams, options?.params || {});

    headers['clienttime'] = params.clienttime;

    if (options?.encryptKey) {
      params['key'] = signKey(params['hash'], params['mid'], params['userid'], params['appid']);
    }

    // 二进制 body（如听歌识曲的 PCM 数据）保持 Buffer 原样透传，避免 JSON.stringify 损坏字节
    const data = Buffer.isBuffer(options?.data) ? options.data : typeof options?.data === 'object' ? JSON.stringify(options.data) : options?.data || '';

    if (!params['signature'] && !options.notSignature) {
      switch (options?.encryptType) {
        case 'register':
          params['signature'] = signatureRegisterParams(params);
          break;
        case 'web':
          params['signature'] = signatureWebParams(params, data);
          break;
        case 'android':
        default:
          params['signature'] = signatureAndroidParams(params, data);
          break;
      }
    }

    // options.params = params;
    options['params'] = params;
    options['baseURL'] = options?.baseURL || 'https://gateway.kugou.com';
    const explicitHeaders = options.headers || {};
    // clearDefaultHeaders：仅使用模块声明的协议请求头（如听歌识曲等特殊接口）
    options['headers'] = options.clearDefaultHeaders
      ? { ...explicitHeaders }
      : Object.assign({ 'User-Agent': 'Android15-1070-11083-46-0-DiscoveryDRADProtocol-wifi' }, options?.headers || {}, {
          dfid,
          clienttime: params.clienttime,
          mid,
        });

    const requestOptions = {
      params,
      data: options?.data,
      method: options.method,
      baseURL: options?.baseURL,
      url: options.url,
      headers: options.clearDefaultHeaders ? { ...explicitHeaders } : Object.assign({}, options?.headers || {}, headers),
      withCredentials: true,
      responseType: options.responseType,
      timeout: 10000,
    };

    const proxyConfig = resolveProxy();
    if (proxyConfig) {
      requestOptions.proxy = proxyConfig;
    }

    if (options.data) requestOptions.data = options.data;
    if (params) requestOptions.params = params;

    if (options.baseURL?.includes('openapicdn')) {
      const url = requestOptions.url;
      const _params = Object.keys(params)
        .map((key) => `${key}=${params[key]}`)
        .join('&');
      requestOptions.url = `${url}?${_params}`;
      requestOptions.params = {};
    }

    const answer = { status: 500, body: {}, cookie: [], headers: {} };
    try {
      const response = await axios(requestOptions);

      const body = response.data;
      let ssaCode = '';

      answer.cookie = (response.headers['set-cookie'] || []).map((x) => parseCookieString(x));

      // SSA 验证码处理：ssa-code 响应头表示需要二次安全验证（滑块/短信验证码）
      if (response.headers['ssa-code'] || response.headers['SSA-CODE']) {
        const _ssaCode = response.headers['ssa-code'] || response.headers['SSA-CODE'];
        answer.headers['ssa-code'] = _ssaCode;
        ssaCode = _ssaCode;
      }

      try {
        answer.body = JSON.parse(body.toString());
      } catch (error) {
        answer.body = body;
      }

      if (response.data.status === 0 || (response.data?.error_code && response.data.error_code !== 0)) {
        // 请求失败：当存在 SSA 验证码时，生成模拟行为指纹（sid/edt）附到响应体，
        // 客户端可据此完成后续验证请求（如 /sidedt、/verify/user/info）
        if (ssaCode) {
          const { edt, sid } = generateSimulate(mid, userid, dfid, webglHash);
          if (edt) answer.body.edt = edt;
          if (sid) answer.body.sid = sid;
          answer.body.ssaCode = ssaCode;
        }
        answer.status = 502;
        reject(answer);
      } else {
        // 请求成功：某些接口成功时也可能要求二次验证，同样附加 sid/edt
        if (ssaCode) {
          const { edt, sid } = generateSimulate(mid, userid, dfid, webglHash);
          if (edt) answer.body.edt = edt;
          if (sid) answer.body.sid = sid;
          answer.body.ssaCode = ssaCode;
        }
        answer.status = 200;
        resolve(answer);
      }
    } catch (e) {
      answer.status = 502;
      answer.body = { status: 0, msg: e };
      reject(answer);
    }
  });
};

/**
 * 创建并发送云歌单服务（cloudlist）请求
 *
 * 云歌单服务（cloudlist.service.kugou.com）使用与网关不同的加密协议：
 * 1. `key`: MD5(appid + appkey + clientver + clienttime) 请求签名
 * 2. `p`: RSA(PKCS1) 加密的会话串（随机6字符 aes + uid + token），Hex 大写
 * 3. 请求体: 用 MD5(aes)[0:16] 作为 key、MD5(aes)[16:32] 作为 IV 的 AES-CBC 加密
 * 4. 响应体同样使用该 AES key/iv 加密，需解密后返回
 *
 * @param {Object} options - 请求配置
 * @param {string} options.url - 请求路径（如 "/v1/modify_list_sort"）
 * @param {Object} options.data - 请求体（JSON 对象，会被加密）
 * @param {Object} options.cookie - 请求 Cookie 对象（需含 userid/token）
 * @param {string} [options.ip] - 客户端 IP
 * @returns {Promise<UseAxiosResponse>} 统一格式的响应对象
 */
const createCloudRequest = (options) => {
  return new Promise(async (resolve, reject) => {
    const isLite = process.env.platform === 'lite';
    const conf = CLOUDLIST_CONF[isLite ? 'lite' : 'default'];
    const cookie = options?.cookie || {};
    const mid = `${cookie?.KUGOU_API_MID || cookie?.mid || ''}`;
    const dfid = cookie?.dfid || '-';
    const userid = cookie?.userid || 0;
    const token = cookie?.token || '';
    const ip = options?.realIP || options?.ip || '';

    // 会话串与 AES key/iv：随机 6 字符会话串（与客户端 f() 一致），再由 MD5 推导 AES key/iv
    const aesAlphabet = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const aes = Array.from({ length: 6 }, () => aesAlphabet[Math.floor(Math.random() * 62)]).join('');
    const md5 = cryptoMd5(aes);
    const aesKey = md5.substring(0, 16);
    const aesIv = md5.substring(16, 32);

    // key = MD5(appid + appkey + clientver + clienttime).toLowerCase()
    const clienttime = Math.floor(Date.now() / 1000);
    const key = cryptoMd5(`${conf.appid}${conf.appkey}${conf.clientver}${clienttime}`).toLowerCase();

    // p = Hex(RSA-encrypt({"aes":..., "uid":..., "token":...})).toUpperCase()
    const portraitPlain = JSON.stringify({ aes, uid: userid, token });
    const portrait = rsaEncrypt2(portraitPlain).toUpperCase();

    const params = {
      appid: conf.appid,
      clientver: conf.clientver,
      mid,
      clienttime,
      key,
      dfid,
      p: portrait,
    };

    const data = typeof options?.data === 'object' ? JSON.stringify(options.data) : options?.data || '';
    const cipher = CryptoJS.AES.encrypt(CryptoJS.enc.Utf8.parse(data), CryptoJS.enc.Utf8.parse(aesKey), {
      iv: CryptoJS.enc.Utf8.parse(aesIv),
      mode: CryptoJS.mode.CBC,
      padding: CryptoJS.pad.Pkcs7,
    });
    const body = Buffer.from(cipher.ciphertext.toString(CryptoJS.enc.Hex), 'hex');

    const headers = {
      'x-router': 'cloudlist.service.kugou.com',
      dfid,
      clienttime: String(clienttime),
      mid,
      'kg-rc': '1',
      'kg-thash': '5d816a0',
      'kg-rec': 1,
      'kg-rf': 'B9EDA08A64250DEFFBCADDEE00F8F25F',
    };

    if (ip) {
      headers['X-Real-IP'] = ip;
      headers['X-Forwarded-For'] = ip;
    }

    const requestOptions = {
      method: 'post',
      // service 域名的证书不覆盖该主机名，使用正常校验证书的网关入口。
      baseURL: options?.baseURL || 'https://gateway.kugou.com',
      url: options.url,
      params,
      data: body,
      headers: Object.assign({ 'Content-Type': 'application/json;charset=utf-8' }, headers),
      responseType: 'arraybuffer',
    };

    const proxyConfig = resolveProxy();
    if (proxyConfig) {
      requestOptions.proxy = proxyConfig;
    }

    const answer = { status: 500, body: {}, cookie: [], headers: {} };
    try {
      const response = await axios(requestOptions);
      const raw = Buffer.from(response.data);

      // AES-CBC 解密响应体；服务端未加密时直接使用原始响应
      let text = '';
      try {
        const decipher = CryptoJS.AES.decrypt(
          CryptoJS.lib.CipherParams.create({ ciphertext: CryptoJS.enc.Hex.parse(raw.toString('hex')) }),
          CryptoJS.enc.Utf8.parse(aesKey),
          { iv: CryptoJS.enc.Utf8.parse(aesIv), mode: CryptoJS.mode.CBC, padding: CryptoJS.pad.Pkcs7 }
        );
        text = decipher.toString(CryptoJS.enc.Utf8);
      } catch (e) {
        text = '';
      }
      if (!text) text = raw.toString('utf8');

      try {
        answer.body = JSON.parse(text);
      } catch (e) {
        answer.body = { status: 0, msg: text };
        reject(answer);
        return;
      }

      if (answer.body.status === 0 || (answer.body?.error_code && answer.body.error_code !== 0)) {
        answer.status = 502;
        reject(answer);
      } else {
        answer.status = 200;
        resolve(answer);
      }
    } catch (e) {
      answer.status = 502;
      answer.body = { status: 0, msg: e };
      reject(answer);
    }
  });
};

module.exports = { createRequest, createCloudRequest };
