# KuGouMusicApi — Bug 修复 + MCP 智能音乐助手服务 开发计划

> 制定日期：2026-10-23
> 目标：修复「取消音乐收藏不生效」等 Bug（对齐上游 v1.6.2），并开发 MCP 服务供大模型 Agent 调用。
>
> **✅ 执行状态（2026-10-23 完成全部三阶段）**
> - 阶段一：✅ 取消收藏修复（v3 端点）、✅ util 层同步、✅ 13 模块同步、✅ 75 新模块引入（共 236）、✅ 文档同步、✅ 冒烟回归通过；额外修复 search_lyric（man 默认值）与 register_dev（解密崩溃保护）
> - 阶段二：✅ mcp/（session.js + tools.js + server.js）、31 个工具、stdio + HTTP 双传输、README-MCP.md、.mcp.json
> - 阶段三：✅ MCP 握手/工具列表/真实调用验证（搜索/热搜/歌词/MV/专辑/歌手/微信登录二维码均实测通过）；音频直链下载因测试期间 IP 触发酷狗临时风控，待风控解除后复验（已安排自动重试）

---

## 一、问题定位结论（已完成调研）

### 1. 取消音乐收藏不生效 —— 根因已定位
- **调用链**：客户端先调 `/playlist/track/all/new` 拿歌单内歌曲的 `fileid`，再调 `/playlist/tracks/del?listid=X&fileids=Y` 取消收藏。
- **根因**：本地 `module/playlist_track_all_new.js` 仍请求旧端点 `/v4/get_list_all_file`（pagesize 默认 30）。酷狗服务端该端点已停更，返回的 `fileid` 与当前云端歌单不一致，导致删除请求「成功返回但实际不生效」。
- **上游修复**：2026-09-14 PR #269 已升级为 `/v4/get_list_all_file_v3`（App 云歌单当前使用端点，pagesize 默认 300、支持 type/page）。

### 2. 本地 fork 与上游的差距
| 维度 | 本地 (v1.5.1, 2026-06 快照) | 上游 (v1.6.2, 2026-10-18) |
|---|---|---|
| 模块数 | 141 | ~230（新增 MV收藏、评论发表/删除、用户关注、云盘上传、一起听、听歌偏好等） |
| util/request.js | 无云歌单加密协议 | 新增 `createCloudRequest`（cloudlist AES+RSA 协议，歌单排序/改封面依赖） |
| 播放链路 | song_url_new 直连 tracker 域名 | 2026-10-18 修复：统一走 gateway + x-router（PR #288） |
| 登录 | 缺 dev 参数回传 | login/login_qr_check 补 `KUGOU_API_DEV`（滑块验证链路） |
| 搜索 | 旧 v1 端点 | v2 `/v2/search/song` + 概念版(lite)适配 |

本地保留的定制（**不覆盖**）：多用户 Cookie 隔离、限流、/admin 管理台、听歌识曲 raw body、SSA 模拟指纹。

---

## 二、阶段一：Bug 修复与上游同步（MCP 开发前置）

1. **[P0] 取消收藏修复**：`playlist_track_all_new.js` 升级 v3 端点。
2. **[P0] util 层同步**：
   - `util/request.js`：新增 `createCloudRequest`、`clearDefaultHeaders` 选项、web 签名纳入请求体、状态码赋值时序修正；
   - `util/helper.js`：`signatureWebParams(params, data)`；
   - `util/util.js`：新增 `isUUIDv4`；
   - `util/config.json`：补 `qq_appid` / `qq_lite_appid`；
   - `util/index.js`：导出上述新增项。
