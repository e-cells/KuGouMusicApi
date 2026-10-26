const CryptoJS = require('crypto-js');
const nodeCrypto = require('node:crypto');
const { randomString } = require('./util');
const publicRasKey = `-----BEGIN PUBLIC KEY-----\nMIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDIAG7QOELSYoIJvTFJhMpe1s/gbjDJX51HBNnEl5HXqTW6lQ7LC8jr9fWZTwusknp+sVGzwd40MwP6U5yDE27M/X1+UR4tvOGOqp94TJtQ1EPnWGWXngpeIW5GxoQGao1rmYWAu6oi1z9XkChrsUdC6DJE5E221wf/4WLFxwAtRQIDAQAB\n-----END PUBLIC KEY-----`;
const publicLiteRasKey = `-----BEGIN PUBLIC KEY-----\nMIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDECi0Np2UR87scwrvTr72L6oO01rBbbBPriSDFPxr3Z5syug0O24QyQO8bg27+0+4kBzTBTBOZ/WWU0WryL1JSXRTXLgFVxtzIY41Pe7lPOgsfTCn5kZcvKhYKJesKnnJDNr5/abvTGf+rHG3YRwsCHcQ08/q6ifSioBszvb3QiwIDAQAB\n-----END PUBLIC KEY-----`;

const rsaKeyCache = new Map();

function encodeUtf8(str) {
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(str);
  }

  if (typeof Buffer !== 'undefined') {
    return new Uint8Array(Buffer.from(str, 'utf8'));
  }

  const codePoints = [];
  for (let i = 0; i < str.length; i++) {
    let code = str.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < str.length) {
      const next = str.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = ((code - 0xd800) << 10) + (next - 0xdc00) + 0x10000;
        i++;
      }
    }
    codePoints.push(code);
  }

  const bytes = [];
  for (const code of codePoints) {
    if (code <= 0x7f) {
      bytes.push(code);
    } else if (code <= 0x7ff) {
      bytes.push(
        0xc0 | (code >> 6),
        0x80 | (code & 0x3f),
      );
    } else if (code <= 0xffff) {
      bytes.push(
        0xe0 | (code >> 12),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    } else {
      bytes.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    }
  }

  return new Uint8Array(bytes);
}

function decodeUtf8(uint8) {
  if (typeof TextDecoder !== 'undefined') {
    return new TextDecoder().decode(uint8);
  }

  if (typeof Buffer !== 'undefined') {
    return Buffer.from(uint8).toString('utf8');
  }

  let out = '';
  let i = 0;
  while (i < uint8.length) {
    const byte1 = uint8[i++];
    if (byte1 < 0x80) {
      out += String.fromCharCode(byte1);
      continue;
    }
    if (byte1 < 0xe0) {
      const byte2 = uint8[i++] & 0x3f;
      const codePoint = ((byte1 & 0x1f) << 6) | byte2;
      out += String.fromCharCode(codePoint);
      continue;
    }
    if (byte1 < 0xf0) {
      const byte2 = uint8[i++] & 0x3f;
      const byte3 = uint8[i++] & 0x3f;
      const codePoint = ((byte1 & 0x0f) << 12) | (byte2 << 6) | byte3;
      out += String.fromCharCode(codePoint);
      continue;
    }

    const byte2 = uint8[i++] & 0x3f;
    const byte3 = uint8[i++] & 0x3f;
    const byte4 = uint8[i++] & 0x3f;
    let codePoint = ((byte1 & 0x07) << 18) | (byte2 << 12) | (byte3 << 6) | byte4;
    codePoint -= 0x10000;
    out += String.fromCharCode(
      (codePoint >> 10) + 0xd800,
      (codePoint & 0x3ff) + 0xdc00,
    );
  }

  return out;
}

function normalizeBuffer(data) {
  if (data instanceof Uint8Array) return data;
  const str = typeof data === 'string' ? data : JSON.stringify(data);
  return encodeUtf8(str);
}

