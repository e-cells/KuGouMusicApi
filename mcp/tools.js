/**
 * @fileoverview MCP 工具注册表
 *
 * 面向智能音乐助手 Agent 的工具集，分组：
 * - 登录：酷狗 App 扫码 / 微信扫码 / 登录态查询 / 退出
 * - 搜索：歌曲 / 歌词 / MV / 专辑 / 歌手 / 热搜 / 联想建议
 * - 歌曲：播放/下载直链、音质与版权信息、歌词获取
 * - 歌单：我的歌单、歌单歌曲、收藏/取消收藏、增删歌曲、新建/删除歌单
 * - MV：播放地址、收藏管理
 * - 歌手/专辑：资料、歌曲列表、关注管理
 * - 下载：音频文件、歌词文件保存到本地
 * - 推荐：每日推荐、私人 FM
 *
 * 所有工具基于项目编程式 API（main.js 导出的模块函数）进程内调用，
 * 会话（设备指纹 + 登录态）由 session.js 统一管理并持久化。
 */

const fs = require('node:fs');
const path = require('node:path');
const axios = require('axios');
const qrcode = require('qrcode');

const z = require('zod');
const api = require('../main');
const { session } = require('./session');

// ============================================================
// 基础调用与裁剪工具
// ============================================================

/**
 * 调用一个 API 模块函数，自动注入会话 cookie 并回收响应 cookie
 * @param {string} fn 模块名（module/ 下文件名去掉 .js）
 * @param {Object} params 业务参数
 * @param {Object} [options] { requireLogin: boolean }
 * @returns {Promise<any>} 响应 body
 */