3. **[P1] 模块层同步（13 个差异文件）**：song_url_new（gateway+x-router）、login / login_qr_check（dev 参数）、login_device_kick（token 加密重写）、personal_fm（cur_mark）、comment_music（CMT_VER）、search / search_mixed（v2 端点 + lite 适配）、privilege_lite（重写：音质/会员判定）、user_follow_message（私信 tag）、top_card_youth、youth_day_vip。
4. **[P1] 全量引入上游新增模块**（纯增量，路由自动注册，低风险）。
5. **[P2] 同步 `interface.d.ts` 与 `docs/README.md`**（新增接口文档）。
6. **验证**：`npm install` + 启动 + 冒烟测试（search / lyric / rank / song_url 等免登录接口）。

## 三、阶段二：MCP 服务开发（智能音乐助手）

### 架构
- 新增 `mcp/` 目录：`mcp/server.js`（入口）、`mcp/tools.js`（工具注册表）、`mcp/session.js`（会话管理）。
- 基于本项目 `main.js` 编程式 API（进程内调用，无需走 HTTP）。
- 传输：默认 **stdio**（本地 Agent 标准接入）；`--http :3010` 可选 HTTP 流式传输（供远程 Agent）。
- 会话：登录成功后自动保存 cookie 到 `data/.mcp_session.json`，重启免登录；`login_status` 随时校验。

### 工具清单（面向大模型，参数结构化、返回精简）
| 分组 | 工具 | 说明 |
|---|---|---|
| 登录 | `login_qr_create` | 生成酷狗 App 扫码登录二维码（终端可显示 ASCII QR） |
| | `login_qr_check` | 轮询扫码状态，成功自动保存会话 |
| | `login_wx_create` / `login_wx_check` | 微信扫码登录 |
| | `login_status` | 查询当前登录用户信息（含 VIP 状态） |
| 搜索 | `search` | 统一搜索：song / lyric / mv / album / artist |
| | `search_hot` / `search_suggest` | 热搜 / 联想 |
| 歌曲 | `get_song_url` | 获取播放/下载直链（多音质：128k~flac~hi-res） |
| | `get_song_info` | 音质可用性 / 版权 / 会员判定 |
| | `get_lyric` | 歌词（krc 解码为带时间轴文本 / lrc） |
| 歌单 | `get_user_playlists` | 我的歌单（含默认收藏夹） |
| | `get_playlist_tracks` | 歌单内全部歌曲（v3 端点，含 fileid） |
| | `favorite_song` / `unfavorite_song` | 收藏 / 取消收藏（自动定位默认收藏夹） |
| | `add_to_playlist` / `remove_from_playlist` | 歌单增删歌曲 |
| | `create_playlist` / `delete_playlist` | 新建(收藏) / 删除(取消收藏) 歌单 |
| MV | `get_mv_detail` / `get_mv_url` | MV 详情 / 播放下载地址 |
| | `collect_mv` / `uncollect_mv` | MV 收藏管理 |
| 歌手/专辑 | `get_artist_detail` / `get_artist_songs` / `get_album_songs` | 资料与歌曲 |
| | `follow_artist` / `unfollow_artist` | 关注管理 |
| 下载 | `download_song` | 拉取直链并保存到本地（返回文件路径与大小） |
| | `download_lyric` | 歌词保存为 .lrc 文件 |
| 推荐 | `get_recommend_songs` / `get_personal_fm` | 每日推荐 / 私人FM |

### 交付物
- `mcp/` 源码 + `README-MCP.md`（接入文档）+ `.mcp.json` 示例（Claude Code / 通用 MCP Client 配置）。

## 四、阶段三：验证
1. 启动原 HTTP 服务，回归冒烟（免登录接口）。
2. `npx @modelcontextprotocol/inspector` 或直接 stdio 握手验证 MCP 工具列表与调用。
3. 真实调用 `search` / `get_song_url` / `get_lyric` / `get_mv_url` 等验证返回。
4. 登录链路做逻辑核对（真实扫码需用户配合，文档中说明操作步骤）。

---

## 执行顺序
阶段一（1→2→3→4→5→6）→ 阶段二（session → tools → server → 文档）→ 阶段三验证。
