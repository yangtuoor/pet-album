# 宠物图册 + 故事册

日系治愈风的单页站点：照片与视频上传、按拍摄时间自动排序、卡片集/时间线双视图故事册、整册导出为单文件 HTML。
零第三方依赖，只用一个 Node 服务 + 对象存储（可选 Cloudflare R2）或本地文件夹存数据。

## 目录

```
pet-album/
  server.js          零依赖 HTTP 服务：静态托管 + /api/* + EXIF 解析 + ffmpeg 缩略图 + HTML 导出
  r2.js              零依赖的 AWS SigV4 签名 + R2 读写（未配置 R2_* 环境变量时自动降级到本地磁盘）
  build.js           把 public/ 内联成单文件 dist/index.html（双击可看效果，无后端）
  public/index.html  页面结构
  public/styles.css  全部样式与动效
  public/app.js      全部前端逻辑
  public/admin.html  后台管理页（含登录门）
  dist/index.html    构建产物，跑 node build.js 生成
  .env.example       环境变量样例
  data/              本地数据目录：pet.json / media.json / stories.json / admin.json / media/ / music/ / export/
```

## 本地运行

```bash
cp .env.example .env        # 填自己的口令与（可选）R2 密钥
node server.js
# 默认 http://localhost:8899 ，数据写入 ./data
```

环境变量：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PET_PORT` | `8899` | 端口，可写多个用逗号分隔，如 `8099,18099` |
| `PET_HOST` | `0.0.0.0` | 监听地址 |
| `PET_DATA_DIR` | `./data` | 数据目录 |
| `PET_BASE` | 空 | 反向代理前缀，如 `/pet` |
| `PET_ADMIN_PASSWORD` | 随机 | 首次启动时的后台初始口令 |
| `PET_ADMIN_PATH` | `admin` | 后台页面路径，建议换成一串随机字符 |
| `PET_TRUST_PROXY` | `0` | 置 1 时信任 `X-Forwarded-For`，只有真在反向代理后面才开 |
| `PET_IMAGE_MAX_BYTES` | `2097152` | 单张图片压到这个字节数以内 |

## 后台

浏览器打开 `/admin`，输入口令进入。可以改站点标题、首屏大标题与副标题、宠物资料，指定首屏三张叠放卡片和圆形头像用哪张照片，上传/删除照片视频，增删改故事，改口令，导出整册。

口令不存在 `pet.json` 里，单独放在数据目录的 `admin.json`，内容是加盐哈希 + 会话签名密钥，不会随任何接口下发。首次启动时如果没有这个文件，会生成一次性口令并打印在启动日志里，也可以直接用 `PET_ADMIN_PASSWORD` 环境变量指定初始口令。登录成功后下发一个 HttpOnly 的 `pet_admin` Cookie，有效期七天；改口令会轮换签名密钥，所有旧会话立即失效。同一 IP 连续五次口令错误会锁十分钟，正确口令永远放行，本机或已登录会话可以调解锁接口清掉计数。

忘记口令就删掉数据目录里的 `admin.json` 并重启服务。

## 接口

所有写接口都需要登录 Cookie，未登录返回 401；`/api/bootstrap` 和 `/api/base` 是公开只读。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/bootstrap` | 一次性返回宠物信息、媒体列表、故事列表 |
| POST | `/api/admin/login` | `{"password":"..."}`，成功后下发会话 Cookie |
| POST | `/api/admin/logout` | 清除会话 |
| GET | `/api/admin/status` | `{"authed":true/false}` |
| POST | `/api/admin/unlock` | 清掉当前 IP 的失败计数 |
| POST | `/api/admin/password` | 改口令，需已登录 |
| POST | `/api/upload` | multipart，字段名 `files`，支持多文件图片/视频 |
| POST | `/api/pet` | 站点标题、宠物资料、首屏四图、背景音乐设置（部分字段合并）|
| POST | `/api/media` | 批量改媒体属性，或 `{"ids":[...],"delete":true}` 批量删除 |
| POST | `/api/stories` | 新建故事 |
| PATCH/DELETE | `/api/stories/:id` | 改 / 删单个故事 |
| POST | `/api/export` | 生成单文件 HTML，返回下载地址 |
| GET | `/files/*` | 媒体与导出文件 |

`pet.json` 里新增的 `hero` 字段控制首屏：`{"cards":[id,id,id],"avatar":id,"fixed":true}`，`fixed` 为 false 时首屏自动取最新三张照片。

## 存储：R2 或本地磁盘

配了下面这些环境变量，图片视频就存 Cloudflare R2，本地只留缩略图和视频封面；没配就存在 `data/media/`。

| 变量 | 说明 |
| --- | --- |
| `R2_ACCOUNT_ID` | 账号 ID |
| `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | S3 API 令牌 |
| `R2_BUCKET` | 桶名 |
| `R2_PUBLIC_BASE` | 公开访问域名，如 `https://pub-xxxx.r2.dev` |
| `R2_REGION` | 默认 `auto` |

上传流程：原图先落临时目录，读 EXIF 和尺寸，然后用 ffmpeg 压成长边 2000 / Q5 的 JPEG，超过 `PET_IMAGE_MAX_BYTES` 就依次降质量再降尺寸，四档之内几乎不会触发；压缩结果 PUT 到 R2 的 `media/<id>.jpg`，临时文件立刻删掉。视频原片直传 R2，封面抽第一帧 `media/<id>_poster.jpg` 留本地。

`/api/bootstrap` 返回的每个条目都带着算好的 `src`、`thumbSrc`、`posterSrc` 绝对地址，前端不需要自己拼路径。

## 排序规则

拍摄时间优先（EXIF `DateTimeOriginal` → `DateTime` → `DateTimeDigitized`），缺失时退回文件修改时间，再退回上传时间。
视频的拍摄时间取容器里的 `creation_time`，宽高和时长由 ffprobe 读。
EXIF 时间没有时区，按服务器本地时区解释后再转成 UTC 存进 `media.json`。
时间线视图按年/月分组，图册支持杂志流、时间线、九宫格三种视图。

## 关于缩略图与视频封面

需要本机有 `ffmpeg` 和 `ffprobe`。启动日志会打印 `ffmpeg=true/false`。
没有 ffmpeg 时缩略图退回原图、视频卡显示渐变占位而不是黑块。

## 部署

复制一份 `.env.example` 成 `.env` 填好，systemd unit 里用 `EnvironmentFile=` 引入，`WorkingDirectory` 指向本目录，`PET_DATA_DIR` 指到一个独立的数据目录（比如 `/var/lib/pet-album`），这样代码目录可以随时覆盖更新而不碰数据。

本地改完 `public/*` 或 `server.js` 后，上传到对应位置并 `systemctl restart`。
改完前端记得跑一次 `node build.js` 同步 `dist/index.html`。

## 许可

MIT
