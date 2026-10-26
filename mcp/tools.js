/**
 * @fileoverview MCP 工具注册表
 *
 * 面向智能音乐助手 Agent 的工具集，分组：
 * - 登录：酷狗 App 扫码 / 微信扫码 / 概念版微信扫码（kugou_login_concept）/ 登录态查询 / 退出
 * - 概念版 VIP：签到领取（kugou_sign_in）、VIP 状态查询（kugou_vip_status）
 * - 搜索：歌曲 / 歌词 / MV / 专辑 / 歌手 / 热搜 / 联想建议
 * - 排行榜：全部榜单索引、单榜完整歌曲
 * - 歌曲：播放/下载直链（概念版登录后自动走概念版通道，解锁概念版 VIP）、音质与版权信息、歌词获取、相似歌曲
 * - 评论：歌曲评论读取与发表
 * - 歌单：我的歌单、歌单歌曲、收藏/取消收藏、增删歌曲、新建/删除歌单、详情/改名/排序
 * - 云盘：云盘歌曲列表、云盘音乐直链、删除、上传（本地路径/base64）、上传前曲库匹配
 * - MV：播放地址、收藏管理
 * - 歌手/专辑：资料、歌曲列表、关注管理
 * - 下载：音频文件、歌词文件保存到本地
 * - 推荐：每日推荐、私人 FM
 * - 个人数据：听歌排行、已购单曲/专辑（需登录）
 *
 * 所有工具基于项目编程式 API（main.js 导出的模块函数）进程内调用，
 * 会话（设备指纹 + 登录态）由 session.js 统一管理并持久化。
 * 概念版（lite）身份的调用经 lite.js 转发：概念版 VIP 只对概念版
 * appid + 概念版 token 生效，与标准版 token 互不兼容。
 */

const fs = require('node:fs');
const path = require('node:path');
const axios = require('axios');
const qrcode = require('qrcode');

const z = require('zod');
const { session } = require('./session');
const { makeCaller } = require('./call');
const { callLite, liteStatus, liteLogout } = require('./lite');

// ============================================================
// 基础调用与裁剪工具
// ============================================================

/**
 * 调用一个 API 模块函数（标准版会话），自动注入会话 cookie 并回收响应 cookie
 * @param {string} fn 模块名（module/ 下文件名去掉 .js）
 * @param {Object} params 业务参数
 * @param {Object} [options] { requireLogin: boolean }
 * @returns {Promise<any>} 响应 body
 */
const call = makeCaller(session);

/**
 * 概念版是否已登录（查询失败按未登录处理，不影响标准版流程）
 */
const conceptLoggedIn = async () => {
  try {
    return Boolean((await liteStatus()).logged_in);
  } catch (e) {
    return false;
  }
};

const text = (obj) => ({
  content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) }],
  ...(typeof obj !== 'string' ? { structuredContent: obj } : {}),
});

/** 从搜索结果裁剪歌曲要点 */
const trimSearchSong = (s) => ({
  name: s.OriSongName || s.SongName || s.FileName,
  singer: s.SingerName,
  album: s.AlbumName,
  album_id: s.AlbumID,
  hash: s.FileHash,
  mixsongid: s.MixSongID,
  album_audio_id: s.Audioid || s.MixSongID,
  duration_sec: s.Duration,
  ext: s.ExtName,
  size_128: s.FileSize,
  size_320: s.HQFileSize,
  size_flac: s.SQFileSize,
  pay_type: s.PayType,
  privilege: s.Privilege,
  vip: (s.Privilege && s.Privilege > 0) || (s.PayType && s.PayType > 0) ? true : false,
});

const trimSearchAlbum = (a) => ({ album_id: a.AlbumID, name: a.AlbumName, singer: a.SingerName, publish: a.PublishDate, songs: a.SongCount });

const trimSearchArtist = (a) => ({ artist_id: a.ID || a.ArtistID, name: a.SingerName || a.Name, songs: a.SongCount, albums: a.AlbumCount, fans: a.FansCount });

const trimSearchMv = (m) => ({
  mv_id: m.MvID,
  name: m.MvName || m.FileName,
  singer: m.SingerName,
  hash: m.MvHash || m.FileHash,
  duration_sec: m.Duration,
  publish: m.PublishDate,
});

/**
 * 从 playlist_track_all_new 响应中提取歌曲数组
 * /v4/get_list_all_file_v3 歌曲在 data.info（旧端点为 data.lists），空歌单时 info 为 null
 */
const playlistTrackLists = (body) => {
  const data = body?.data || body;
  return data?.info || data?.lists || data?.list || [];
};

/** 从歌单歌曲列表裁剪要点（兼容 v3 新旧端点字段名） */
const trimPlaylistSong = (s) => {
  const item = {
    fileid: s.fileid ?? s.FileID ?? s.id,
    name: String(s.filename || s.name || s.FileName || s.audio_name || '').replace(/\.(mp3|flac|ape|m4a|ogg|wav)$/i, ''),
    singer:
      s.singername ||
      s.SingerName ||
      (Array.isArray(s.singerinfo) ? s.singerinfo.map((x) => x.name).join('/') : undefined) ||
      (Array.isArray(s.singers) ? s.singers.map((x) => x.name).join('/') : undefined),
    hash: s.hash || s.FileHash,
    album_id: s.album_id || s.AlbumID,
    mixsongid: s.mixsongid ?? s.songid ?? s.SongID,
    duration_sec: s.timelen ? Math.floor(s.timelen / 1000) : s.duration,
  };
  return Object.fromEntries(Object.entries(item).filter(([, v]) => v !== undefined));
};

/**
 * 从 user_playlist 响应中提取歌单数组
 * /v7/get_all_list 响应已改版：歌单在 data.info（旧版为 data.lists），字段同步变化
 * （listid 仍在，默认收藏夹标记 special_flag → is_def：2=我喜欢 / 1=旧版默认收藏）
 */
const playlistLists = (body) => body?.data?.info || body?.data?.lists || body?.lists || [];

/** 分页拉取歌单全部歌曲（v3 单页上限 300），供按 hash/mixsongid 定位 fileid 的工具使用 */
const fetchAllPlaylistTracks = async (listid) => {
  let tracks = [];
  let page = 1;
  let total = Infinity;
  while (tracks.length < total) {
    const body = await call('playlist_track_all_new', { listid, page, pagesize: 300 }, { requireLogin: true });
    const batch = playlistTrackLists(body);
    if (!batch.length) break;
    tracks = tracks.concat(batch);
    const data = body?.data || body;
    total = Number(data?.count ?? data?.total ?? tracks.length) || tracks.length;
    page++;
  }
  return tracks;
};

/** 从歌单列表裁剪要点 */
const trimPlaylist = (l) => ({
  listid: l.listid ?? l.list_create_listid,
  name: l.name,
  count: l.count,
  type: l.type, // 0 自建 / 1 收藏
  is_def: l.is_def, // 2 新版默认收藏夹“我喜欢” / 1 旧版“默认收藏”
  special_flag: l.special_flag ?? (l.is_def ? 1 : undefined), // 默认收藏夹标记（兼容旧字段语义）
  global_collection_id: l.global_collection_id, // 歌单详情接口（playlist_detail）所需的全局集合 id
  pic: l.pic ? String(l.pic).replace('{size}', '240') : undefined,
  create_time: l.create_time,
});

/** 在用户歌单中定位默认收藏夹 */
const findFavoriteList = (lists = []) => {
  return (
    lists.find((l) => Number(l.is_def) === 2) || // “我喜欢”（新版默认收藏夹）
    lists.find((l) => Number(l.special_flag) === 1) ||
    lists.find((l) => Number(l.is_def) === 1) || // 旧版“默认收藏”
    lists.find((l) => /我喜欢|默认收藏|我收藏/.test(String(l.name || '')) && Number(l.type) === 0) ||
    null
  );
};

/**
 * 从 user_cloud 响应中提取云盘歌曲数组
 * mcloudservice /v1/get_list 响应经 AES 解密，列表字段名多变（list/info/lists），做兼容提取
 */
const cloudLists = (body) => body?.data?.list || body?.data?.info || body?.data?.lists || body?.list || [];

/** 从云盘歌曲列表裁剪要点（kv_id 为删除所需文件 ID，hash 为取直链所需） */
const trimCloudSong = (s) => {
  const item = {
    fileid: s.kv_id ?? s.kvId ?? s.fileid ?? s.id,
    name: s.name || s.filename || s.audio_name,
    singer: s.author_name || s.singer_name || s.singername,
    hash: s.hash || s.hash_std,
    hash_std: s.hash_std,
    audio_id: s.audio_id,
    album_audio_id: s.album_audio_id,
    ext: s.ext || s.extendname,
    size: s.size ?? s.filesize,
    duration_sec: s.timelen ? Math.floor(s.timelen / 1000) : s.duration,
    bitrate: s.bitrate,
  };
  return Object.fromEntries(Object.entries(item).filter(([, v]) => v !== undefined));
};

/**
 * 从 kmr 系接口（rank_audio 完整榜单歌曲 / audio_related 相似歌曲）裁剪要点
 * 这类接口歌曲信息分散在 base / audio_info / authors 子对象中；
 * rank_audio 的 audio_info 无通用 hash，只有分音质 hash_128/320/flac
 */
const trimKmrSong = (s) => {
  const b = s.base || s;
  const a = s.audio_info || {};
  const item = {
    name: b.songname || b.audio_name || s.filename,
    singer: b.author_name || (Array.isArray(s.authors) ? s.authors.map((x) => x.author_name).join('/') : undefined),
    album: b.album_name || s.album_info?.album_name,
    album_id: b.album_id,
    album_audio_id: b.album_audio_id,
    audio_id: b.audio_id ?? a.audio_id,
    hash: a.hash || a.hash_128 || s.hash,
    hash_320: a.hash_320,
    hash_flac: a.hash_flac,
    duration_sec: a.duration ? Math.floor(a.duration / 1000) : a.duration_128 ? Math.floor(a.duration_128 / 1000) : s.timelen ? Math.floor(s.timelen / 1000) : undefined,
    mv_hash: Array.isArray(s.mvdata) && s.mvdata[0] ? s.mvdata[0].hash : undefined,
  };
  return Object.fromEntries(Object.entries(item).filter(([, v]) => v !== undefined));
};

