const { apiver, appid, wx_appid, wx_lite_appid, wx_secret, wx_lite_secret, srcappid, clientver, liteAppid, liteClientver, qq_appid, qq_lite_appid } = require('./config.json');
const {
  cryptoAesDecrypt,
  cryptoAesEncrypt,
  cryptoMd5,
  cryptoRSAEncrypt,
  cryptoSha1,
  rsaEncrypt2,
  playlistAesEncrypt,
  playlistAesDecrypt,
  publicLiteRasKey,
  publicRasKey,
} = require('./crypto');
const { createRequest, createCloudRequest } = require('./request');
const { resolveProxy } = require('./runtime');
const { signKey, signParams, signParamsKey, signCloudKey, signatureAndroidParams, signatureRegisterParams, signatureWebParams } = require('./helper');
const { randomString, decodeLyrics, parseCookieString, cookieToJson, randomNumber, calculateMid, isUUIDv4 } = require('./util');

// 判断是否为概念版
const isLite = process.env.platform === 'lite';
const useAppid = isLite ? liteAppid : appid;
const useClientver = isLite ? liteClientver : clientver;

module.exports = {
  apiver,
  appid: useAppid,
  // liteAppid,
  // liteClientver,
  wx_appid,
  wx_lite_appid,
  wx_secret,
  wx_lite_secret,
  qq_appid,
  qq_lite_appid,
  srcappid,
  clientver: useClientver,
  isLite,
  cryptoAesDecrypt,
  cryptoAesEncrypt,
  cryptoMd5,
  cryptoRSAEncrypt,
  cryptoSha1,
  rsaEncrypt2,
  playlistAesEncrypt,
  playlistAesDecrypt,
  createRequest,
  createCloudRequest,
  resolveProxy,
  signKey,
  signParams,
  signParamsKey,
  signCloudKey,
  signatureAndroidParams,
  signatureRegisterParams,
  signatureWebParams,
  randomString,
  decodeLyrics,
  parseCookieString,
  cookieToJson,
  publicLiteRasKey,
  publicRasKey,
  randomNumber,
  calculateMid,
  isUUIDv4
};