function wordArrayFromBuffer(uint8) {
  const words = [];
  for (let i = 0; i < uint8.length; i += 4) {
    words.push(
      ((uint8[i] || 0) << 24) | ((uint8[i + 1] || 0) << 16) |
      ((uint8[i + 2] || 0) << 8) | (uint8[i + 3] || 0)
    );
  }
  return CryptoJS.lib.WordArray.create(words, uint8.length);
}

function wordArrayToBuffer(wordArray) {
  const { words, sigBytes } = wordArray;
  const uint8 = new Uint8Array(sigBytes);
  for (let i = 0; i < sigBytes; i++) {
    uint8[i] = (words[i >>> 2] >>> (24 - (i % 4) * 8)) & 0xff;
  }
  return uint8;
}


function utf8WordArray(input) {
  return typeof input === 'string' ? CryptoJS.enc.Utf8.parse(input) : wordArrayFromBuffer(input);
}

function getPublicKey(pem) {
  if (!rsaKeyCache.has(pem)) {
    rsaKeyCache.set(pem, nodeCrypto.createPublicKey(pem));
  }
  return rsaKeyCache.get(pem);
}

/** RSA 公钥模长（字节），1024 位密钥 → 128 */
function rsaKeyLength(key) {
  const bits = key.asymmetricKeyDetails?.modulusLength;
  if (bits) return Math.ceil(bits / 8);
  const jwk = key.export({ format: 'jwk' }); // 旧 Node 无 asymmetricKeyDetails 时走 JWK 兜底
  return Buffer.from(jwk.n, 'base64').length;
}

/**
 * 无填充 RSA（textbook RSA）：明文右侧补零至模长后直接 modPow
 * 与原 node-forge 实现逐位等价（ forge.jsbn.BigInteger modPow → RSA_NO_PADDING ）
 */
function rsaRawEncrypt(buffer, publicKey) {
  const keyLength = rsaKeyLength(publicKey);
  if (buffer.length > keyLength) throw new Error('Data length exceeds key size');
  let padded = Buffer.from(buffer);
  if (buffer.length < keyLength) {
    padded = Buffer.alloc(keyLength);
    padded.set(buffer);
  }
  return nodeCrypto.publicEncrypt({ key: publicKey, padding: nodeCrypto.constants.RSA_NO_PADDING }, padded).toString('hex');
}

/**
 * @typedef {{str: string, key: string}} AesEncrypt
 */

/**
 * MD5 加密
 * @param {BufferLike} data
 * @returns {string}
 */
function cryptoMd5(data) {
  const buffer = typeof data === 'object' ? JSON.stringify(data) : data;
  return CryptoJS.MD5(buffer).toString(CryptoJS.enc.Hex);
}

/**
 * Sha1 加密
 * @param {BufferLike} data
 * @returns { string }
 */
function cryptoSha1(data) {
  const buffer = typeof data === 'object' ? JSON.stringify(data) : data;
  return CryptoJS.SHA1(buffer).toString(CryptoJS.enc.Hex);
}

/**
 * AES 加密
 * @param {BufferLike} data 需要加密的数据
 * @param {{ key?:string, iv?: string } | undefined} opt
 * @returns {AesEncrypt | string}
 */
function cryptoAesEncrypt(data, opt) {
  if (typeof data === 'object') data = JSON.stringify(data);
  const buffer = normalizeBuffer(data);
  let key;
  let iv;
  let tempKey = '';

  if (opt?.key && opt?.iv) {
    key = opt.key;
    iv = opt.iv;
  } else {
    tempKey = opt?.key || randomString(16).toLowerCase();
    key = cryptoMd5(tempKey).substring(0, 32);
    iv = key.substring(key.length - 16);
  }

  const encrypted = CryptoJS.AES.encrypt(wordArrayFromBuffer(buffer), utf8WordArray(key), {
    iv: utf8WordArray(iv),
    mode: CryptoJS.mode.CBC,
    padding: CryptoJS.pad.Pkcs7,
  });

  const hex = CryptoJS.enc.Hex.stringify(encrypted.ciphertext);
  if (opt?.key && opt?.key) return hex;
  return { str: hex, key: tempKey };
}