/** 排行榜列表项裁剪（songinfo 仅为每榜 3 首预览，完整榜单用 rank_audio） */
const trimRank = (r) => ({
  rankid: r.rankid,
  name: r.rankname,
  classify: r.classify,
  intro: (r.intro || '').slice(0, 60),
  update_frequency: r.update_frequency,
  play_times: r.play_times,
  cover: r.imgurl ? String(r.imgurl).replace('{size}', '240') : undefined,
  preview: (r.songinfo || []).slice(0, 3).map((s) => ({
    name: s.songname || s.SongName,
    singer: s.author || s.author_name || s.SingerName,
    album_audio_id: s.album_audio_id,
  })),
});

/** 从歌曲评论列表裁剪要点（评论在响应顶层 list，总数在 count；like 是 {likenum,...} 对象） */
const trimComment = (c) => {
  const item = {
    id: c.id,
    user: c.user_name,
    content: c.content,
    time: c.addtime,
    likes: typeof c.like === 'object' && c.like ? c.like.likenum ?? c.like.count : c.like,
    replies: c.reply_num,
    location: c.location,
  };
  return Object.fromEntries(Object.entries(item).filter(([, v]) => v !== undefined));
};

/** 从听歌排行（user_history）裁剪要点（pc=播放次数，ot=最后播放时间戳） */
const trimHistorySong = (h) => {
  const info = h.info || {};
  const item = {
    play_count: h.pc,
    last_play: h.ot ? new Date(h.ot * 1000).toISOString().slice(0, 10) : undefined,
    name: info.name,
    singer: info.singername,
    hash: info.hash,
    mixsongid: info.mixsongid ?? h.mxid,
    album_id: info.album_id,
    duration_sec: info.timelen ? Math.floor(info.timelen / 1000) : undefined,
  };
  return Object.fromEntries(Object.entries(item).filter(([, v]) => v !== undefined));
};

/** 从已购列表（data.goods）裁剪要点，单曲与专辑共用 */
const trimPurchased = (g) => {
  const item = {
    name: g.songname || g.albumname || g.name,
    singer: g.author_name,
    album_audio_id: g.album_audio_id,
    album_id: g.album_id,
    hash: g.hash,
    global_collection_id: g.global_collection_id,
    cover: g.album_cover ? String(g.album_cover).replace('{size}', '240') : undefined,
  };
  return Object.fromEntries(Object.entries(item).filter(([, v]) => v !== undefined));
};

/**
 * 概念版 union VIP（/v1/get_union_vip）响应摘要
 * 概念版 VIP 是业务线隔离会员：账号级 is_vip/vip_type 不体现，须看 busi_vip
 * 中 busi_type=concept 的条目（svip=音乐会员、tvip=听书会员等）
 */
const conceptVipSummary = (body) => {
  const d = body?.data || {};
  const busi = Array.isArray(d.busi_vip) ? d.busi_vip.filter((b) => b.busi_type === 'concept') : [];
  return {
    account_is_vip: d.is_vip,
    vip_type: d.vip_type,
    concept: busi.map((b) => ({
      product_type: b.product_type,
      is_vip: b.is_vip,
      begin_time: b.vip_begin_time,
      end_time: b.vip_end_time,
      daily_quota: b.vip_limit_quota?.total,
    })),
  };
};

const QUALITY_RANK = ['128', '192', '256', '320', 'flac', 'flac24bit', 'high', 'super', 'viper_clear', 'viper_tape', 'viper_atmos', 'multitrack'];
const qualityIndex = (q) => {
  const i = QUALITY_RANK.indexOf(String(q));
  return i === -1 ? 0 : i;
};

/**
 * 归一化歌曲直链响应：
 * - /v5/url（song_url）：{ status, url: [直链...], backupUrl, extName, fileSize, timeLength, priv_status, hash_offset }
 * - /v6/priv_url（song_url_new）：{ urls: [{quality, url, ...}] }（保留兼容）
 */
const normalizeSongUrls = (body, quality) => {
  const urls = [];
  if (Array.isArray(body?.urls)) {
    for (const u of body.urls) {
      if (!u?.url) continue;
      urls.push({
        quality: u.quality || String(u.bitrate || ''),
        bitrate: u.bitrate,
        size: u.filesize || u.size,
        ext: u.ext || String(u.url).split('.').pop().split('?')[0],
        url: u.url,
        backup_urls: u.back_url ? [u.back_url] : u.backupUrls || [],
        free_trial_start: u.start_ms,
        free_trial_end: u.end_ms,
      });
    }
  }
  const mainUrls = (Array.isArray(body?.url) ? body.url : []).filter(Boolean);
  if (mainUrls.length) {
    urls.push({
      quality: String(quality || body?.extName || ''),
      bitrate: body?.bitRate,
      size: body?.fileSize,
      ext: body?.extName || String(mainUrls[0]).split('.').pop().split('?')[0],
      url: mainUrls[0],
      backup_urls: [...mainUrls.slice(1), ...(Array.isArray(body?.backupUrl) ? body.backupUrl : [])],
    });
  }
  return urls;
};

/**
 * 获取歌曲直链（多通道）：
 * 概念版 VIP 只对概念版身份（appid=3116 + 概念版 token）生效，因此概念版
 * 已登录时优先走概念版通道（可解锁概念版 VIP 曲目），失败再回退标准版。
 * @returns {Promise<{body: any, identity: 'concept' | 'standard'}>}
 */
const fetchSongUrl = async (p) => {
  if (await conceptLoggedIn()) {
    try {
      const body = await callLite('song_url', p);
      const hasUrl = (Array.isArray(body?.url) && body.url.length) || (Array.isArray(body?.urls) && body.urls.length);
      if (hasUrl || body?.status === 1) return { body, identity: 'concept' };
    } catch (e) {
      // 概念版通道失败（风控/参数等），回退标准版
    }
  }
  let body;
  try {
    body = await call('song_url', p);
  } catch (e) {
    // song_url 走 trackercdn，风控/失败时回退新版 priv_url 通道
    body = await call('song_url_new', { hash: p.hash, album_audio_id: p.album_audio_id, free_part: p.free_part });
  }
  return { body, identity: 'standard' };
};