const call = async (fn, params = {}, options = {}) => {
  if (options.requireLogin) session.requireLogin();
  const cookie = await session.ensureDevice();
  let res;
  try {
    res = await api[fn]({ ...params, cookie });
  } catch (e) {
    // 模块拒绝时 e 通常是 {status, body}，也可能是原生 Error
    const body = e?.body;
    const msg =
      body?.error || body?.error_msg || body?.errmsg || body?.msg || body?.info || (e?.message ? String(e.message) : JSON.stringify(body ?? e).slice(0, 300));
    const ssaHint = body?.ssaCode || body?.edt ? '（触发了酷狗风控验证，建议稍后重试或重新登录）' : '';
    throw new Error(`接口 ${fn} 调用失败${e?.status ? ` [${e.status}]` : ''}: ${typeof msg === 'string' ? msg.slice(0, 300) : JSON.stringify(msg).slice(0, 300)}${ssaHint}`);
  }
  if (res && Array.isArray(res.cookie) && res.cookie.length) {
    session.mergeCookieStrings(res.cookie);
  }
  return res?.body ?? res;
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

/** 从歌单歌曲列表裁剪要点（兼容 v3 端点字段名） */
const trimPlaylistSong = (s) => {
  const item = {
    fileid: s.fileid ?? s.FileID ?? s.id,
    name: s.filename || s.name || s.FileName || s.audio_name,
    singer: s.singername || s.SingerName || (Array.isArray(s.singers) ? s.singers.map((x) => x.name).join('/') : undefined),
    hash: s.hash || s.FileHash,
    album_id: s.album_id || s.AlbumID,
    mixsongid: s.mixsongid ?? s.songid ?? s.SongID,
    duration_sec: s.timelen ? Math.floor(s.timelen / 1000) : s.duration,
  };
  return Object.fromEntries(Object.entries(item).filter(([, v]) => v !== undefined));
};

/** 从歌单列表裁剪要点 */
const trimPlaylist = (l) => ({
  listid: l.listid,
  name: l.name,
  count: l.count,
  type: l.type, // 0 自建 / 1 收藏
  special_flag: l.special_flag, // 1 为默认收藏夹（我喜欢的单曲）
  pic: l.pic ? String(l.pic).replace('{size}', '240') : undefined,
  create_time: l.create_time,
});

/** 在用户歌单中定位默认收藏夹 */
const findFavoriteList = (lists = []) => {
  return (
    lists.find((l) => Number(l.special_flag) === 1) ||
    lists.find((l) => /我喜欢|默认收藏|我收藏/.test(String(l.name || '')) && Number(l.type) === 0) ||
    null
  );
};

const QUALITY_RANK = ['128', '192', '256', '320', 'flac', 'flac24bit', 'high', 'super', 'viper_clear', 'viper_tape', 'viper_atmos', 'multitrack'];
const qualityIndex = (q) => {
  const i = QUALITY_RANK.indexOf(String(q));
  return i === -1 ? 0 : i;
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
    'kugou_login_status',
    {
      title: '查询登录状态',
      description: '返回当前会话登录状态与用户资料（昵称、VIP 等）。未登录时给出登录指引。',
      inputSchema: {},
    },
    async () => {
      if (!session.isLoggedIn()) {
        return text({ logged_in: false, hint: '当前未登录。请调用 kugou_login_qr（酷狗 App 扫码）或 kugou_login_wx（微信扫码）发起登录。' });
      }
      const body = await call('user_detail', {}, { requireLogin: true });
      const d = body?.data || body;
      return text({
        logged_in: true,
        userid: session.cookie.userid,
        nickname: d?.nick_name || d?.nick,
        vip_type: d?.vip_type ?? session.cookie.vip_type,
        // 常见资料字段
        gender: d?.gender,
        birthday: d?.birthday,
        fans: d?.fans,
        follows: d?.follow,
        listen_songs: d?.listen_num ?? d?.play_count,
        raw: d,
      });
    }
  );

  server.registerTool(
    'kugou_logout',
    {
      title: '退出登录',
      description: '清除本地保存的登录态（token/userid），保留设备标识。再次使用收藏等能力需重新扫码。',
      inputSchema: {},
    },
    async () => {
      session.logout();
      return text({ logged_in: false, message: '已退出登录。' });
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
  // 歌曲组
  // ----------------------------------------------------------

  server.registerTool(
    'kugou_get_song_url',
    {
      title: '获取歌曲播放/下载直链',
      description: '传入歌曲 hash（来自 kugou_search）获取多音质直链。VIP 歌曲未登录或无会员时仅返回试听段（url 中 IsFreePart）。可指定 quality 期望音质（128/320/flac/high/viper_tape 等），返回按音质排列的可用直链列表。',
      inputSchema: {
        hash: z.string().describe('歌曲 hash（FileHash，大小写不敏感）'),
        album_id: z.number().optional().describe('专辑 id（提高命中率）'),
        album_audio_id: z.number().optional().describe('mixsongid/album_audio_id（提高命中率）'),
        quality: z.string().optional().describe('期望音质：128/320/flac/high/super/viper_tape/viper_clear/viper_atmos，或魔法音质 piano/acappella/subwoofer/ancient/dj，默认 128'),
        free_part: z.boolean().optional().describe('无权限时是否接受试听段，默认 false'),
      },
    },
    async (p) => {
      let body;
      try {
        body = await call('song_url', p);
      } catch (e) {
        // song_url 走 trackercdn，风控/失败时回退新版 priv_url 通道
        body = await call('song_url_new', { hash: p.hash, album_audio_id: p.album_audio_id, free_part: p.free_part });
      }
      const urls = (body?.urls || []).map((u) => ({
        quality: u.quality || String(u.bitrate || ''),
        bitrate: u.bitrate,
        size: u.filesize || u.size,
        ext: u.ext || (u.url ? String(u.url).split('.').pop().split('?')[0] : ''),
        url: u.url,
        backup_urls: u.back_url ? [u.back_url] : u.backupUrls || [],
        free_trial_start: u.start_ms,
        free_trial_end: u.end_ms,
      }));
      // 排序：目标音质优先，其余按音质从高到低
      const targetQ = String(p.quality || '128').replace('magic_', '');
      urls.sort((a, b) => qualityIndex(b.quality) - qualityIndex(a.quality));
      urls.sort((a, b) => (b.quality === targetQ ? 1 : 0) - (a.quality === targetQ ? 1 : 0));
      const out = {
        hash: p.hash,
        status: body?.status,
        url_count: urls.filter((u) => u.url).length,
        urls,
        vip_hint:
          body?.status === 2 || urls.filter((u) => u.url).length === 0
            ? '未获取到可用直链：可能触发了风控（稍后重试）、或该曲为 VIP 歌曲（登录会员账号后重试）'
            : undefined,
        free_trial_hint: body?.is_free_part === 1 || urls.some((u) => u.free_trial_end) ? '当前返回的是试听片段（通常 60 秒内）' : undefined,
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
  // 歌单组（收藏管理）
  // ----------------------------------------------------------

  server.registerTool(
    'kugou_get_user_playlists',
    {
      title: '获取我的歌单',
      description: '列出当前用户全部歌单（含默认收藏夹“我喜欢的单曲”，special_flag=1）。需登录。',
      inputSchema: {
        page: z.number().int().optional(),
        pagesize: z.number().int().optional().describe('默认 30'),
      },
    },
    async (p) => {
      const body = await call('user_playlist', { page: p.page, pagesize: p.pagesize }, { requireLogin: true });
      const lists = body?.data?.lists || body?.lists || [];
      const fav = findFavoriteList(lists);
      return text({
        total: body?.data?.total ?? lists.length,
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
      description: '获取指定歌单的全部歌曲（含 fileid——取消收藏/删歌必需）。默认收藏夹可用 listid=favorite 简写。需登录。',
      inputSchema: {
        listid: z.string().describe('歌单 listid，或 "favorite" 表示默认收藏夹'),
        page: z.number().int().optional().describe('默认 1'),
        pagesize: z.number().int().optional().describe('默认 300（v3 端点单页上限）'),
      },
    },
    async (p) => {
      let listid = p.listid;
      if (listid === 'favorite') {
        const body = await call('user_playlist', {}, { requireLogin: true });
        const fav = findFavoriteList(body?.data?.lists || body?.lists || []);
        if (!fav) throw new Error('未找到默认收藏夹，请先调用 kugou_get_user_playlists 查看歌单结构。');
        listid = String(fav.listid);
      }
      const body = await call('playlist_track_all_new', { listid, page: p.page, pagesize: p.pagesize }, { requireLogin: true });
      const data = body?.data || body;
      const lists = data?.lists || data?.list || [];
      return text({ listid, total: data?.total ?? lists.length, list_ver: data?.list_ver, songs: lists.map(trimPlaylistSong).slice(0, p.pagesize || 300) });
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
      const plBody = await call('user_playlist', {}, { requireLogin: true });
      const lists = plBody?.data?.lists || plBody?.lists || [];
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
      const plBody = await call('user_playlist', {}, { requireLogin: true });
      const lists = plBody?.data?.lists || plBody?.lists || [];
      const fav = findFavoriteList(lists);
      if (!fav) throw new Error('未找到默认收藏夹。');
      // 用 v3 端点取最新 fileid（旧端点 fileid 已失效，这是取消收藏不生效的根源）
      const tracksBody = await call('playlist_track_all_new', { listid: fav.listid, pagesize: 300 }, { requireLogin: true });
      const tracks = tracksBody?.data?.lists || tracksBody?.data?.list || [];
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
      const tracksBody = await call('playlist_track_all_new', { listid: p.listid, pagesize: 300 }, { requireLogin: true });
      const tracks = tracksBody?.data?.lists || tracksBody?.data?.list || [];
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
      let urlBody;
      try {
        urlBody = await call('song_url', p);
      } catch (e) {
        urlBody = await call('song_url_new', { hash: p.hash, album_audio_id: p.album_audio_id });
      }
      const urls = (urlBody?.urls || []).filter((u) => u.url);
      if (!urls.length) throw new Error('未获取到可用直链（风控或需要 VIP 权限），可稍后重试或先登录会员账号。');
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
        is_free_trial: chosen.is_free_part === 1 || Boolean(chosen.end_ms),
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
