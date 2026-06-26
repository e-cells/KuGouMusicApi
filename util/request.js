const axios = require('axios');
const { signKey, signatureAndroidParams, signatureRegisterParams, signatureWebParams } = require('./helper');
const { parseCookieString } = require('./util');
const { appid, clientver, liteAppid, liteClientver } = require('./config.json');
const { resolveProxy } = require('./runtime');
const { generateSimulate } = require('./generate_simulate');

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
          params['signature'] = signatureWebParams(params);
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
    options['headers'] = Object.assign({ 'User-Agent': 'Android15-1070-11083-46-0-DiscoveryDRADProtocol-wifi' }, options?.headers || {}, {
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
      headers: Object.assign({}, options?.headers || {}, headers),
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

module.exports = { createRequest };
