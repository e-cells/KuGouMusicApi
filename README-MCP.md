# KuGouMusicApi MCP 服务

面向大模型 Agent 的酷狗音乐工具服务（[Model Context Protocol](https://modelcontextprotocol.io)）。基于本项目编程式 API 进程内调用，提供登录、搜索、播放/下载直链、歌词、歌单与收藏管理、MV、歌手/专辑、本地下载等 31 个工具，用于构建智能音乐助手。

## 快速开始

```bash
# 安装依赖（Node 18+）
npm install

# 启动（stdio 模式，供本地 Agent 接入）
node mcp/server.js

# 或 HTTP 模式（供远程 Agent 接入）
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
      "args": ["E:/05-Claude Code/09-KuGouMusicApi/mcp/server.js"]
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
      "args": ["E:/05-Claude Code/09-KuGouMusicApi/mcp/server.js"]
    }
  }
}
```

### 通用 MCP Client（HTTP 模式）

```bash
node mcp/server.js --http 3010
# MCP endpoint: http://localhost:3010/mcp  （POST，Streamable HTTP）
```

## 登录方式

| 工具 | 说明 |
|---|---|
| `kugou_login_qr` | 生成酷狗 App 扫码二维码（返回终端 ASCII 二维码 + base64 图片） |
| `kugou_login_qr_check` | 轮询扫码状态（1 待扫码 / 2 待确认 / 4 成功，成功自动保存会话） |
| `kugou_login_wx` / `kugou_login_wx_check` | 微信扫码登录（依赖内置微信开放平台凭证，失败时改用 App 扫码） |
| `kugou_login_status` | 查询登录态与用户资料 |
| `kugou_logout` | 退出登录（保留设备指纹） |

推荐流程：`kugou_login_qr` → 把 ASCII 二维码展示给用户 → 循环 `kugou_login_qr_check`（建议间隔 2-3 秒）→ status=4 即登录成功。

## 工具总览

### 搜索
- `kugou_search` — 统一搜索：song（默认）/ mv / album / artist / lyric
- `kugou_search_hot` — 实时热搜榜
- `kugou_search_suggest` — 关键词联想

### 歌曲播放与信息
- `kugou_get_song_url` — 多音质播放/下载直链（128/320/flac/high/蝰蛇音质；VIP 曲目需登录会员）
- `kugou_get_song_info` — 各音质可用性、大小与所需会员类型
- `kugou_get_lyric` — 一步获取带时间轴歌词（LRC）或逐字歌词（KRC）

### 歌单与收藏（需登录）
- `kugou_get_user_playlists` — 我的全部歌单（自动标注默认收藏夹）
- `kugou_get_playlist_tracks` — 歌单曲目（`listid="favorite"` 简写默认收藏夹）
- `kugou_favorite_song` / `kugou_unfavorite_song` — 收藏 / 取消收藏歌曲（自动定位默认收藏夹；取消收藏使用 v3 端点的最新 fileid）
- `kugou_playlist_add_songs` / `kugou_playlist_remove_songs` — 歌单增删歌曲
- `kugou_create_playlist` / `kugou_delete_playlist` — 新建 / 删除（取消收藏）歌单

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
```

## 注意事项

1. **风控**：同一 IP 高频调用 `song_url` 等播放链路接口可能触发酷狗风控（返回"本次请求需要验证"）。MCP 已内置稳定设备指纹降低触发率；触发后等待几分钟重试即可。
2. **VIP 歌曲**：未登录或非会员获取 VIP 歌曲时只能拿到试听片段（约 60 秒），工具返回中会明确标注。
3. **微信登录**：依赖项目内置的微信开放平台 appid/secret，若微信侧凭证失效会报错，此时改用酷狗 App 扫码（`kugou_login_qr`）。
4. **已知上游问题**：`/search/complex` 与 `/search/mixed` 两个聚合搜索接口在酷狗服务端已失效（上游仓库同样失效），MCP 的 `kugou_search` 通过按类型分别搜索规避了该问题。