/**
 * AES 解密
 * @param {string} data
 * @param {string} key
 * @param {string?} iv
 * @returns {string | Record<string, string>}
 */
function cryptoAesDecrypt(data, key, iv) {
  if (!iv) key = cryptoMd5(key).substring(0, 32);
  iv = iv || key.substring(key.length - 16);
  const cipherParams = CryptoJS.lib.CipherParams.create({ ciphertext: CryptoJS.enc.Hex.parse(data) });

  const decrypted = CryptoJS.AES.decrypt(cipherParams, utf8WordArray(key), {
    iv: utf8WordArray(iv),
    mode: CryptoJS.mode.CBC,
    padding: CryptoJS.pad.Pkcs7,
  });

  const text = decodeUtf8(wordArrayToBuffer(decrypted));
  try {
    return JSON.parse(text);
  } catch (e) {
    return text;
  }
}

/**
 * RSA加密（无填充 RSA，供 login/user 系接口的 pk/p 参数使用）
 * @param {BufferLike} data
 * @param {string?} publicKey
 * @returns {string} hex
 */
function cryptoRSAEncrypt(data, publicKey) {
  const isLite = process.env.platform === 'lite';
  const buffer = normalizeBuffer(data);
  const pem = publicKey || (isLite ? publicLiteRasKey : publicRasKey);
  return rsaRawEncrypt(buffer, getPublicKey(pem));
}

function rsaEncrypt2(data) {
  const isLite = process.env.platform === 'lite';
  const buffer = Buffer.from(normalizeBuffer(data));
  const key = getPublicKey(isLite ? publicLiteRasKey : publicRasKey);
  return nodeCrypto.publicEncrypt({ key, padding: nodeCrypto.constants.RSA_PKCS1_PADDING }, buffer).toString('hex');
}

function playlistAesEncrypt(data) {
  const useData = typeof data === 'object' ? JSON.stringify(data) : data;
  const key = randomString(6).toLowerCase();
  const encryptKey = cryptoMd5(key).substring(0, 16);
  const iv = cryptoMd5(key).substring(16, 32);

  const encrypted = CryptoJS.AES.encrypt(CryptoJS.enc.Utf8.parse(useData), utf8WordArray(encryptKey), {
    iv: utf8WordArray(iv),
    mode: CryptoJS.mode.CBC,
    padding: CryptoJS.pad.Pkcs7,
  });

  return { key, str: CryptoJS.enc.Base64.stringify(encrypted.ciphertext) };
}

function playlistAesDecrypt(data) {
  const encryptKey = cryptoMd5(data.key).substring(0, 16);
  const iv = cryptoMd5(data.key).substring(16, 32);

  const cipherParams = CryptoJS.lib.CipherParams.create({ ciphertext: CryptoJS.enc.Base64.parse(data.str) });
  const decrypted = CryptoJS.AES.decrypt(cipherParams, utf8WordArray(encryptKey), {
    iv: utf8WordArray(iv),
    mode: CryptoJS.mode.CBC,
    padding: CryptoJS.pad.Pkcs7,
  });

  const text = decodeUtf8(wordArrayToBuffer(decrypted));
  try {
    return JSON.parse(text);
  } catch (e) {
    return text;
  }
}

module.exports = {
  cryptoAesDecrypt,
  cryptoAesEncrypt,
  cryptoMd5,
  cryptoRSAEncrypt,
  rsaEncrypt2,
  cryptoSha1,
  playlistAesEncrypt,
  playlistAesDecrypt,
  publicLiteRasKey,
  publicRasKey,
  wordArrayFromBuffer,
};