/** 清洗文件名中的非法字符 */
const safeFilename = (name) => String(name || 'kugou_download').replace(/[\\/:*?"<>|\r\n]+/g, '_').slice(0, 120);

// ============================================================
// 工具注册
// ============================================================

/**
 * 在 McpServer 实例上注册全部酷狗音乐工具
 * @param {import('@modelcontextprotocol/sdk/server/mcp.js').McpServer} server
 */
function registerTools(server) {
  // ----------------------------------------------------------
  // 登录组
  // ----------------------------------------------------------

  server.registerTool(
    'kugou_login_qr',
    {
      title: '酷狗 App 扫码登录',
      description: '生成酷狗 App 扫码登录二维码。返回终端可显示的 ASCII 二维码与 qrcode key。用户用酷狗 App 扫码后，调用 kugou_login_qr_check（传 key）轮询确认，登录态自动保存。',
      inputSchema: {},
    },
    async () => {
      const body = await call('login_qr_key', {});
      const key = body?.data?.qrcode || body?.data?.qrcode_txt || body?.qrcode;
      if (!key) throw new Error(`未获取到二维码 key：${JSON.stringify(body).slice(0, 200)}`);
      const loginUrl = `https://h5.kugou.com/apps/loginQRCode/html/index.html?qrcode=${key}`;
      const ascii = await qrcode.toString(loginUrl, { type: 'terminal', small: true, margin: 1 });
      return text({
        key,
        login_url: loginUrl,
        qrcode_base64: body?.data?.qrcode_img || '',
        instruction: '请用酷狗 App 扫描二维码（ASCII 二维码如下，或在浏览器打开 login_url 出示二维码），然后调用 kugou_login_qr_check 传入 key 查询状态。',
        ascii_qrcode: '\n' + ascii,
      });
    }
  );

  server.registerTool(
    'kugou_login_qr_check',
    {
      title: '查询扫码登录状态',
      description: '轮询酷狗扫码登录状态。status: 1=待扫码, 2=已扫码待确认, 4=登录成功（自动保存会话）, 0=二维码过期。',
      inputSchema: { key: z.string().describe('kugou_login_qr 返回的 qrcode key') },
    },
    async ({ key }) => {
      const body = await call('login_qr_check', { key });
      const status = body?.data?.status;
      const map = { 0: '二维码已过期，请重新调用 kugou_login_qr', 1: '等待扫码', 2: '已扫码，等待用户在 App 上确认', 4: '登录成功' };
      const out = { status, status_text: map[status] || '未知状态', logged_in: session.isLoggedIn() };
      if (status === 4) {
        out.userid = body?.data?.userid;
        out.nickname = body?.data?.nickname || body?.data?.user_name;
      }
      return text(out);
    }
  );

  server.registerTool(
    'kugou_login_wx',
    {
      title: '微信扫码登录',
      description: '生成微信扫码登录二维码（走酷狗开放平台）。返回微信确认页 URL 与 uuid，用户微信扫码确认后调用 kugou_login_wx_check（传 uuid）。注意：依赖项目内置的微信开放平台 appid/secret，若微信侧报错请改用 kugou_login_qr。',
      inputSchema: {},
    },
    async () => {
      const body = await call('login_wx_create', {});
      const uuid = body?.uuid || body?.data?.uuid;
      const qr = body?.qrcode || body?.data?.qrcode || {};
      if (!uuid) throw new Error(`未获取到微信二维码 uuid：${JSON.stringify(body).slice(0, 200)}`);
      const qrcodeurl = qr.qrcodeurl || `https://open.weixin.qq.com/connect/confirm?uuid=${uuid}`;
      let ascii = '';
      try {
        ascii = await qrcode.toString(qrcodeurl, { type: 'terminal', small: true, margin: 1 });
      } catch (e) {
        // ASCII 生成失败不影响主流程
      }
      return text({ uuid, qrcodeurl, qrcode_image: qr.qrcode || '', instruction: '请在微信中扫描/打开确认页并授权，然后调用 kugou_login_wx_check 传入 uuid。', ascii_qrcode: ascii ? '\n' + ascii : '' });
    }
  );

  server.registerTool(
    'kugou_login_wx_check',
    {
      title: '查询微信扫码状态并完成登录',
      description: '轮询微信扫码状态；当微信返回 wx_code（用户已授权）时自动调用酷狗开放平台登录换取 token 并保存会话。',
      inputSchema: { uuid: z.string().describe('kugou_login_wx 返回的 uuid') },
    },
    async ({ uuid }) => {
      const body = await call('login_wx_check', { uuid });
      const wxCode = body?.wx_code;
      const out = { wx_code: wxCode, wx_errcode: body?.wx_errcode, logged_in: session.isLoggedIn() };
      if (wxCode && !session.isLoggedIn()) {
        // wx_code 即微信授权 code，换取酷狗登录态
        try {
          const loginBody = await call('login_openplat', { code: wxCode });
          out.kugou_login = loginBody?.status === 1 ? '成功' : `失败: ${JSON.stringify(loginBody).slice(0, 150)}`;
          out.userid = loginBody?.data?.userid;
        } catch (e) {
          out.kugou_login = `失败: ${String(e.message).slice(0, 150)}`;
        }
      }
      out.logged_in = session.isLoggedIn();
      out.instruction = out.logged_in ? '登录完成，可调用 kugou_login_status 查看用户信息。' : '尚未授权，请提示用户在微信中确认后再次调用本工具。';
      return text(out);
    }
  );

  server.registerTool(
    'kugou_login_concept',
    {
      title: '概念版微信扫码登录',
      description:
        '生成概念版（酷狗概念版 appid=3116）微信扫码二维码。概念版 VIP（签到/听歌任务获得）只对概念版身份生效，标准版登录无法使用其下载权限，因此需要单独登录概念版。扫码确认后调用 kugou_login_concept_check（传 uuid）完成登录；登录后签到、歌曲直链/下载工具自动走概念版通道。',
      inputSchema: {},
    },
    async () => {
      const body = await callLite('login_wx_create', {});
      const uuid = body?.uuid || body?.data?.uuid;
      const qr = body?.qrcode || body?.data?.qrcode || {};
      if (!uuid) throw new Error(`未获取到概念版微信二维码 uuid：${JSON.stringify(body).slice(0, 200)}`);
      const qrcodeurl = qr.qrcodeurl || `https://open.weixin.qq.com/connect/confirm?uuid=${uuid}`;
      let ascii = '';
      try {
        ascii = await qrcode.toString(qrcodeurl, { type: 'terminal', small: true, margin: 1 });
      } catch (e) {
        // ASCII 生成失败不影响主流程
      }
      return text({
        uuid,
        qrcodeurl,
        qrcode_image: qr.qrcode || '',
        instruction: '请用微信扫描二维码并确认授权（须为绑定了酷狗账号的微信），然后调用 kugou_login_concept_check 传入 uuid。',
        ascii_qrcode: ascii ? '\n' + ascii : '',
      });
    }
  );

  server.registerTool(
    'kugou_login_concept_check',
    {
      title: '查询概念版微信扫码状态并完成登录',
      description: '轮询概念版微信扫码状态；微信返回 wx_code（用户已授权）时自动换取概念版登录态并保存（独立于标准版会话）。',
      inputSchema: { uuid: z.string().describe('kugou_login_concept 返回的 uuid') },
    },
    async ({ uuid }) => {
      const body = await callLite('login_wx_check', { uuid });
      const wxCode = body?.wx_code;
      const out = { wx_code: Boolean(wxCode), wx_errcode: body?.wx_errcode };
      if (wxCode) {
        const login = await callLite('login_openplat', { code: wxCode });
        out.kugou_login = login?.status === 1 ? '成功' : `异常: ${JSON.stringify(login).slice(0, 150)}`;
        out.userid = login?.data?.userid;
      }
      const st = await liteStatus();
      out.concept_logged_in = st.logged_in;
      out.instruction = st.logged_in
        ? '概念版登录完成：可调用 kugou_sign_in 签到领取 VIP；歌曲直链/下载将自动走概念版通道（可用 kugou_get_song_url 验证 priv_status=1）。'
        : '尚未授权，请提示用户在微信中确认后再次调用本工具。';
      return text(out);
    }
  );

  server.registerTool(
    'kugou_login_status',
    {
      title: '查询登录状态',
      description: '返回当前会话登录状态与用户资料（昵称、VIP 等）。未登录时给出登录指引。',
      inputSchema: {},
    },
    async () => {
      if (!session.isLoggedIn()) {
        return text({
          logged_in: false,
          hint: '当前未登录。请调用 kugou_login_qr（酷狗 App 扫码）或 kugou_login_wx（微信扫码）发起登录；概念版 VIP 签到与下载请另外调用 kugou_login_concept 登录概念版。',
        });
      }
      const body = await call('user_detail', {}, { requireLogin: true });
      const d = body?.data || body;
      const out = {
        logged_in: true,
        userid: session.cookie.userid,
        nickname: d?.nickname || d?.nick_name || d?.nick,
        vip_type: d?.vip_type ?? session.cookie.vip_type,
        // 常见资料字段
        gender: d?.gender,
        birthday: d?.birthday,
        fans: d?.fans,
        follows: d?.follows ?? d?.follow,
        listen_songs: d?.listen_num ?? d?.play_count,
        raw: d,
      };
      // 概念版登录态与业务 VIP 摘要（概念版 VIP 不体现在账号 vip_type 里）
      try {
        const st = await liteStatus();
        out.concept = { logged_in: st.logged_in, userid: st.userid || undefined };
        if (st.logged_in) {
          try {
            out.concept.vip = conceptVipSummary(await callLite('youth_union_vip', {}));
          } catch (e) {
            out.concept.vip_error = String(e.message).slice(0, 150);
          }
        } else {
          out.concept.hint = '概念版未登录：概念版 VIP（kugou_sign_in 可领取）仅概念版通道可享用，请调用 kugou_login_concept 微信扫码登录。';
        }
      } catch (e) {
        out.concept = { error: String(e.message).slice(0, 150) };
      }
      return text(out);
    }
  );

  server.registerTool(
    'kugou_logout',
    {
      title: '退出登录',
      description: '清除本地保存的登录态（含标准版与概念版的 token/userid），保留设备标识。再次使用收藏/VIP下载等能力需重新扫码。',
      inputSchema: {},
    },
    async () => {
      session.logout();
      try {
        await liteLogout();
      } catch (e) {
        // 概念版工作进程不可用时忽略，不影响标准版退出
      }
      return text({ logged_in: false, concept_logged_in: false, message: '已退出标准版与概念版登录（设备标识保留）。' });
    }
  );

  // ----------------------------------------------------------
  // 概念版 VIP 组（签到 / 状态）
  // ----------------------------------------------------------

  server.registerTool(
    'kugou_sign_in',
    {
      title: '概念版签到领取VIP',
      description:
        '在概念版通道执行每日签到领 VIP：上报看广告任务（每次 +3 小时）→ 领取当日听歌 VIP → 领取升级奖励（当日 VIP 升为 24 小时）。领取的概念版 VIP 仅概念版通道可用（本服务的歌曲直链/下载工具在概念版登录后自动走该通道）。需先 kugou_login_concept 登录。当日已在手机端领取时对应步骤会返回「今日已领取」，不影响其余步骤。',
      inputSchema: {
        ad_times: z.number().int().min(0).max(8).optional().describe('看广告任务上报次数，默认 1（每日上限 8 次，每次 +3 小时 VIP）'),
        claim: z.boolean().optional().describe('是否领取当日 VIP 与升级奖励，默认 true'),
      },
    },
    async (p) => {
      const st = await liteStatus();
      if (!st.logged_in) throw new Error('概念版未登录：请先调用 kugou_login_concept 生成微信二维码并扫码登录。');
      const out = { ad_reports: [], claim: null, upgrade: null };

      // 1. 看广告任务上报（每次 +3h VIP，全部完成后自动跳过）
      const adTimes = p.ad_times ?? 1;
      for (let i = 0; i < adTimes; i++) {
        try {
          const r = await callLite('youth_vip', {});
          const d = r?.data || r;
          out.ad_reports.push(d);
          if (d && Number(d.total) && Number(d.done) >= Number(d.total)) {
            out.ad_task_all_done = true;
            break;
          }
        } catch (e) {
          out.ad_reports.push({ error: String(e.message).slice(0, 150) });
          break;
        }
      }

      // 2/3. 领取当日 VIP 与升级奖励（按北京时间自然日）
      if (p.claim !== false) {
        const today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
        try {
          const r = await callLite('youth_day_vip', { receive_day: today });
          out.claim = { success: true, day: today, response: r?.data || r };
        } catch (e) {
          out.claim = {
            success: false,
            day: today,
            error_code: e.code,
            message: e.code === 131001 ? '今日已领取过 VIP（可能已在手机端领取）' : String(e.message).slice(0, 150),
          };
        }
        try {
          const r = await callLite('youth_day_vip_upgrade', {});
          out.upgrade = { success: true, response: r?.data || r };
        } catch (e) {
          out.upgrade = {
            success: false,
            error_code: e.code,
            message: e.code === 297002 ? '今日已领取过升级奖励' : String(e.message).slice(0, 150),
          };
        }
      }

      // 4. 领取后最新 VIP 概况
      try {
        out.vip = conceptVipSummary(await callLite('youth_union_vip', {}));
      } catch (e) {
        out.vip = { error: String(e.message).slice(0, 150) };
      }
      return text(out);
    }
  );

  server.registerTool(
    'kugou_vip_status',
    {
      title: '查询概念版VIP状态',
      description: '查询概念版业务 VIP（svip/tvip 等）有效期、每日下载额度、今日是否已领取及近 7 天领取记录。概念版 VIP 由签到/听歌任务获得，不体现在账号 vip_type 中，仅概念版通道可用。需概念版登录。',
      inputSchema: {},
    },
    async () => {
      const st = await liteStatus();
      const out = { concept_logged_in: st.logged_in, userid: st.userid || undefined };
      if (!st.logged_in) {
        out.hint = '概念版未登录，请先调用 kugou_login_concept 扫码登录。';
        return text(out);
      }
      out.vip = conceptVipSummary(await callLite('youth_union_vip', {}));
      try {
        const rec = await callLite('youth_month_vip_record', {});
        const list = rec?.data?.list || [];
        out.recent_records = list.slice(0, 7).map((r) => ({ day: r.day, received: Number(r.receive_vip) === 1, vip_type: r.vip_type }));
        const today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
        out.today_claimed = list.some((r) => r.day === today && Number(r.receive_vip) === 1);
      } catch (e) {
        out.recent_records_error = String(e.message).slice(0, 150);
      }
      return text(out);
    }
  );

  // ----------------------------------------------------------
  // 搜索组
  // ----------------------------------------------------------

  server.registerTool(
    'kugou_search',
    {
      title: '搜索音乐资源',
      description: '统一搜索入口。type=song 搜歌曲（默认，返回含 hash/专辑等播放所需信息）；type=mv 搜 MV；type=album 搜专辑；type=artist 搜歌手；type=lyric 按歌曲 hash 精确搜歌词候选。',
      inputSchema: {
        keywords: z.string().describe('搜索关键词（type=lyric 时可传歌名，但建议同时传 hash 提高命中率）'),
        type: z.enum(['song', 'mv', 'album', 'artist', 'lyric']).optional().describe('搜索类型，默认 song'),
        page: z.number().int().min(1).optional().describe('页码，默认 1'),
        pagesize: z.number().int().min(1).max(100).optional().describe('每页数量，默认 30'),
        hash: z.string().optional().describe('type=lyric 时的歌曲 hash'),
        duration: z.number().optional().describe('type=lyric 时的歌曲时长（秒），提高匹配精度'),
      },
    },
    async (p) => {
      const type = p.type || 'song';
      const page = p.page || 1;
      const pagesize = p.pagesize || 30;
      if (type === 'lyric') {
        const body = await call('search_lyric', { keywords: p.keywords, hash: p.hash, duration: p.duration });
        const cands = (body?.candidates || []).slice(0, pagesize).map((c) => ({
          id: c.id,
          accesskey: c.accesskey,
          song: c.song,
          singer: c.singer,
          source: c.product_from,
          duration_ms: c.duration,
          score: c.score,
        }));
        return text({ type, total: body?.candidates?.length || 0, candidates: cands, hint: '取候选的 id+accesskey 调用 kugou_get_lyric（也可直接传 hash 一步获取歌词）' });
      }
      const body = await call('search', { keywords: p.keywords, type: type === 'artist' ? 'author' : type, page, pagesize });
      const lists = body?.data?.lists || body?.lists || [];
      const trims = {
        song: (l) => ({ ...trimSearchSong(l), mixsongid: l.MixSongID, pay: l.PayType, vip_required: Number(l.Privilege || 0) > 0 || Number(l.PayType || 0) > 0 }),
        mv: trimSearchMv,
        album: trimSearchAlbum,
        artist: trimSearchArtist,
      };
      return text({ type, page, total: body?.data?.total, items: lists.map(trims[type] || ((x) => x)).slice(0, pagesize) });
    }
  );

  server.registerTool(
    'kugou_search_hot',
    {
      title: '热搜榜',
      description: '获取酷狗实时热搜关键词榜单。',
      inputSchema: {},
    },
    async () => {
      const body = await call('search_hot', {});
      const list = (body?.data?.list || [])[0] || {};
      const keywords = (list.keywords || []).map((k, i) => ({ rank: i + 1, keyword: k.keyword || k.name, hint: k.reason, icon: k.icon }));
      return text({ updated_at: body?.data?.timestamp, keywords });
    }
  );

  server.registerTool(
    'kugou_search_suggest',
    {
      title: '搜索联想建议',
      description: '输入部分关键词返回搜索建议（歌曲/歌手/MV/专辑）。注意参数名为 keywords。',
      inputSchema: {
        keywords: z.string().describe('输入中的关键词'),
        musicTipCount: z.number().int().optional().describe('歌曲建议数量，默认 10'),
        mvTipCount: z.number().int().optional().describe('MV 建议数量，默认 10'),
        albumTipCount: z.number().int().optional().describe('专辑建议数量，默认 10'),
      },
    },
    async (p) => {
      const body = await call('search_suggest', { keywords: p.keywords, musicTipCount: p.musicTipCount, mvTipCount: p.mvTipCount, albumTipCount: p.albumTipCount });
      // 响应为 [{RecordDatas: [{HintInfo, ...}]}] 结构，抽出各分类的建议词
      const groups = body?.data || [];
      const suggestions = {};
      for (const g of groups) {
        const records = (g.RecordDatas || []).map((r) => r.HintInfo || r.hint_info).filter(Boolean);
        if (records.length) suggestions[g.type || g.Type || 'tips'] = records;
      }
      return text({ keywords: p.keywords, suggestions });
    }
  );

  // ----------------------------------------------------------
  // 排行榜组
  // ----------------------------------------------------------

  server.registerTool(
    'kugou_get_rank_list',
    {
      title: '获取排行榜榜单',
      description: '获取酷狗全部排行榜索引（TOP500、飙升榜、华语/欧美/日韩新歌等约 50 个），每个榜单附前 3 首歌曲预览。取某榜完整歌曲请用 kugou_get_rank_songs（传 rankid）。',
      inputSchema: {},
    },
    async () => {
      const body = await call('rank_list', {});
      const ranks = body?.data?.info || body?.info || [];
      return text({ total: body?.data?.total ?? ranks.length, ranks: ranks.map(trimRank) });
    }
  );

  server.registerTool(
    'kugou_get_rank_songs',
    {
      title: '获取排行榜完整歌曲',
      description: '分页获取某个排行榜的完整歌曲列表（如 TOP500 共 500 首）。rankid 来自 kugou_get_rank_list。',
      inputSchema: {
        rankid: z.number().int().describe('榜单 id（kugou_get_rank_list 返回的 rankid，如 TOP500=8888）'),
        page: z.number().int().min(1).optional().describe('页码，默认 1'),
        pagesize: z.number().int().min(1).max(100).optional().describe('每页数量，默认 30'),
      },
    },
    async (p) => {
      const page = p.page || 1;
      const pagesize = p.pagesize || 30;
      const body = await call('rank_audio', { rankid: p.rankid, page, pagesize });
      const data = body?.data || body;
      const songs = data?.songlist || [];
      const total = Number(data?.total ?? body?.total ?? songs.length) || songs.length;
      const first = (page - 1) * pagesize + 1;
      return text({
        rankid: p.rankid,
        total,
        page,
        returned: songs.length,
        has_more: first + songs.length - 1 < total,
        songs: songs.map(trimKmrSong),
        hint: first + songs.length - 1 < total ? `共 ${total} 首，已返回第 ${page} 页，传 page=${page + 1} 继续翻页。` : undefined,
      });
    }
  );

  // ----------------------------------------------------------
  // 歌曲组
  // ----------------------------------------------------------

  server.registerTool(
    'kugou_get_song_url',
    {
      title: '获取歌曲播放/下载直链',
      description: '传入歌曲 hash（来自 kugou_search）获取直链。概念版已登录时自动走概念版通道（概念版 VIP 生效，可下载 VIP 歌曲，返回 identity=concept 与 priv_status=1）；否则走标准版通道，VIP 歌曲仅返回试听段或无直链。可指定 quality 期望音质（128/320/flac/high/viper_tape 等）。',
      inputSchema: {
        hash: z.string().describe('歌曲 hash（FileHash，大小写不敏感）'),
        album_id: z.number().optional().describe('专辑 id（提高命中率）'),
        album_audio_id: z.number().optional().describe('mixsongid/album_audio_id（提高命中率）'),
        quality: z.string().optional().describe('期望音质：128/320/flac/high/super/viper_tape/viper_clear/viper_atmos，或魔法音质 piano/acappella/subwoofer/ancient/dj，默认 128'),
        free_part: z.boolean().optional().describe('无权限时是否接受试听段，默认 false'),
      },
    },
    async (p) => {
      const { body, identity } = await fetchSongUrl(p);
      const urls = normalizeSongUrls(body, p.quality);
      // 排序：目标音质优先，其余按音质从高到低
      const targetQ = String(p.quality || '128').replace('magic_', '');
      urls.sort((a, b) => qualityIndex(b.quality) - qualityIndex(a.quality));
      urls.sort((a, b) => (b.quality === targetQ ? 1 : 0) - (a.quality === targetQ ? 1 : 0));
      const urlCount = urls.filter((u) => u.url).length;
      const out = {
        hash: p.hash,
        identity, // concept=概念版通道（概念版VIP生效）/ standard=标准版
        status: body?.status,
        priv_status: body?.priv_status, // 1 = 服务端已确认下载权限
        url_count: urlCount,
        urls,
        vip_hint:
          body?.status === 2 || urlCount === 0
            ? '未获取到可用直链：可能触发了风控（稍后重试）、或该曲为 VIP 歌曲且当前通道无会员权限。可调用 kugou_sign_in 签到领取概念版 VIP（需先 kugou_login_concept 登录概念版）。'
            : undefined,
        free_trial_hint: body?.is_free_part === 1 || Boolean(body?.hash_offset) && body?.status === 2 ? '当前返回的是试听片段（通常 60 秒内）' : undefined,
      };
      return text(out);
    }
  );

  server.registerTool(
    'kugou_get_song_info',
    {
      title: '查询歌曲音质与版权',
      description: '查询歌曲各音质的可用性、大小与所需会员类型（是否需要超级 VIP），用于判断能否下载无损/Hi-Res。',
      inputSchema: {
        hash: z.string().describe('歌曲 hash'),
        album_id: z.number().optional().describe('专辑 id'),
      },
    },
    async (p) => {
      const body = await call('privilege_lite', { hash: p.hash, album_id: p.album_id });
      const d = Array.isArray(body?.data) ? body.data[0] : body?.data;
      const qualities = d?.relate_goods || d?.qualities || [];
      return text({
        song: d ? { name: d.name || d.songname, singer: d.singername, album: d.albumname, album_id: d.album_id, album_audio_id: d.album_audio_id, hash: d.hash } : undefined,
        qualities: Array.isArray(qualities)
          ? qualities.map((q) => ({ quality: q.quality, level: q.level, privilege: q.privilege, status: q.status, size: q.size || q.filesize, need_vip: Number(q.privilege) !== 0 }))
          : qualities,
        raw_keys: d ? Object.keys(d) : [],
      });
    }
  );

  server.registerTool(
    'kugou_get_similar_songs',
    {
      title: '获取相似歌曲',
      description: '按歌曲找相似歌曲（“听完这首再来点类似的”）。传 album_audio_id（即搜索结果中的 album_audio_id/mixsongid）。',
      inputSchema: {
        album_audio_id: z.number().int().describe('歌曲 album_audio_id（kugou_search 结果的 album_audio_id 字段）'),
        page: z.number().int().min(1).optional().describe('页码，默认 1'),
        pagesize: z.number().int().min(1).max(100).optional().describe('每页数量，默认 30'),
        sort: z.enum(['all', 'hot', 'new']).optional().describe('排序：all 综合（默认）/ hot 热门 / new 最新'),
      },
    },
    async (p) => {
      const body = await call('audio_related', {
        album_audio_id: p.album_audio_id,
        page: p.page || 1,
        pagesize: p.pagesize || 30,
        sort: p.sort || 'all',
      });
      const songs = Array.isArray(body?.data) ? body.data : [];
      const total = Number(body?.total ?? songs.length) || songs.length;
      return text({ album_audio_id: p.album_audio_id, total, returned: songs.length, songs: songs.map(trimKmrSong) });
    }
  );

  server.registerTool(
    'kugou_get_lyric',
    {
      title: '获取歌词',
      description: '一步获取歌词：自动按 hash 搜索最优歌词候选并下载解码。默认返回带时间轴的 LRC 文本；fmt=krc 返回酷狗 KRC（逐字）格式。',
      inputSchema: {
        hash: z.string().describe('歌曲 hash'),
        duration: z.number().optional().describe('歌曲时长（秒），提高候选匹配精度'),
        fmt: z.enum(['lrc', 'krc']).optional().describe('返回格式，默认 lrc'),
      },
    },
    async (p) => {
      const searchBody = await call('search_lyric', { hash: p.hash, duration: p.duration, keywords: '' });
      const cand = (searchBody?.candidates || [])[0];
      if (!cand) return text({ found: false, hash: p.hash, message: '未找到歌词候选，可尝试补充 duration 或用其它 hash。' });
      const fmt = p.fmt || 'lrc';
      const body = await call('lyric', { id: cand.id, accesskey: cand.accesskey, fmt, decode: 1 });
      // decode=1 时 decodeContent 已是解码后的文本，直接使用
      const raw = body?.decodeContent || '';
      const lyricText = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
      return text({
        found: true,
        song: cand.song,
        singer: cand.singer,
        duration_ms: cand.duration,
        fmt,
        charset: body?.charset,
        lyric: String(lyricText).slice(0, 20000),
      });
    }
  );

  // ----------------------------------------------------------
  // 评论组
  // ----------------------------------------------------------

  server.registerTool(
    'kugou_get_song_comments',
    {
      title: '获取歌曲评论',
      description: '分页获取歌曲评论（默认热门在前）。传歌曲的 mixsongid（即搜索结果中的 mixsongid/album_audio_id）。',
      inputSchema: {
        mixsongid: z.number().int().describe('歌曲 mixsongid（kugou_search 结果的 mixsongid 字段）'),
        page: z.number().int().min(1).optional().describe('页码，默认 1'),
        pagesize: z.number().int().min(1).max(100).optional().describe('每页数量，默认 30'),
      },
    },
    async (p) => {
      const body = await call('comment_music', { mixsongid: p.mixsongid, page: p.page || 1, pagesize: p.pagesize || 30 });
      const list = body?.list || [];
      return text({
        mixsongid: p.mixsongid,
        total: body?.count,
        page: p.page || 1,
        returned: list.length,
        comments: list.map(trimComment),
        hot_words: Array.isArray(body?.hot_word_list) ? body.hot_word_list.map((w) => w.hot_word || w.word).filter(Boolean).slice(0, 10) : undefined,
      });
    }
  );

  server.registerTool(
    'kugou_send_comment',
    {
      title: '发表歌曲评论',
      description: '以当前登录用户身份发表歌曲评论。需登录。内容对外公开可见，调用前应与用户确认内容。',
      inputSchema: {
        mixsongid: z.number().int().describe('歌曲 mixsongid（kugou_search 结果的 mixsongid 字段）'),
        content: z.string().min(1).max(300).describe('评论内容（1-300 字）'),
      },
    },
    async (p) => {
      const body = await call('comment_music_send', { mixsongid: p.mixsongid, content: p.content }, { requireLogin: true });
      return text({ success: body?.status === 1, mixsongid: p.mixsongid, response: body });
    }
  );

  // ----------------------------------------------------------
  // 歌单组（收藏管理）
  // ----------------------------------------------------------

  server.registerTool(
    'kugou_get_user_playlists',
    {
      title: '获取我的歌单',
      description: '列出当前用户全部歌单（自动翻页取全量，含自建与收藏；默认收藏夹“我喜欢”标 is_def=2）。需登录。',
      inputSchema: {
        pagesize: z.number().int().optional().describe('单页请求数量，默认 100（工具自动翻页取完）'),
      },
    },
    async (p) => {
      const pagesize = p.pagesize || 100;
      let page = 1;
      let lists = [];
      let counts = {};
      // 自动翻页：单页返回不足 pagesize 或已达 list_count 总数时停止
      for (;;) {
        const body = await call('user_playlist', { page, pagesize }, { requireLogin: true });
        const batch = playlistLists(body);
        lists = lists.concat(batch);
        counts = {
          total: body?.data?.list_count ?? lists.length, // list_count 为歌单总数（新版响应无 data.total）
          collected: body?.data?.collect_count,
        };
        if (!batch.length || batch.length < pagesize || lists.length >= counts.total) break;
        page++;
      }
      const fav = findFavoriteList(lists);
      return text({
        total: counts.total ?? lists.length,
        created_count: lists.filter((l) => Number(l.type) === 0).length,
        collected_count: counts.collected ?? lists.filter((l) => Number(l.type) === 1).length,
        total_ver: body?.data?.total_ver, // 歌单改名的版本号（kugou_update_playlist 自动代查，一般无需手动传）
        favorite_list: fav ? trimPlaylist(fav) : null,
        playlists: lists.map(trimPlaylist),
        hint: '收藏/取消收藏歌曲无需手动指定 listid（工具会自动使用 favorite_list）；歌单增删歌曲用各工具传 listid。',
      });
    }
  );

  server.registerTool(
    'kugou_get_playlist_tracks',
    {
      title: '获取歌单内歌曲',
      description: '分页获取歌单内歌曲（含 fileid——取消收藏/删歌必需）。默认返回第 1 页 300 首，歌单较大时传 page 翻页。默认收藏夹可用 listid=favorite 简写。需登录。',
      inputSchema: {
        listid: z.string().describe('歌单 listid，或 "favorite" 表示默认收藏夹'),
        page: z.number().int().optional().describe('页码，默认 1'),
        pagesize: z.number().int().optional().describe('每页数量，默认 300（v3 端点单页上限）'),
      },
    },
    async (p) => {
      let listid = p.listid;
      if (listid === 'favorite') {
        const body = await call('user_playlist', { pagesize: 100 }, { requireLogin: true });
        const fav = findFavoriteList(playlistLists(body));
        if (!fav) throw new Error('未找到默认收藏夹，请先调用 kugou_get_user_playlists 查看歌单结构。');
        listid = String(fav.listid);
      }
      const page = p.page || 1;
      const pagesize = p.pagesize || 300;
      const body = await call('playlist_track_all_new', { listid, page, pagesize }, { requireLogin: true });
      const data = body?.data || body;
      const tracks = playlistTrackLists(body);
      const total = data?.count ?? data?.total ?? tracks.length;
      const first = (page - 1) * pagesize + 1;
      return text({
        listid,
        total,
        page,
        returned: tracks.length,
        has_more: first + tracks.length - 1 < total,
        list_ver: data?.list_ver,
        songs: tracks.map(trimPlaylistSong),
        hint: first + tracks.length - 1 < total ? `共 ${total} 首，已返回第 ${page} 页（${first}-${first + tracks.length - 1}），传 page=${page + 1} 继续翻页。` : undefined,
      });
    }
  );

  server.registerTool(
    'kugou_favorite_song',
    {
      title: '收藏歌曲',
      description: '收藏歌曲到默认收藏夹（我喜欢的单曲）。传入 kugou_search 结果中的歌名与 hash。需登录。',
      inputSchema: {
        name: z.string().describe('歌曲名'),
        hash: z.string().describe('歌曲 hash'),
        album_id: z.number().optional().describe('专辑 id'),
        album_audio_id: z.number().optional().describe('mixsongid，服务端校验时需要'),
      },
    },
    async (p) => {
      const plBody = await call('user_playlist', { pagesize: 100 }, { requireLogin: true });
      const lists = playlistLists(plBody);
      const fav = findFavoriteList(lists);
      if (!fav) throw new Error(`未找到默认收藏夹。现有歌单：${lists.map((l) => `${l.listid}:${l.name}`).join('、').slice(0, 200)}`);
      const data = [p.name, p.hash, p.album_id || 0, p.album_audio_id || 0].join('|');
      const body = await call('playlist_tracks_add', { listid: fav.listid, data }, { requireLogin: true });
      return text({ success: body?.status === 1, listid: fav.listid, playlist_name: fav.name, song: `${p.name}|${p.hash}`, response: body });
    }
  );

  server.registerTool(
    'kugou_unfavorite_song',
    {
      title: '取消收藏歌曲',
      description: '从默认收藏夹移除歌曲。按 hash（或 mixsongid）在收藏夹中定位 fileid 后删除。需登录。',
      inputSchema: {
        hash: z.string().optional().describe('歌曲 hash（推荐）'),
        mixsongid: z.number().optional().describe('mixsongid（与 hash 二选一）'),
      },
    },
    async (p) => {
      if (!p.hash && !p.mixsongid) throw new Error('必须提供 hash 或 mixsongid 之一。');
      const plBody = await call('user_playlist', { pagesize: 100 }, { requireLogin: true });
      const lists = playlistLists(plBody);
      const fav = findFavoriteList(lists);
      if (!fav) throw new Error('未找到默认收藏夹。');
      // 翻页拉全量后按 v3 端点的最新 fileid 定位（旧端点 fileid 已失效，这是取消收藏不生效的根源）
      const tracks = await fetchAllPlaylistTracks(fav.listid);
      const matched = tracks.filter((t) => (p.hash ? String(t.hash || '').toLowerCase() === String(p.hash).toLowerCase() : Number(t.mixsongid ?? t.songid) === Number(p.mixsongid)));
      if (matched.length === 0) {
        return text({ success: false, message: '收藏夹中未找到该歌曲（可能本就未收藏）。', favorite_listid: fav.listid });
      }
      const fileids = matched.map((t) => t.fileid ?? t.FileID).join(',');
      const body = await call('playlist_tracks_del', { listid: fav.listid, fileids }, { requireLogin: true });
      return text({ success: body?.status === 1, listid: fav.listid, removed: matched.map(trimPlaylistSong), fileids, response: body });
    }
  );

  server.registerTool(
    'kugou_playlist_add_songs',
    {
      title: '向歌单添加歌曲',
      description: '向指定歌单批量添加歌曲。需登录。',
      inputSchema: {
        listid: z.string().describe('目标歌单 listid'),
        songs: require('zod')
          .array(z.object({ name: z.string(), hash: z.string(), album_id: z.number().optional(), album_audio_id: z.number().optional() }))
          .min(1)
          .describe('歌曲列表（来自 kugou_search）'),
      },
    },
    async (p) => {
      const data = p.songs.map((s) => [s.name, s.hash, s.album_id || 0, s.album_audio_id || 0].join('|')).join(',');
      const body = await call('playlist_tracks_add', { listid: p.listid, data }, { requireLogin: true });
      return text({ success: body?.status === 1, listid: p.listid, added_count: p.songs.length, response: body });
    }
  );

  server.registerTool(
    'kugou_playlist_remove_songs',
    {
      title: '从歌单移除歌曲',
      description: '从指定歌单批量移除歌曲（按 hash/mixsongid 定位 fileid）。需登录。',
      inputSchema: {
        listid: z.string().describe('歌单 listid'),
        hashes: z.array(z.string()).optional().describe('歌曲 hash 列表'),
        mixsongids: z.array(z.number()).optional().describe('mixsongid 列表（与 hashes 二选一）'),
      },
    },
    async (p) => {
      if (!p.hashes?.length && !p.mixsongids?.length) throw new Error('必须提供 hashes 或 mixsongids 之一。');
      const tracks = await fetchAllPlaylistTracks(p.listid);
      const hashSet = new Set((p.hashes || []).map((h) => String(h).toLowerCase()));
      const idSet = new Set((p.mixsongids || []).map(Number));
      const matched = tracks.filter((t) => hashSet.has(String(t.hash || '').toLowerCase()) || idSet.has(Number(t.mixsongid ?? t.songid)));
      if (!matched.length) return text({ success: false, message: '歌单中未找到匹配歌曲。' });
      const fileids = matched.map((t) => t.fileid ?? t.FileID).join(',');
      const body = await call('playlist_tracks_del', { listid: p.listid, fileids }, { requireLogin: true });
      return text({ success: body?.status === 1, removed: matched.map(trimPlaylistSong), response: body });
    }
  );

  server.registerTool(
    'kugou_create_playlist',
    {
      title: '新建歌单',
      description: '新建一个自建歌单。需登录。',
      inputSchema: {
        name: z.string().describe('歌单名称'),
        is_pri: z.number().int().optional().describe('0 公开（默认），1 隐私'),
      },
    },
    async (p) => {
      const body = await call('playlist_add', { name: p.name, type: 0, is_pri: p.is_pri || 0 }, { requireLogin: true });
      return text({ success: body?.status === 1, name: p.name, new_listid: body?.data?.listid ?? body?.listid, response: body });
    }
  );

  server.registerTool(
    'kugou_delete_playlist',
    {
      title: '删除歌单 / 取消收藏歌单',
      description: '删除自建歌单，或取消收藏他人歌单（type=1 收藏来的）。需登录。',
      inputSchema: {
        listid: z.string().describe('歌单 listid'),
      },
    },
    async (p) => {
      const body = await call('playlist_del', { listid: p.listid }, { requireLogin: true });
      return text({ success: body?.status === 1, listid: p.listid, response: body });
    }
  );

  server.registerTool(
    'kugou_get_playlist_detail',
    {
      title: '获取歌单详情',
      description: '获取歌单完整元信息（创建者、简介、标签、收藏数、发布时间等）。传自己的 listid（自动换算 global_collection_id）或任意歌单的 global_collection_id。',
      inputSchema: {
        listid: z.string().optional().describe('自己的歌单 listid（与 global_collection_id 二选一，自动换算）'),
        global_collection_id: z.string().optional().describe('歌单全局集合 id（kugou_get_user_playlists 每项的 global_collection_id，支持他人歌单）'),
      },
    },
    async (p) => {
      let gcid = p.global_collection_id;
      if (!gcid) {
        if (!p.listid) throw new Error('必须提供 listid 或 global_collection_id 之一。');
        const plBody = await call('user_playlist', { pagesize: 100 }, { requireLogin: true });
        const target = playlistLists(plBody).find((l) => String(l.listid) === String(p.listid));
        if (!target?.global_collection_id) throw new Error(`歌单 ${p.listid} 不存在或缺少 global_collection_id，请用 kugou_get_user_playlists 确认。`);
        gcid = target.global_collection_id;
      }
      const body = await call('playlist_detail', { ids: gcid }, { requireLogin: true });
      const items = Array.isArray(body?.data) ? body.data : [];
      return text({ global_collection_id: gcid, count: items.length, details: items.map(trimPlaylist) });
    }
  );

  server.registerTool(
    'kugou_update_playlist',
    {
      title: '修改歌单信息',
      description: '修改自建歌单的名称/简介/标签/排序号（total_ver 与 type 自动代查，无需手动传）。需登录。',
      inputSchema: {
        listid: z.string().describe('歌单 listid'),
        name: z.string().optional().describe('新名称（不传则不变）'),
        intro: z.string().optional().describe('新简介（不传则保持原值）'),
        tags: z.string().optional().describe('新标签（逗号分隔，不传则保持原值）'),
        sort: z.number().int().optional().describe('排序号（影响歌单在列表中的位置）'),
      },
    },
    async (p) => {
      if (!p.name && !p.intro && !p.tags && p.sort === undefined) throw new Error('至少提供 name / intro / tags / sort 之一。');
      const plBody = await call('user_playlist', { pagesize: 100 }, { requireLogin: true });
      const lists = playlistLists(plBody);
      const target = lists.find((l) => String(l.listid) === String(p.listid));
      if (!target) throw new Error(`未找到歌单 ${p.listid}，请用 kugou_get_user_playlists 确认 listid。`);
      // 未显式传 intro/tags 时沿用现值，避免改名把简介/标签清空
      const body = await call(
        'playlist_update',
        {
          listid: p.listid,
          type: Number(target.type) || 0,
          total_ver: Number(plBody?.data?.total_ver) || 0,
          name: p.name,
          intro: p.intro ?? (Array.isArray(target.tags) ? undefined : target.intro) ?? '',
          tags: p.tags ?? (Array.isArray(target.tags) ? target.tags.join(',') : target.tags) ?? '',
          sort: p.sort ?? (Number(target.sort) || 0),
        },
        { requireLogin: true }
      );
      return text({ success: body?.status === 1, listid: p.listid, updated: Object.keys(p).filter((k) => k !== 'listid'), response: body });
    }
  );

  server.registerTool(
    'kugou_sort_playlist_tracks',
    {
      title: '歌单内歌曲排序',
      description: '自定义歌单内歌曲顺序（可对“我喜欢”使用）。传 fileid 与目标位次（1 起），list_ver 自动代查。fileid 来自 kugou_get_playlist_tracks。需登录。',
      inputSchema: {
        listid: z.string().describe('歌单 listid'),
        tracks: require('zod')
          .array(z.object({ fileid: z.union([z.string(), z.number()]), sort: z.number().int().min(1) }))
          .min(1)
          .describe('排序项：fileid（歌单歌曲的 fileid）+ sort（目标位次，从 1 开始）'),
      },
    },
    async (p) => {
      // 取第 1 页拿 list_ver（版本号代查），fileid 与位次由调用方给出
      const firstPage = await call('playlist_track_all_new', { listid: p.listid, page: 1, pagesize: 1 }, { requireLogin: true });
      const listVer = Number(firstPage?.data?.list_ver) || 0;
      const plBody = await call('user_playlist', { pagesize: 100 }, { requireLogin: true });
      const target = playlistLists(plBody).find((l) => String(l.listid) === String(p.listid));
      const data = p.tracks.map((t) => `${t.fileid}|${t.sort}`).join(',');
      const body = await call('playlist_tracks_sort', { listid: p.listid, type: Number(target?.type) || 0, list_ver: listVer, data }, { requireLogin: true });
      return text({ success: body?.status === 1, listid: p.listid, sorted: p.tracks.length, response: body });
    }
  );

  // ----------------------------------------------------------
  // 云盘组（用户上传音乐管理）
  // ----------------------------------------------------------

  server.registerTool(
    'kugou_get_cloud_songs',
    {
      title: '获取云盘歌曲列表',
      description: '分页列出已上传到用户云盘的音乐（含 fileid/kv_id——删除云盘音乐所需，hash——获取云盘直链所需）。需登录。',
      inputSchema: {
        page: z.number().int().min(1).optional().describe('页码，默认 1'),
        pagesize: z.number().int().min(1).max(100).optional().describe('每页数量，默认 30'),
      },
    },
    async (p) => {
      const page = p.page || 1;
      const pagesize = p.pagesize || 30;
      const body = await call('user_cloud', { page, pagesize }, { requireLogin: true });
      const data = body?.data || body;
      const list = cloudLists(body);
      // 云盘列表总数在 list_count（实测 /v1/get_list 响应，另有 used/max_size 容量信息）
      const total = Number(data?.list_count ?? data?.count ?? data?.total ?? list.length) || list.length;
      const first = (page - 1) * pagesize + 1;
      return text({
        total,
        page,
        returned: list.length,
        has_more: first + list.length - 1 < total,
        capacity_mb:
          Number(data?.max_size) > 0
            ? { used: Math.round((data.used_size || 0) / 1048576), max: Math.round(data.max_size / 1048576) }
            : undefined,
        songs: list.map(trimCloudSong),
        hint: first + list.length - 1 < total ? `共 ${total} 首，已返回第 ${page} 页（${first}-${first + list.length - 1}），传 page=${page + 1} 继续翻页。` : undefined,
      });
    }
  );

  server.registerTool(
    'kugou_get_cloud_song_url',
    {
      title: '获取云盘音乐直链',
      description: '获取云盘音乐的播放/下载直链（hash 来自 kugou_get_cloud_songs 列表）。云盘文件不受曲库版权限制；已匹配曲库的文件也可改用 kugou_get_song_url 获取。需登录。',
      inputSchema: {
        hash: z.string().describe('云盘文件 hash（列表中的 hash 字段，大小写不敏感）'),
        album_audio_id: z.number().optional().describe('专辑音频 id（提高命中率）'),
        audio_id: z.number().optional().describe('音频 id（提高命中率）'),
        name: z.string().optional().describe('云盘音乐名称'),
      },
    },
    async (p) => {
      const body = await call('user_cloud_url', { hash: p.hash, album_audio_id: p.album_audio_id, audio_id: p.audio_id, name: p.name }, { requireLogin: true });
      const d = body?.data || body;
      const rawUrls = d?.url ?? body?.url;
      const urls = (Array.isArray(rawUrls) ? rawUrls : rawUrls ? [rawUrls] : []).filter(Boolean);
      const backups = d?.backupUrl ?? body?.backupUrl;
      const timeLength = d?.timeLength ?? body?.timeLength;
      return text({
        hash: p.hash,
        status: body?.status,
        url_count: urls.length,
        urls,
        backup_urls: Array.isArray(backups) ? backups : backups ? [backups] : [],
        size: d?.fileSize ?? body?.fileSize,
        ext: d?.extName ?? body?.extName,
        duration_sec: timeLength ? Math.floor(timeLength / 1000) : undefined,
        hint: urls.length ? undefined : '未获取到直链：请确认 hash 来自 kugou_get_cloud_songs 列表（云盘文件 hash），或稍后重试。',
      });
    }
  );

  server.registerTool(
    'kugou_delete_cloud_songs',
    {
      title: '删除云盘音乐',
      description: '从用户云盘删除音乐（不可恢复）。fileid 传 kugou_get_cloud_songs 返回的 fileid（kv_id），支持批量。需登录。',
      inputSchema: {
        fileids: z
          .union([z.array(z.union([z.string(), z.number()])), z.string(), z.number()])
          .describe('云盘文件 ID（kv_id），单个、多个数组或英文逗号分隔字符串'),
        album_audio_ids: z.union([z.array(z.union([z.string(), z.number()])), z.string(), z.number()]).optional().describe('对应的专辑音频 id（与 fileids 顺序对应，可选）'),
      },
    },
    async (p) => {
      const body = await call('user_cloud_del', { fileids: p.fileids, album_audio_ids: p.album_audio_ids }, { requireLogin: true });
      return text({ success: body?.status === 1, removed_ids: [].concat(p.fileids).map(String), response: body });
    }
  );

  server.registerTool(
    'kugou_cloud_match',
    {
      title: '云盘上传前曲库匹配',
      description: '按文件 hash（即文件 MD5）匹配酷狗曲库，返回 hash_std/audio_id/album_audio_id 等，用于上传前预查或手动修正关联信息。kugou_upload_cloud_song 默认已自动匹配，无需先行调用。',
      inputSchema: {
        hash: z.string().describe('文件 hash（MD5，大小写不敏感），多个用英文逗号分隔'),
        album_audio_id: z.union([z.string(), z.number()]).optional().describe('已知专辑音频 id 时可辅助匹配'),
      },
    },
    async (p) => {
      const body = await call('user_cloud_match', { hash: p.hash, album_audio_id: p.album_audio_id }, { requireLogin: true });
      const out = { status: body?.status, match: body?.match ?? null };
      if (Array.isArray(body?.match_list)) out.match_list = body.match_list;
      if (body?.status !== 1) out.response = body;
      return text(out);
    }
  );

  server.registerTool(
    'kugou_upload_cloud_song',
    {
      title: '上传音乐到云盘',
      description: '上传音乐文件到用户云盘。file_path（服务端本地路径，如 kugou_download_song 的保存路径）与 file_base64（文件内容 base64，适合远程推送小文件）二选一。默认按文件 MD5 自动匹配曲库并把 hash_std/audio_id/album_audio_id 写入云盘（匹配后可与标准曲库关联、参与搜索）。需登录。',
      inputSchema: {
        file_path: z.string().optional().describe('服务端本地文件路径（与 file_base64 二选一；MCP 部署在远端时该路径须为服务端可访问路径）'),
        file_base64: z.string().optional().describe('文件内容 base64（与 file_path 二选一；HTTP 接入受 /mcp 请求体上限约束，大文件建议用 file_path）'),
        name: z.string().optional().describe('云盘显示名称，默认「歌手 - 曲名.扩展名」'),
        author_name: z.string().optional().describe('歌手名'),
        extendname: z.string().optional().describe('文件扩展名，默认 mp3'),
        hash_std: z.string().optional().describe('曲库标准 hash（默认自动匹配）'),
        audio_id: z.number().optional().describe('音频 id（默认自动匹配）'),
        album_audio_id: z.number().optional().describe('专辑音频 id（默认自动匹配）'),
        auto_match: z.boolean().optional().describe('是否自动匹配曲库，默认 true'),
      },
    },
    async (p) => {
      let data;
      if (p.file_path) {
        const filePath = path.resolve(p.file_path);
        if (!fs.existsSync(filePath)) throw new Error(`文件不存在：${filePath}`);
        data = fs.readFileSync(filePath);
      } else if (p.file_base64) {
        data = Buffer.from(p.file_base64, 'base64');
      } else {
        throw new Error('必须提供 file_path 或 file_base64 之一。');
      }
      if (!data.length) throw new Error('文件内容为空。');
      const { file_path: _filePath, file_base64: _fileBase64, ...params } = p;
      const body = await call('user_cloud_upload', { ...params, data }, { requireLogin: true });
      return text({ success: body?.status === 1, response: body });
    }
  );

  // ----------------------------------------------------------
  // MV 组
  // ----------------------------------------------------------

  server.registerTool(
    'kugou_get_mv_url',
    {
      title: '获取 MV 播放/下载地址',
      description: '传入 MV hash（kugou_search type=mv 结果中的 hash/MvHash）获取标清/高清/超清播放地址。',
      inputSchema: {
        hash: z.string().describe('MV hash'),
      },
    },
    async (p) => {
      const body = await call('video_url', { hash: p.hash });
      const d = body?.data || body;
      // data 是以 hash 为 key 的映射：{ [hash]: { downurl, backupdownurl, filesize } }
      const byHash = d && typeof d === 'object' ? d[String(p.hash).toLowerCase()] || Object.values(d)[0] : null;
      const urls = [];
      if (byHash?.downurl) urls.push({ quality: 'default', size: Number(byHash.filesize) || undefined, url: byHash.downurl, backup_urls: byHash.backupdownurl || [] });
      else if (d?.sd || d?.hd || d?.uhd) {
        // 兼容 sd/hd/uhd 分档结构
        for (const q of ['sd', 'hd', 'uhd', 'shd']) {
          if (d[q]?.url) urls.push({ quality: q, size: d[q].filesize, url: d[q].url });
        }
      }
      return text({ hash: p.hash, status: body?.status, urls, size_bytes: byHash ? Number(byHash.filesize) || undefined : undefined });
    }
  );

  server.registerTool(
    'kugou_collect_mv',
    {
      title: '收藏 MV',
      description: '收藏 MV（mv id 来自搜索或详情）。需登录。',
      inputSchema: { id: z.number().describe('MV id（MvID）') },
    },
    async (p) => {
      const body = await call('mv_collect', { id: p.id }, { requireLogin: true });
      return text({ success: body?.status === 1, mv_id: p.id, response: body });
    }
  );

  server.registerTool(
    'kugou_uncollect_mv',
    {
      title: '取消收藏 MV',
      description: '取消收藏 MV。需登录。',
      inputSchema: { id: z.number().describe('MV id（MvID）') },
    },
    async (p) => {
      const body = await call('mv_collect_del', { id: p.id }, { requireLogin: true });
      return text({ success: body?.status === 1, mv_id: p.id, response: body });
    }
  );

  // ----------------------------------------------------------
  // 歌手 / 专辑组
  // ----------------------------------------------------------

  server.registerTool(
    'kugou_get_artist_info',
    {
      title: '获取歌手信息',
      description: '获取歌手资料、热门歌曲或专辑列表。action=detail（资料）/ songs（歌曲）/ albums（专辑）。',
      inputSchema: {
        id: z.number().describe('歌手 id（搜索 artist 结果的 artist_id）'),
        action: z.enum(['detail', 'songs', 'albums']).optional().describe('默认 detail'),
        page: z.number().int().optional(),
        pagesize: z.number().int().optional(),
      },
    },
    async (p) => {
      const action = p.action || 'detail';
      if (action === 'detail') {
        const body = await call('artist_detail', { id: p.id });
        let d = body?.data || body;
        if (Array.isArray(d)) d = d[0];
        return text({
          artist_id: p.id,
          name: d?.author_name || d?.name || d?.singername,
          intro: (d?.intro || d?.long_intro || '').slice(0, 500),
          area_id: d?.area_id,
          birthday: d?.birthday,
          song_count: d?.song_count,
          album_count: d?.album_count,
          mv_count: d?.mv_count,
          fans: d?.fansnums ?? d?.fans,
          avatar: d?.sizable_avatar ? String(d.sizable_avatar).replace('{size}', '480') : undefined,
        });
      }
      if (action === 'songs') {
        const body = await call('artist_audios', { id: p.id, page: p.page, pagesize: p.pagesize });
        const list = body?.data || [];
        return text({
          artist_id: p.id,
          total: body?.total,
          songs: list.slice(0, p.pagesize || 30).map((s) => ({
            name: s.filename || s.audio_name || s.name,
            singer: s.singername,
            hash: s.hash,
            album_id: s.album_id,
            mixsongid: s.mixsongid ?? s.songid,
            duration_sec: s.timelen ? Math.floor(s.timelen / 1000) : s.duration,
            pay: s.pay_type,
            vip: Number(s.privilege || 0) > 0 || Number(s.pay_type || 0) > 0,
          })),
        });
      }
      const body = await call('artist_albums', { id: p.id, page: p.page, pagesize: p.pagesize });
      const list = body?.data || [];
      return text({ artist_id: p.id, total: body?.total, albums: list.map(trimSearchAlbum) });
    }
  );

  server.registerTool(
    'kugou_follow_artist',
    {
      title: '关注歌手',
      description: '关注指定歌手。需登录。',
      inputSchema: { id: z.number().describe('歌手 id') },
    },
    async (p) => {
      const body = await call('artist_follow', { id: p.id }, { requireLogin: true });
      return text({ success: body?.status === 1, artist_id: p.id, response: body });
    }
  );

  server.registerTool(
    'kugou_unfollow_artist',
    {
      title: '取消关注歌手',
      description: '取消关注指定歌手。需登录。',
      inputSchema: { id: z.number().describe('歌手 id') },
    },
    async (p) => {
      const body = await call('artist_unfollow', { id: p.id }, { requireLogin: true });
      return text({ success: body?.status === 1, artist_id: p.id, response: body });
    }
  );

  server.registerTool(
    'kugou_get_album_info',
    {
      title: '获取专辑信息',
      description: '获取专辑详情与歌曲列表。action=detail（简介）/ songs（歌曲，默认）。',
      inputSchema: {
        album_id: z.number().describe('专辑 id'),
        action: z.enum(['detail', 'songs']).optional().describe('默认 songs'),
      },
    },
    async (p) => {
      if (p.action === 'detail') {
        const body = await call('album', { album_id: p.album_id });
        return text({ album_id: p.album_id, detail: body?.data?.[0] || body?.data });
      }
      const body = await call('album_songs', { id: p.album_id });
      const songs = body?.data?.songs || [];
      return text({
        album_id: p.album_id,
        total: body?.data?.total,
        songs: songs.map((s) => ({
          // 专辑歌曲的信息分散在 base/audio_info/authors 子对象中
          name: s.base?.audio_name || s.filename || s.name,
          singer: s.base?.author_name || (Array.isArray(s.authors) ? s.authors.map((a) => a.author_name).join('/') : s.singername),
          hash: s.audio_info?.hash || s.hash,
          album_id: s.base?.album_id,
          album_audio_id: s.base?.album_audio_id ?? s.album_audio_id ?? s.mixsongid,
          duration_sec: s.audio_info?.duration ? Math.floor(s.audio_info.duration / 1000) : s.timelen ? Math.floor(s.timelen / 1000) : s.duration,
          vip: Number(s.trans_param?.privilege || 0) > 0 || Number(s.copyright?.pay_type ?? s.pay_type ?? 0) > 0,
        })),
      });
    }
  );

  // ----------------------------------------------------------
  // 下载组
  // ----------------------------------------------------------

  server.registerTool(
    'kugou_download_song',
    {
      title: '下载歌曲到本地',
      description: '获取歌曲直链并下载保存为文件。返回保存路径与文件大小。未登录下载 VIP 歌曲会得到试听片段（会明确标注）。',
      inputSchema: {
        hash: z.string().describe('歌曲 hash'),
        name: z.string().describe('文件名（不含扩展名）'),
        album_id: z.number().optional(),
        album_audio_id: z.number().optional(),
        quality: z.string().optional().describe('期望音质，默认 128（可选 320/flac/high 等）'),
        save_dir: z.string().optional().describe('保存目录（默认 ./downloads）'),
      },
    },
    async (p) => {
      const { body: urlBody, identity } = await fetchSongUrl(p);
      const urls = normalizeSongUrls(urlBody, p.quality).filter((u) => u.url);
      if (!urls.length) throw new Error('未获取到可用直链（风控或需要 VIP 权限）：可调用 kugou_sign_in 签到领取概念版 VIP 后重试（需先 kugou_login_concept 登录概念版）。');
      const targetQ = String(p.quality || '128').replace('magic_', '');
      urls.sort((a, b) => qualityIndex(String(b.quality || b.bitrate)) - qualityIndex(String(a.quality || a.bitrate)));
      urls.sort((a, b) => (String(b.quality || b.bitrate) === targetQ ? 1 : 0) - (String(a.quality || a.bitrate) === targetQ ? 1 : 0));
      const chosen = urls[0];
      const saveDir = path.resolve(p.save_dir || 'downloads');
      fs.mkdirSync(saveDir, { recursive: true });
      const ext = chosen.ext || String(chosen.url).split('.').pop().split('?')[0] || 'mp3';
      const filePath = path.join(saveDir, `${safeFilename(p.name)}.${ext}`);
      const resp = await axios({ url: chosen.url, method: 'GET', responseType: 'stream', timeout: 60000 });
      const writer = fs.createWriteStream(filePath);
      resp.data.pipe(writer);
      await new Promise((resolve, reject) => {
        writer.on('finish', resolve);
        writer.on('error', reject);
      });
      const size = fs.statSync(filePath).size;
      return text({
        saved: true,
        path: filePath,
        size_bytes: size,
        size_mb: (size / 1024 / 1024).toFixed(2),
        quality: chosen.quality || chosen.bitrate,
        identity,
        is_free_trial: urlBody?.is_free_part === 1 || (Boolean(urlBody?.hash_offset) && urlBody?.status === 2),
      });
    }
  );

  server.registerTool(
    'kugou_download_lyric',
    {
      title: '下载歌词到本地',
      description: '获取歌词并保存为 .lrc 文件。返回保存路径。',
      inputSchema: {
        hash: z.string().describe('歌曲 hash'),
        name: z.string().describe('文件名（不含扩展名）'),
        duration: z.number().optional().describe('歌曲时长（秒）'),
        save_dir: z.string().optional().describe('保存目录（默认 ./downloads）'),
      },
    },
    async (p) => {
      const searchBody = await call('search_lyric', { hash: p.hash, duration: p.duration, keywords: '' });
      const cand = (searchBody?.candidates || [])[0];
      if (!cand) throw new Error('未找到歌词候选。');
      const body = await call('lyric', { id: cand.id, accesskey: cand.accesskey, fmt: 'lrc', decode: 1 });
      // decode=1 时 decodeContent 已是解码后的 LRC 文本，直接使用
      const raw = body?.decodeContent || '';
      const lyricText = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
      const saveDir = path.resolve(p.save_dir || 'downloads');
      fs.mkdirSync(saveDir, { recursive: true });
      const filePath = path.join(saveDir, `${safeFilename(p.name)}.lrc`);
      fs.writeFileSync(filePath, lyricText, 'utf8');
      return text({ saved: true, path: filePath, size_bytes: Buffer.byteLength(lyricText), song: cand.song, singer: cand.singer });
    }
  );

  // ----------------------------------------------------------
  // 个人数据组（听歌数据与已购资产）
  // ----------------------------------------------------------

  server.registerTool(
    'kugou_get_play_history',
    {
      title: '获取听歌排行',
      description: '获取账号听歌排行（按播放次数排序，含每首歌的播放次数与最后播放日期），是“我最近都在听什么”的数据来源。数据量大时以 bp 游标翻页。需登录。',
      inputSchema: {
        bp: z.string().optional().describe('翻页游标（上次响应返回的 next_bp，不传取第一页）'),
      },
    },
    async (p) => {
      const body = await call('user_history', p.bp ? { bp: p.bp } : {}, { requireLogin: true });
      const data = body?.data || body;
      const songs = data?.songs || [];
      return text({
        count: songs.length,
        has_more: Boolean(data?.has_more) && !data?.bp_finished,
        next_bp: data?.bp,
        songs: songs.map(trimHistorySong),
        hint: data?.has_more && !data?.bp_finished ? '还有更多，把 next_bp 作为 bp 参数传入取下一页。' : undefined,
      });
    }
  );

  server.registerTool(
    'kugou_get_purchased_songs',
    {
      title: '获取已购单曲',
      description: '分页列出账号已付费购买的单曲。需登录。',
      inputSchema: {
        page: z.number().int().min(1).optional().describe('页码，默认 1'),
        pagesize: z.number().int().min(1).max(100).optional().describe('每页数量，默认 50'),
      },
    },
    async (p) => {
      const body = await call('user_purchased_songs', { page: p.page || 1, pagesize: p.pagesize || 50 }, { requireLogin: true });
      const goods = body?.data?.goods || [];
      return text({ total: body?.data?.total, page: p.page || 1, returned: goods.length, songs: goods.map(trimPurchased) });
    }
  );

  server.registerTool(
    'kugou_get_purchased_albums',
    {
      title: '获取已购专辑',
      description: '分页列出账号已付费购买的专辑。需登录。',
      inputSchema: {
        page: z.number().int().min(1).optional().describe('页码，默认 1'),
        pagesize: z.number().int().min(1).max(100).optional().describe('每页数量，默认 15'),
      },
    },
    async (p) => {
      const body = await call('user_purchased_albums', { page: p.page || 1, pagesize: p.pagesize || 15 }, { requireLogin: true });
      const goods = body?.data?.goods || [];
      return text({ total: body?.data?.total, page: p.page || 1, returned: goods.length, albums: goods.map(trimPurchased) });
    }
  );

  // ----------------------------------------------------------
  // 推荐组
  // ----------------------------------------------------------

  server.registerTool(
    'kugou_get_recommend_songs',
    {
      title: '每日推荐歌曲',
      description: '获取每日推荐歌曲列表。需登录。',
      inputSchema: {},
    },
    async () => {
      const body = await call('recommend_songs', {}, { requireLogin: true });
      const d = body?.data || body;
      const list = d?.lists || d?.songs || [];
      return text({ date: d?.date, total: list.length, songs: list.map(trimPlaylistSong) });
    }
  );

  server.registerTool(
    'kugou_get_personal_fm',
    {
      title: '私人 FM',
      description: '获取私人 FM 电台歌曲。需登录。',
      inputSchema: {},
    },
    async () => {
      const body = await call('personal_fm', {}, { requireLogin: true });
      const list = body?.data?.lists || body?.data || [];
      return text({ songs: (Array.isArray(list) ? list : []).map(trimPlaylistSong) });
    }
  );
}

module.exports = { registerTools };
