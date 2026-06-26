const pako = require('pako');
const CryptoJS = require('crypto-js');
const bigInt = require('big-integer');

/**
 * 随机字符串
 * @param {number} len
 * @returns {string}
 */
const randomString = (len = 16) => {
  const keyString = '1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const _key = [];
  const keyStringArr = keyString.split('');
  for (let i = 0; i < len; i += 1) {
    const ceil = Math.ceil((keyStringArr.length - 1) * Math.random());
    const _tmp = keyStringArr[ceil];
    _key.push(_tmp);
  }

  return _key.join('');
};

const randomNumber = (len = 16) => {
  const keyString = '1234567890';
  const _key = [];
  const keyStringArr = keyString.split('');
  for (let i = 0; i < len; i += 1) {
    const ceil = Math.ceil((keyStringArr.length - 1) * Math.random());
    const _tmp = keyStringArr[ceil];
    _key.push(_tmp);
  }

  return _key.join('');
};

/**
 * 格式化cookie
 * @param {string} cookie
 * @returns {string}
 */
const parseCookieString = (cookie) => {
  const t = cookie.replace(/\s*(Domain|domain|path|expires)=[^(;|$)]+;*/g, '');
  return t.replace(/;HttpOnly/g, '');
};

/**
 * cookie 转 json
 * @param {string} cookie
 * @returns
 */
const cookieToJson = (cookie) => {
  if (!cookie) return {};
  let cookieArr = cookie.split(';');
  let obj = {};
  cookieArr.forEach((i) => {
    let arr = i.split('=');
    obj[arr[0]] = arr[1];
  });
  return obj;
};

/**
 * krc解码
 * @param {string | Uint8Array | Buffer} val
 * @returns {string}
 */
const decodeLyrics = (val) => {
  let bytes = null;
  if (val instanceof Uint8Array) bytes = val;
  if (Buffer.isBuffer(val)) bytes = new Uint8Array(val);
  if (typeof val === 'string') bytes = new Uint8Array(Buffer.from(val, 'base64'));
  if (bytes === null) return '';
  const enKey = [64, 71, 97, 119, 94, 50, 116, 71, 81, 54, 49, 45, 206, 210, 110, 105];
  const krcBytes = bytes.slice(4);
  const len = krcBytes.byteLength;
  for (let index = 0; index < len; index += 1) {
    krcBytes[index] = krcBytes[index] ^ enKey[index % enKey.length];
  }
  try {
    const inflate = pako.inflate(krcBytes);
    return Buffer.from(inflate).toString('utf8');
  } catch {
    return '';
  }
};

const calculateMid = (str) => {
  let bigInteger = bigInt(0);
  const bigInteger2 = bigInt(16);
  const digest = CryptoJS.MD5(str).toString(CryptoJS.enc.Hex);
  const length = digest.length;
  for (let i = 0; i < length; i += 1) {
    const charValue = bigInt(parseInt(digest.charAt(i), 16));
    const powerValue = bigInteger2.pow(length - 1 - i);
    bigInteger = bigInteger.add(charValue.multiply(powerValue));
  }
  return bigInteger.toString();
};

const getGuid = () => {
  const e = () => {
    return ((65536 * (1 + Math.random())) | 0).toString(16).substring(1);
  };

  return `${e()}${e()}-${e()}-${e()}-${e()}-${e()}${e()}${e()}`;
};

// 生成 WebGL 指纹哈希（FNV-1a 64-bit）
// 浏览器环境：通过 canvas 获取真实的 WebGL 渲染器信息并哈希
// Node 环境：生成随机 uint64 作为模拟指纹
const generateWebGLHash = () => {
  // 浏览器环境：通过 canvas 获取真实的 WebGL 渲染器信息
  if (typeof document !== 'undefined') {
    try {
      const c = document.createElement('canvas');
      c.width = 200;
      c.height = 50;
      const gl = c.getContext('webgl') || c.getContext('experimental-webgl');
      if (gl) {
        // --- 编译着色器（和 WASM 中的逻辑一致）---
        const vs = gl.createShader(gl.VERTEX_SHADER);
        gl.shaderSource(vs, 'attribute vec4 position;void main(){gl_Position=position;}');
        gl.compileShader(vs);
        const fs = gl.createShader(gl.FRAGMENT_SHADER);
        gl.shaderSource(fs, 'void main(){gl_FragColor=vec4(1.0,1.0,1.0,1.0);}');
        gl.compileShader(fs);
        const prog = gl.createProgram();
        gl.attachShader(prog, vs);
        gl.attachShader(prog, fs);
        gl.linkProgram(prog);
        gl.useProgram(prog);

        // --- 绘制一个三角形 ---
        const buf = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1]), gl.STATIC_DRAW);
        const pos = gl.getAttribLocation(prog, 'position');
        gl.enableVertexAttribArray(pos);
        gl.vertexAttribPointer(pos, 2, gl.FLOAT, false, 0, 0);
        gl.viewport(0, 0, 200, 50);
        gl.clearColor(0, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.drawArrays(gl.TRIANGLES, 0, 3);

        // --- 读取渲染结果并哈希 ---
        const pixels = new Uint8Array(200 * 50 * 4);
        gl.readPixels(0, 0, 200, 50, gl.RGBA, gl.UNSIGNED_BYTE, pixels);

        // 同时加入元数据（显卡厂商、渲染器名称、WebGL 版本）
        const dbg = gl.getExtension('WEBGL_debug_renderer_info');
        const vendor = dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : '';
        const renderer = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : '';
        const version = gl.getParameter(gl.VERSION);

        // FNV-1a 64-bit 哈希算法
        let h = BigInt('14695981039346656037'); // FNV offset basis
        const prime = BigInt('1099511628211'); // FNV prime

        // 哈希像素数据
        for (let i = 0; i < pixels.length; i++) {
          h = ((h ^ BigInt(pixels[i])) * prime) & BigInt('0xFFFFFFFFFFFFFFFF');
        }
        // 哈希元数据
        const meta = vendor + '|' + renderer + '|' + version;
        for (let i = 0; i < meta.length; i++) {
          h = ((h ^ BigInt(meta.charCodeAt(i))) * prime) & BigInt('0xFFFFFFFFFFFFFFFF');
        }
        return h.toString();
      }
    } catch (e) {}
  }
  // Node 环境或 WebGL 不可用：生成随机 uint64 作为模拟指纹
  const hi = Math.floor(Math.random() * 0xffffffff);
  const lo = Math.floor(Math.random() * 0xffffffff);
  return (BigInt(hi) * BigInt(0x100000000) + BigInt(lo)).toString();
};

module.exports = {
  decodeLyrics,
  cookieToJson,
  parseCookieString,
  randomString,
  randomNumber,
  calculateMid,
  getGuid,
  generateWebGLHash
};
