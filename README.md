# KuGouMusic API

酷狗音乐 NodeJS 版 API

[![](https://img.shields.io/badge/Author-MakcRe-blueviolet?style=for-the-badge '作者')](https://github.com/MakcRe)
![](https://img.shields.io/badge/dynamic/json?label=GitHub%20Followers&style=for-the-badge&query=%24.data.totalSubs&url=https%3A%2F%2Fapi.spencerwoo.com%2Fsubstats%2F%3Fsource%3Dgithub%26queryKey%3DMakcRe&labelColor=282c34&color=181717&logo=github&longCache=true '关注数量')
![](https://img.shields.io/github/stars/MakcRe/KuGouMusicApi.svg?style=for-the-badge&label=Star 'Star数量')
![](https://img.shields.io/github/forks/MakcRe/KuGouMusicApi.svg?style=for-the-badge&label=Fork 'Fork数量')
![](https://img.shields.io/github/issues/MakcRe/KuGouMusicApi.svg?style=for-the-badge&label=Issues 'Issues数量')
![](https://img.shields.io/github/contributors/MakcRe/KuGouMusicApi?style=for-the-badge '贡献者')
![](https://img.shields.io/github/repo-size/MakcRe/KuGouMusicApi?style=for-the-badge&label=files&color=cf8ef4&labelColor=373e4dl '文件大小')
![](https://img.shields.io/github/languages/code-size/MakcRe/KuGouMusicApi?color=blueviolet&style=for-the-badge '代码大小')

[//]: # '<br>'

![](https://img.shields.io/github/package-json/v/MakcRe/KuGouMusicApi?longCache=true&style=for-the-badge)
![](https://img.shields.io/badge/Node-12+-green.svg?longCache=true&style=for-the-badge)
![](https://img.shields.io/badge/License-mit-blue.svg?longCache=true&style=for-the-badge)

## 复刻于

[MakcRe/KuGouMusicApi](https://github.com/MakcRe/KuGouMusicApi)

## 环境要求

需要 NodeJS 12+ 环境

## 工作原理

跨站请求伪造 (CSRF), 伪造请求头 , 调用官方 API

## 免责声明

> 1. 本项目仅供学习使用，请尊重版权，请勿利用此项目从事商业行为及非法用途!
> 2. 使用本项目的过程中可能会产生版权数据。对于这些版权数据，本项目不拥有它们的所有权。为了避免侵权，使用者务必在 24 小时内清除使用本项目的过程中所产生的版权数据。
> 3. 由于使用本项目产生的包括由于本协议或由于使用或无法使用本项目而引起的任何性质的任何直接、间接、特殊、偶然或结果性损害（包括但不限于因商誉损失、停工、计算机故障或故障引起的损害赔偿，或任何及所有其他商业损害或损失）由使用者负责。
> 4. **禁止在违反当地法律法规的情况下使用本项目。** 对于使用者在明知或不知当地法律法规不允许的情况下使用本项目所造成的任何违法违规行为由使用者承担，本项目不承担由此造成的任何直接、间接、特殊、偶然或结果性责任。
> 5. 音乐平台不易，请尊重版权，支持正版。
> 6. 本项目仅用于对技术可行性的探索及研究，不接受任何商业（包括但不限于广告等）合作及捐赠。
> 7. 如果官方音乐平台觉得本项目不妥，可联系本项目更改或移除。

---

## 🔥 本版增强特性 (多用户共用不串号)

本版本在原版基础上进行了深度的架构重构与安全加固，特别适合**多用户共用、车机挂载、长期部署**等复杂生产场景：

* 🛡️ **多用户数据隔离与防掉签**：彻底抛弃全局单一特征码，改用由用户 Token 动态派生专属设备 ID。完美实现千人千面，彻底解决服务端重启导致的 VIP 掉签及多人串号问题。
* 🖥️ **可视化 Web 管理控制台**：内置轻量级管理面板（支持秒级自动更新），可实时监控所有连接设备的 GUID 标识、真实公网 IP 地址、秒级在线/离线状态以及**真实的酷狗中文用户昵称**（后端内置数据智能嗅探与解码拦截器）。
* 🔒 **安全白名单与防盗用机制**：支持一键切换“无限制模式”与“仅白名单模式”，强力拦截非法或未授权设备的 API 调用。加入白名单的信任设备将获得缓存豁免权，永久保持在线连接状态。
* 🚦 **接口限流与防雪崩 (防封杀)**：集成 `express-rate-limit` 中间件，提供登录接口独立限流防护（防密码暴力破解）与全局防刷机制（防封服务器出口 IP）。
* ⚡ **弱网熔断假死保护**：Axios 网络层强制加入 10 秒超时熔断机制，防止弱网环境导致 Node.js 异步连接堆积与进程死锁。
* 🧹 **自愈与防内存泄漏**：后台定时清洁工自动清理长久未活跃的普通访客记录（白名单设备自动豁免）和过期凭证，结合本地硬盘 `.admin_devices.json` 持久化记忆，保障服务长年累月跑在 Docker/云服务器中也稳如泰山。
* 🤖 **MCP 智能体服务**：内置 [Model Context Protocol](https://modelcontextprotocol.io) 服务（31 个工具），支持 Claude Code / Claude Desktop 等 AI Agent 直接搜索、下载、播放、收藏歌曲与管理歌单，扫码登录态自动持久化，详见下方「MCP 服务」章节。

---

### 安装

```
$ git clone git@github.com:MakcRe/KuGouMusicApi.git$ cd KuGouMusicApi
$ npm install
```

使用接口为概念版
Plaintext
复制 .env.example 为 .env，并且把里面的 `platform=''` 改为 `platform=lite`
注意不同版本的平台的 token 是不通用的。
运行
```

$ npm run dev
```

服务器启动默认端口为 3000, 若不想使用 3000 端口 , 可使用以下命令 : Mac/Linux  

```

$ PORT=4000 npm run dev
```
windows 下使用 git-bash 或者 cmder 等终端执行以下命令 :  

```
$ set PORT=4000 && npm run dev
```
windows 下使用 PowerShell 等终端执行以下命令 :  

```
$ $Env:PORT=4000; npm run dev
```

服务器启动默认 host 为 localhost,如果需要更改, 可使用以下命令 : Mac/Linux  

```
$ HOST=127.0.0.1 npm run dev

```
windows 下使用 git-bash 或者 cmder 等终端执行以下命令 :  

```
$ set HOST=127.0.0.1 && npm run dev
```

windows 下使用 PowerShell 等终端执行以下命令 :  

```
$ $Env:HOST=127.0.0.1; npm run dev
```
🖥️ 增强功能：管理控制台使用指南
访问控制台：服务成功启动后，在浏览器访问 http://localhost:3000/admin.html;
端口和 IP 请根据实际运行环境替换，支持公网域名映射。

初始化设置：首次进入系统时，会自动检测运行环境。您需要设置管理员账号与密码以完成控制台的初始化。

安全模式切换：

无限制模式：所有设备均可自由连接并拉取音乐。

仅白名单模式：只有在控制台中被管理员手动点击“允许访问”加白名单的设备才可以成功使用接口，未加白设备将全部被阻断并返回 403 Forbidden。

访客指纹消除技术：系统内嵌“智能特征指纹算法”，自动合并未登录用户在轮询扫码或拉取公开列表时产生的随机垃圾设备记录。一台设备未登录前无论发起多少次请求，在控制台列表中只会显示唯一一条“访客在线”记录。

退出登录：系统支持标准的 Session 管理，点击右上角“退出登录”按钮可立即销毁本地管理员凭证，防止账号在公共网络或车机端暴露。

## 🤖 MCP 服务（AI Agent 接入）

内置 [Model Context Protocol](https://modelcontextprotocol.io) 服务，让 Claude Code、Claude Desktop、Cursor 等 AI Agent 直接调用酷狗音乐能力：搜索、播放/下载直链、歌词、歌单与收藏管理、MV、歌手/专辑、每日推荐等 31 个工具。

### 快速启动

```bash
# stdio 模式（本地 Agent 接入）
npm run mcp

# HTTP 模式（远程 Agent 接入，端口 3010）
npm run mcp:http
```

会话（设备指纹 + 登录态）自动持久化到 `data/.mcp_session.json`，服务重启后无需重新扫码登录。

### Agent 接入配置

Claude Code（项目根目录 `.mcp.json`）或 Claude Desktop（`claude_desktop_config.json`）：

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

HTTP 模式接入端点：`http://localhost:3010/mcp`（POST，Streamable HTTP）。

### 扫码登录流程

`kugou_login_qr` 生成二维码（终端 ASCII + base64 图片）→ 每隔 2-3 秒调用 `kugou_login_qr_check` 轮询（status=4 即成功，自动保存会话）→ `kugou_login_status` 随时查询登录态与用户资料。也支持微信扫码（`kugou_login_wx`）。

### 工具总览

| 类别 | 工具 |
|---|---|
| 搜索 | `kugou_search`（song/mv/album/artist/lyric）、`kugou_search_hot` 热搜、`kugou_search_suggest` 联想 |
| 播放/信息 | `kugou_get_song_url` 多音质直链（128/320/flac/蝰蛇）、`kugou_get_song_info`、`kugou_get_lyric`（LRC/逐字 KRC） |
| 歌单/收藏（需登录） | `kugou_get_user_playlists`、`kugou_get_playlist_tracks`、`kugou_favorite_song` / `kugou_unfavorite_song`、`kugou_playlist_add_songs` / `kugou_playlist_remove_songs`、`kugou_create_playlist` / `kugou_delete_playlist` |
| MV | `kugou_get_mv_url`、`kugou_collect_mv` / `kugou_uncollect_mv` |
| 歌手/专辑 | `kugou_get_artist_info`、`kugou_follow_artist` / `kugou_unfollow_artist`、`kugou_get_album_info` |
| 本地下载 | `kugou_download_song`（默认存 `./downloads`，可指定音质）、`kugou_download_lyric`（存 `.lrc`） |
| 推荐（需登录） | `kugou_get_recommend_songs` 每日推荐、`kugou_get_personal_fm` 私人 FM |

### 示例对话流

```
用户：帮我搜一下海阔天空，下载 128k 的，歌词也存下来
Agent: kugou_search(keywords="海阔天空") → 取第一首 hash
     → kugou_download_song(quality="128") → kugou_download_lyric

用户：把这首歌收藏了
Agent: kugou_login_status() → 未登录则 kugou_login_qr() 扫码 → kugou_favorite_song(...)
```

完整工具说明、参数细节与风控注意事项见 [README-MCP.md](README-MCP.md)。

Docker 容器化长效运行部署
如果您使用 docker-compose 进行常年累月的挂载运行，建议直接在 docker-compose.yml 中使用 Docker 原生日志轮转规则。无需修改代码，即可将容器日志大小死锁在 10M 以内，彻底根绝硬盘空间泄漏。

修改您的 docker-compose.yml：
```
YAML
version: '3.8'
services:
  kugou-api:
    image: hly307765464/kugou-music-api:latest
    container_name: kugou-music-api
    restart: unless-stopped
    environment:
      - platform=lite
    ports:
      - "8542:3000"
    logging:
      driver: "json-file"
      options:
        max-size: "10m"   # 限制单个日志文件最大为 10M
        max-file: "3"     # 当超过10M时自动切割，最多保留最新的3个文件（超出的旧日志自动清理）
```
部署并应用日志配置：

```
$ docker compose up -d
```
代理配置
如需通过 HTTP 代理请求酷狗接口，可在启动前设置 KUGOU_API_PROXY 环境变量，例如:

```
$ $Env:KUGOU_API_PROXY='[http://127.0.0.1:7890](http://127.0.0.1:7890)'; npm run dev
```
也可以在启动命令后追加代理参数:

```
$ node app.js --proxy=[http://127.0.0.1:7890](http://127.0.0.1:7890)
```
Vercel 部署
操作方法
fork 此项目  

在 Vercel 官网点击 New Project

点击 Import Git Repository 并选择你 fork 的此项目并点击 import

点击 PERSONAL ACCOUNT 的 select

直接点 Continue

若需要部署版本为概念版（不需要该步骤可以跳过），在 Environment Variables 添加 key 为 platform，Value (Will Be Encrypted) 为 lite 然后点击 Add

PROJECT NAME自己填,FRAMEWORK PRESET 选 Other 然后直接点 Deploy 接着等部署完成即可

### 功能特性
- 登录

- 刷新登录

- 发送验证码

- dfid 获取

- 获取用户额外信息

- 获取用户 vip 信息

- 获取用户歌单

- 获取用户关注歌手

- 获取用户听歌历史排行

- 获取用户最近听歌历史

- 获取继续播放信息（对应手机版首页显示继续播放入口）

- 收藏歌单/新建歌单

- 取消收藏歌单/删除歌单

- 对歌单添加歌曲

- 对歌单删除歌曲

- 新碟上架

- 专辑信息

- 专辑详情

- 专辑音乐列表

- 获取音乐 URL

- 获取歌曲高潮部分

- 搜索

- 默认搜索关键词

- 综合搜索

- 热搜列表

- 搜索建议

- 歌词搜索

- 获取歌词

- 歌单分类

- 歌单

- 主题歌单

- 音效歌单

- 获取歌单详情

- 获取歌单所有歌曲

- 获取歌单所有歌曲（新版）

- 相似歌单

- 获取主题歌单所有歌曲

- 获取主题音乐

- 获取主题音乐详情

- 歌曲推荐

- 获取歌手和专辑图片

- 获取歌手图片

- 获取音乐相关信息

- 获取更多音乐版本

- 获取音乐伴奏信息

- 获取音乐 k 歌数量

- 获取音乐详情

- 获取音乐专辑/歌手信息

- 私人 FM(对应手机和 pc 端的猜你喜欢)

- banner

- 乐库 banner

- 乐库电台

- 乐库

- 电台 - 推荐

- 电台

- 电台 - 图片

- 电台 - 音乐列表

- 编辑精选

- 编辑精选数据

- 编辑精选歌单

- 编辑精选专区

- 编辑精选专区详情

- 领取 VIP（需要登陆，该接口为测试接口）

- 获取歌手列表

- 获取歌手详情

- 获取歌手专辑

- 获取歌手单曲

- 获取歌手 MV

- 关注歌手

- 取消关注歌手

- 获取关注歌手新歌

- 获取视频 url

- 获取歌曲 MV

- 获取视频相关信息

- 获取视频详情

- 新歌速递

- 场景音乐列表

- 场景音乐详情

- 获取场景音乐讨论区

- 获取场景音乐模块 Tag

- 获取场景音乐歌单列表

- 获取场景音乐视频列表

- 获取场景音乐音乐列表

- 每日推荐

- 历史推荐

- 风格推荐

- 排行列表

- 排行榜推荐列表

- 排行榜往期列表

- 排行榜信息

- 排行榜歌曲列表

- 歌曲评论

- 歌曲评论-根据分类返回

- 歌曲评论-根据热词返回

- 楼层评论

- 歌单评论

- 专辑评论

- 歌曲曲谱

- 曲谱详情

- 推荐曲谱

- 曲谱合集

- 曲谱合集详情

- 提交听歌历史

- 获取服务器时间

- 刷刷

- AI 推荐

- 频道 - 获取用户所有频道

- 频道 - 详情

- 频道 - 频道安利

- 频道 - 相似频道

- 频道 - 订阅

- 频道 - 音乐故事

- 频道 - 音乐故事详情

- 动态 - 最常访问

- 获取用户公开的音乐

- 听书 - 每日推荐

- 听书 - 排行榜推荐

- 听书 - VIP 推荐

- 听书 - 每周推荐

- 听书 - 专辑详情

- 听书 - 专辑音乐列表

- 歌曲详情 - 歌曲成绩单

- 歌曲详情 - 歌曲成绩单详情

### License
  
- The MIT License (MIT)
