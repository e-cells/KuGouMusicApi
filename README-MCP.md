# KuGouMusicApi MCP 服务

面向大模型 Agent 的酷狗音乐工具服务（[Model Context Protocol](https://modelcontextprotocol.io)）。基于本项目编程式 API 进程内调用，提供登录（标准版 + 概念版）、概念版 VIP 签到、搜索、播放/下载直链、歌词、歌单与收藏管理、MV、歌手/专辑、本地下载等 35 个工具，用于构建智能音乐助手。

## 快速开始

**推荐：随 API 服务在线提供（同进程）**

正常启动 API 服务（`node app.js` 或 Docker 部署）即自动挂载 MCP 端点：

```
MCP endpoint: http://<服务地址>:<端口>/mcp  （POST，Streamable HTTP）
```

AI 客户端接入（以 Claude Code 为例）：

```bash
claude mcp add --transport http kugou-music http://<服务地址>:8542/mcp
```

备选：本地独立运行

```bash
# 安装依赖（Node 18+）
npm install

# 启动（stdio 模式，供本地 Agent 接入）
node mcp/server.js

# 或独立 HTTP 模式（供远程 Agent 接入）
node mcp/server.js --http 3010
```

会话（设备指纹 + 登录态）自动持久化到 `data/.mcp_session.json`，服务重启后无需重新扫码登录。

## Agent 接入配置

### Claude Code（项目级 `.mcp.json`）

```json
{
  "mcpServers": {
    "kugou-music": {
      "command": "node",
      "args": ["/path/to/KuGouMusicApi/mcp/server.js"]
    }
  }
}
```

### Claude Desktop（`claude_desktop_config.json`）

```json
{
  "mcpServers": {
    "kugou-music": {
      "command": "node",
      "args": ["/path/to/KuGouMusicApi/mcp/server.js"]
    }
  }
}
```

### 通用 MCP Client（远程 HTTP）

API 服务在线部署时端点与服务同址（推荐）；本地独立 HTTP 模式则监听 3010：

```bash
# 独立模式（备选）
node mcp/server.js --http 3010
# MCP endpoint: http://localhost:3010/mcp  （POST，Streamable HTTP）
```

## 登录方式

| 工具 | 说明 |
|---|---|
| `kugou_login_qr` | 生成酷狗 App 扫码二维码（返回终端 ASCII 二维码 + base64 图片） |
| `kugou_login_qr_check` | 轮询扫码状态（1 待扫码 / 2 待确认 / 4 成功，成功自动保存会话） |
| `kugou_login_wx` / `kugou_login_wx_check` | 微信扫码登录（依赖内置微信开放平台凭证，失败时改用 App 扫码） |
| `kugou_login_concept` / `kugou_login_concept_check` | **概念版**微信扫码登录（概念版 VIP 下载与签到的必要登录，见下文「概念版 VIP」） |
| `kugou_login_status` | 查询登录态与用户资料（含概念版 VIP 概况） |
| `kugou_logout` | 退出登录（同时清除标准版与概念版登录态，保留设备指纹） |

推荐流程：`kugou_login_qr` → 把 ASCII 二维码展示给用户 → 循环 `kugou_login_qr_check`（建议间隔 2-3 秒）→ status=4 即登录成功。

## 概念版 VIP（重要）

酷狗概念版（青春版）的「听歌/看广告领 VIP」是**业务线隔离**的会员：

- 只对**概念版身份**（appid=3116 + 概念版 token）的请求生效；标准版登录（含同一账号）拿不到其下载权限，服务端以 `is_vip=0` 拒绝。
- 概念版 token 与标准版 token **互不兼容**（标准版 token 走概念版请求会报 `20018 token api error`），因此 MCP 单独维护一套概念版会话（`data/.mcp_session_lite.json`），由内部以 `platform=lite` 运行的工作进程承载。
- 账号级 `vip_type` 不体现概念版 VIP，须看 `busi_type="concept"` 的业务 VIP 条目（svip 即音乐会员，附每日 500 首下载额度）。

因此要使用概念版 VIP 下载歌曲，只需：

```
kugou_login_concept → 用户微信扫码 → kugou_login_concept_check(uuid) 至 concept_logged_in=true
→ 之后 kugou_sign_in 每日签到领 VIP
→ kugou_get_song_url / kugou_download_song 自动走概念版通道（返回 identity="concept"、priv_status=1）
```

签到机制（`kugou_sign_in`）：

- 看广告任务：每日上限 8 次，每次 +3 小时 VIP（`ad_times` 参数控制，默认 1）；
- 领取当日听歌 VIP（北京时间自然日；`131001` = 今日已领取，常见于用户已在手机端领取）；
- 领取升级奖励（当日 VIP 升为 24 小时；`297002` = 今日已领取过）。

## 工具总览

### 概念版 VIP
- `kugou_sign_in` — 签到领取概念版 VIP（看广告任务 + 领取当日 VIP + 升级奖励），需概念版登录
- `kugou_vip_status` — 概念版 VIP 有效期、每日下载额度、今日是否已领取、近 7 天领取记录

### 搜索
- `kugou_search` — 统一搜索：song（默认）/ mv / album / artist / lyric
- `kugou_search_hot` — 实时热搜榜
- `kugou_search_suggest` — 关键词联想

### 排行榜
- `kugou_get_rank_list` — 全部榜单索引（约 50 个，附每榜前 3 首预览）
- `kugou_get_rank_songs` — 单榜完整歌曲（分页，如 TOP500）

### 歌曲播放与信息
- `kugou_get_song_url` — 多音质播放/下载直链（128/320/flac/high/蝰蛇音质）。概念版登录后自动走概念版通道（概念版 VIP 生效，`identity="concept"`），否则走标准版通道
- `kugou_get_song_info` — 各音质可用性、大小与所需会员类型
- `kugou_get_lyric` — 一步获取带时间轴歌词（LRC）或逐字歌词（KRC）
- `kugou_get_similar_songs` — 按歌曲找相似歌曲

### 评论
- `kugou_get_song_comments` — 歌曲评论（热门在前，分页）
- `kugou_send_comment` — 发表歌曲评论（需登录，内容公开可见）

### 歌单与收藏（需登录）
- `kugou_get_user_playlists` — 我的全部歌单（自动标注默认收藏夹）
- `kugou_get_playlist_tracks` — 歌单曲目（`listid="favorite"` 简写默认收藏夹）
- `kugou_favorite_song` / `kugou_unfavorite_song` — 收藏 / 取消收藏歌曲（自动定位默认收藏夹；取消收藏使用 v3 端点的最新 fileid）
- `kugou_playlist_add_songs` / `kugou_playlist_remove_songs` — 歌单增删歌曲
- `kugou_create_playlist` / `kugou_delete_playlist` — 新建 / 删除（取消收藏）歌单
- `kugou_get_playlist_detail` — 歌单元信息（listid 自动换算 global_collection_id，支持他人歌单）
- `kugou_update_playlist` — 改名/简介/标签/排序号（版本号自动代查）
- `kugou_sort_playlist_tracks` — 歌单内歌曲自定义排序（可用于“我喜欢”）

### 云盘（需登录）
- `kugou_get_cloud_songs` — 分页列出云盘音乐（含删除用 `fileid`/kv_id、取直链用 `hash`）
- `kugou_get_cloud_song_url` — 云盘音乐播放/下载直链（云盘文件不受曲库版权限制）
- `kugou_delete_cloud_songs` — 删除云盘音乐（不可恢复，支持批量）
- `kugou_cloud_match` — 上传前按文件 MD5 匹配曲库（`hash_std`/`audio_id`/`album_audio_id`）
- `kugou_upload_cloud_song` — 上传音乐到云盘（`file_path` 服务端本地路径或 `file_base64`，默认自动匹配曲库）

### MV
- `kugou_get_mv_url` — MV 播放/下载地址
- `kugou_collect_mv` / `kugou_uncollect_mv` — MV 收藏管理（需登录）

### 歌手 / 专辑
- `kugou_get_artist_info` — 资料 / 热门歌曲 / 专辑列表
- `kugou_follow_artist` / `kugou_unfollow_artist` — 关注管理（需登录）
- `kugou_get_album_info` — 专辑详情 / 曲目

### 本地下载
- `kugou_download_song` — 拉取直链并保存音频文件（默认 `./downloads`，可指定音质）
- `kugou_download_lyric` — 歌词保存为 `.lrc` 文件

### 个人数据（需登录）
- `kugou_get_play_history` — 听歌排行（播放次数 + 最后播放日期，bp 游标翻页）
- `kugou_get_purchased_songs` / `kugou_get_purchased_albums` — 已购单曲 / 专辑

### 推荐（需登录）
- `kugou_get_recommend_songs` — 每日推荐
- `kugou_get_personal_fm` — 私人 FM

## 典型 Agent 对话流

```
用户：帮我搜一下海阔天空，下载 128k 的，再把歌词存下来
Agent: kugou_search(keywords="海阔天空", type="song")
     → 取第一首的 hash / album_id / album_audio_id
     → kugou_download_song(hash=..., name="BEYOND - 海阔天空", quality="128")
     → kugou_download_lyric(hash=..., name="BEYOND - 海阔天空")

用户：把这首歌收藏了
Agent: kugou_login_status() → 未登录 → kugou_login_qr() 展示二维码
     → kugou_login_qr_check(key) 轮询至 status=4
     → kugou_favorite_song(name="海阔天空", hash=..., album_id=..., album_audio_id=...)

用户：取消收藏
Agent: kugou_unfavorite_song(hash=...)

用户：帮我签到领个 VIP，然后把这首会员歌下载成无损
Agent: kugou_vip_status() → concept_logged_in=false
     → kugou_login_concept() 展示微信二维码 → kugou_login_concept_check(uuid) 轮询至 concept_logged_in=true
     → kugou_sign_in()（ad_times=1，领取当日 VIP + 升级奖励）
     → kugou_get_song_url(hash=..., quality="flac") 确认 identity="concept"、priv_status=1
     → kugou_download_song(hash=..., name=..., quality="flac")
```

## 注意事项

1. **风控**：同一 IP 高频调用 `song_url` 等播放链路接口可能触发酷狗风控（返回"本次请求需要验证"）。MCP 已内置稳定设备指纹降低触发率；触发后等待几分钟重试即可。
2. **VIP 歌曲**：未登录或非会员获取 VIP 歌曲时只能拿到试听片段（约 60 秒），工具返回中会明确标注。概念版 VIP 用户须登录概念版（`kugou_login_concept`）后由概念版通道下载——标准版登录同一账号也无法使用概念版 VIP 权限（业务线隔离，详见上文「概念版 VIP」）。
3. **微信登录**：依赖项目内置的微信开放平台 appid/secret，若微信侧凭证失效会报错，此时改用酷狗 App 扫码（`kugou_login_qr`）。
4. **已知上游问题**：`/search/complex` 与 `/search/mixed` 两个聚合搜索接口在酷狗服务端已失效（上游仓库同样失效），MCP 的 `kugou_search` 通过按类型分别搜索规避了该问题。
