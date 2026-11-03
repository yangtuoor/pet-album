#!/usr/bin/env node
/*
 * 毛毛的小角落 — 宠物图册 / 故事册
 * 零依赖 Node 服务：静态托管 + 媒体上传 + EXIF 拍摄时间解析 + 故事册 + 单文件 HTML 导出
 * 数据目录（默认 ./data）：
 *   data/pet.json      站点与宠物信息
 *   data/media.json    媒体索引
 *   data/stories.json  故事索引
 *   data/media/        原图 / 视频 + 缩略图
 *   data/music/        背景音乐
 *   data/export/       导出的 HTML
 */
'use strict';

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const DATA = process.env.PET_DATA_DIR ? path.resolve(process.env.PET_DATA_DIR) : path.join(ROOT, 'data');
const D = {
  pet: path.join(DATA, 'pet.json'),
  media: path.join(DATA, 'media.json'),
  stories: path.join(DATA, 'stories.json'),
  mediaDir: path.join(DATA, 'media'),
  musicDir: path.join(DATA, 'music'),
  exportDir: path.join(DATA, 'export'),
  tmp: path.join(DATA, '.tmp'),
};
const PORT = Number(process.env.PET_PORT || 8899);
const HOST = process.env.PET_HOST || '0.0.0.0';
const BASE = process.env.PET_BASE || ''; // 可为 '/pet' 之类的反向代理前缀
const MAX_UPLOAD = Number(process.env.PET_MAX_UPLOAD || 1024 * 1024 * 1024); // 1GB

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif', '.bmp', '.heic', '.heif']);
const VIDEO_EXT = new Set(['.mp4', '.webm', '.mov', '.m4v', '.ogv', '.mkv', '.avi']);
const AUDIO_EXT = new Set(['.mp3', '.m4a', '.aac', '.ogg', '.wav', '.flac']);

const uid = () => crypto.randomBytes(9).toString('hex');
const nowISO = () => new Date().toISOString();
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));

/* ------------------------------------------------------------------ 存储 */

async function ensureDirs() {
  for (const d of [DATA, D.mediaDir, D.musicDir, D.exportDir, D.tmp]) {
    await fsp.mkdir(d, { recursive: true });
  }
}

const DEFAULT_PET = {
  siteTitle: '毛毛的小角落',
  tagline: '一只小动物，和它留在这个世界上的所有轻软时刻。',
  pet: {
    name: '毛毛',
    species: '狗',
    breed: '',
    birthday: '',
    homeDate: '',
    bio: '',
    avatar: null,
  },
  // 首屏手动指定：三张叠放卡 + 圆形头像，值为媒体 id 或 'media/xxx.jpg' 路径；
  // 留空则退回「自动取最新三张」
  hero: { cards: [null, null, null], avatar: null, fixed: false },
  music: { track: null, enabled: true, volume: 0.35 },
  theme: 'healing',
  updatedAt: nowISO(),
};

/* --------------------------------------------------------------- 后台鉴权 */
// 口令单独放一个文件，不进 pet.json，也不会随 bootstrap 下发
const AUTH_FILE = () => path.join(DATA, 'admin.json');

function hashToken(secret, salt, s) {
  return crypto.createHmac('sha256', secret).update(salt + '|' + s).digest('hex');
}
function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

let authCache = null;
async function getAuth() {
  if (authCache) return authCache;
  let a = await readJSON(AUTH_FILE(), null);
  if (!a || !a.passHash) {
    const initial = process.env.PET_ADMIN_PASSWORD || crypto.randomBytes(6).toString('hex');
    const salt = crypto.randomBytes(16).toString('hex');
    a = {
      salt,
      passHash: hashToken(initial, salt, initial),
      secret: crypto.randomBytes(32).toString('hex'),
      createdAt: nowISO(),
    };
    await writeJSON(AUTH_FILE(), a);
    console.log('[pet-album] 后台口令已初始化：' + initial);
    console.log('[pet-album] 请登录 /admin 后立即修改，或用 PET_ADMIN_PASSWORD 环境变量指定');
  }
  authCache = a;
  return a;
}
function makeSession(a, ttlMs) {
  const exp = Date.now() + ttlMs;
  const payload = String(exp);
  const sig = crypto.createHmac('sha256', a.secret).update(payload).digest('hex');
  return payload + '.' + sig;
}
function verifySession(a, token) {
  if (!token || typeof token !== 'string') return false;
  const i = token.indexOf('.');
  if (i < 0) return false;
  const payload = token.slice(0, i);
  const sig = token.slice(i + 1);
  const exp = Number(payload);
  if (!Number.isFinite(exp) || exp < Date.now()) return false;
  const want = crypto.createHmac('sha256', a.secret).update(payload).digest('hex');
  return safeEqual(sig, want);
}
function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  raw.split(';').forEach((pair) => {
    const i = pair.indexOf('=');
    if (i < 0) return;
    out[pair.slice(0, i).trim()] = decodeURIComponent(pair.slice(i + 1).trim());
  });
  return out;
}
// 登录失败节流：同一 IP 连续 5 次错误锁 10 分钟
const loginFails = new Map();
const FAIL_MAX = 5;
const FAIL_WINDOW = 10 * 60 * 1000;
// 只有真的挂了反向代理才信任 X-Forwarded-For，否则客户端可以随意伪造头绕过节流
const TRUST_PROXY = process.env.PET_TRUST_PROXY === '1';
// 管理后台独立入口（默认 /admin），可用 PET_ADMIN_PATH 改名
const ADMIN_PATH = '/' + (process.env.PET_ADMIN_PATH || 'admin').replace(/^\/+|\/+$/g, '');
const ADMIN_PAGE = '/' + (process.env.PET_ADMIN_PATH || 'admin').replace(/^\/+|\/+$/g, '') + '.html';
function clientIP(req) {
  if (TRUST_PROXY) {
    const xff = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (xff) return xff;
  }
  return (req.socket.remoteAddress || 'unknown').replace(/^::ffff:/, '');
}
function pruneFails() {
  const now = Date.now();
  for (const [ip, rec] of loginFails) {
    if (now - rec.last > FAIL_WINDOW) loginFails.delete(ip);
  }
}
function loginLocked(ip) {
  pruneFails();
  const rec = loginFails.get(ip);
  if (!rec) return 0;
  if (rec.count >= FAIL_MAX) return Math.max(0, FAIL_WINDOW - (Date.now() - rec.last));
  return 0;
}
// 后台口令正确时用来把「解锁」按钮打通：带管理员口令 POST 过来即清空本 IP 的失败计数
function clearFail(ip) { loginFails.delete(ip); }

const SESSION_COOKIE = 'pet_admin';
const SESSION_TTL = 7 * 24 * 3600 * 1000;
// 公开只读接口：主站浏览不需要登录
const PUBLIC_API = new Set(['/api/bootstrap', '/api/base']);

async function isAuthorized(req) {
  const a = await getAuth();
  return verifySession(a, parseCookies(req)[SESSION_COOKIE]);
}

// 串行写队列：避免并发写同一个 json 造成截断
const writeQueue = new Map();
function writeJSON(file, obj) {
  const prev = writeQueue.get(file) || Promise.resolve();
  const next = prev
    .catch(() => {})
    .then(async () => {
      const tmp = file + '.' + uid() + '.tmp';
      await fsp.writeFile(tmp, JSON.stringify(obj, null, 2), 'utf8');
      await fsp.rename(tmp, file);
    });
  writeQueue.set(file, next);
  return next;
}

async function readJSON(file, fallback) {
  try {
    const s = await fsp.readFile(file, 'utf8');
    return JSON.parse(s);
  } catch (e) {
    return fallback;
  }
}

async function getPet() {
  const p = await readJSON(D.pet, null);
  if (!p) return JSON.parse(JSON.stringify(DEFAULT_PET));
  const merged = { ...JSON.parse(JSON.stringify(DEFAULT_PET)), ...p };
  // hero 用深合并：老数据里可能没有新增的字段（cards/avatar/fixed），不能让它们整块丢失
  merged.hero = { ...DEFAULT_PET.hero, ...(p.hero || {}) };
  merged.pet = { ...DEFAULT_PET.pet, ...(p.pet || {}) };
  merged.music = { ...DEFAULT_PET.music, ...(p.music || {}) };
  return merged;
}
const getMedia = async () => readJSON(D.media, { items: [] });
const getStories = async () => readJSON(D.stories, { items: [] });
const saveMedia = (m) => writeJSON(D.media, m);
const saveStories = (s) => writeJSON(D.stories, s);

/* ------------------------------------------------------------------ EXIF */

// 从 JPEG 的 APP1 段解析拍摄时间（DateTimeOriginal 优先，其次 DateTime）
const EXIF_SIG = Buffer.from([0x45, 0x78, 0x69, 0x66, 0x00, 0x00]);
function readJpegExifDate(buf) {
  const out = {};
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return out;
  let off = 2;
  while (off + 4 <= buf.length) {
    if (buf[off] !== 0xff) { off++; continue; }
    const marker = buf[off + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { off += 2; continue; }
    if (marker === 0xda || marker === 0xd9) break;
    const size = buf.readUInt16BE(off + 2);
    if (marker === 0xe1 && size >= 8) {
      const seg = buf.subarray(off + 4, off + 2 + size);
      const sig = seg.subarray(0, 6);
      // EXIF APP1 的签名是 "Exif\0\0"；同时按字节比较，避免 latin1 与 \0 转义差异
      if (sig.equals(EXIF_SIG)) {
        try { Object.assign(out, parseTiff(seg.subarray(6))); } catch (_) {}
      }
    }
    off += 2 + size;
  }
  return out;
}

function parseTiff(t) {
  const res = {};
  if (t.length < 8) return res;
  const le = t.toString('latin1', 0, 2) === 'II';
  const u16 = (o) => (le ? t.readUInt16LE(o) : t.readUInt16BE(o));
  const u32 = (o) => (le ? t.readUInt32LE(o) : t.readUInt32BE(o));
  if (u16(2) !== 42) return res;
  const ifd0 = u32(4);
  const readTag = (ifdOff, tag) => {
    if (ifdOff <= 0 || ifdOff + 2 > t.length) return null;
    const n = u16(ifdOff);
    for (let i = 0; i < n; i++) {
      const e = ifdOff + 2 + i * 12;
      if (e + 12 > t.length) break;
      if (u16(e) === tag) {
        const type = u16(e + 2);
        const count = u32(e + 4);
        const size = type === 3 ? 2 : type === 4 ? 4 : type === 5 ? 8 : 1;
        const total = size * count;
        const vo = total <= 4 ? e + 8 : u32(e + 8);
        return { type, count, vo, total };
      }
    }
    return null;
  };
  const readAscii = (rec) => {
    if (!rec || rec.vo + rec.total > t.length) return null;
    return t.toString('latin1', rec.vo, rec.vo + rec.total).replace(/\0+$/, '').trim();
  };
  const readRational = (rec) => {
    if (!rec || rec.vo + 8 > t.length) return null;
    const num = u32(rec.vo), den = u32(rec.vo + 4);
    return den ? num / den : null;
  };
  const readRationals = (rec, k) => {
    const arr = [];
    for (let i = 0; i < k; i++) {
      const o = rec.vo + i * 8;
      if (o + 8 > t.length) break;
      const num = u32(o), den = u32(o + 4);
      arr.push(den ? num / den : null);
    }
    return arr;
  };
  const readShort = (rec) => {
    if (!rec) return null;
    if (rec.total <= 4) return le ? t.readUInt16LE(rec.vo) : t.readUInt16BE(rec.vo);
    return u16(rec.vo);
  };

  const readIfdPtr = (ifdOff, tag) => {
    if (ifdOff <= 0 || ifdOff + 2 > t.length) return null;
    const n = u16(ifdOff);
    if (n > 512) return null;
    for (let i = 0; i < n; i++) {
      const e = ifdOff + 2 + i * 12;
      if (e + 12 > t.length) break;
      if (u16(e) === tag) {
        const type = u16(e + 2);
        if (type !== 4 && type !== 13) return null;
        // 指针必须按整数读；readAscii 会把 4 字节当字符串处理，得到错误偏移
        return u32(e + 8);
      }
    }
    return null;
  };
  const exifPtr = readIfdPtr(ifd0, 0x8769);
  if (exifPtr && exifPtr + 2 <= t.length) {
    const subIfd = exifPtr;
    const d1 = readAscii(readTag(subIfd, 0x9003));
    const d2 = readAscii(readTag(subIfd, 0x9004));
    if (d1) res.dateOriginal = d1;
    if (d2) res.dateDigitized = d2;
  }
  const gpsPtr = readIfdPtr(ifd0, 0x8825);
  if (gpsPtr && gpsPtr + 2 <= t.length) {
    const g = gpsPtr;
    const latRef = readAscii(readTag(g, 1));
    const latV = readRationals(readTag(g, 2) || { vo: 0 }, 3);
    const lonRef = readAscii(readTag(g, 3));
    const lonV = readRationals(readTag(g, 4) || { vo: 0 }, 3);
    const dms = (v) => (v && v.length === 3 && v.every((x) => typeof x === 'number')) ? v[0] + v[1] / 60 + v[2] / 3600 : null;
    const la = dms(latV), lo = dms(lonV);
    if (la !== null && lo !== null) {
      res.gps = {
        lat: latRef === 'S' ? -la : la,
        lon: lonRef === 'W' ? -lo : lo,
      };
    }
  }
  const dt = readAscii(readTag(ifd0, 0x0132));
  if (dt) res.dateTime = dt;
  const orient = readShort(readTag(ifd0, 0x0112));
  if (orient) res.orientation = orient;
  const make = readAscii(readTag(ifd0, 0x010f));
  const model = readAscii(readTag(ifd0, 0x0110));
  if (make) res.make = make;
  if (model) res.model = model;
  if (res.gps) res.hasGps = true;
  return res;
}

// EXIF 里的时间没有时区，按「相机本地时间」解释：
// 容器本身是 UTC，用 setUTC* 写入，读出时再减掉本地时区偏移，
// 这样东八区拍的 14:30 不会变成 06:30，西半球也不会跨日。
function exifStringToISO(s) {
  if (!s) return null;
  const m = /^(\d{4})[:\-](\d{2})[:\-](\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(s);
  if (!m) return null;
  const [, y, mo, d, h, mi, se] = m;
  // 坏数据（相机没设时间时常见 0000:00:00）直接丢掉，别造出 1899 年
  if (Number(y) < 1971) return null;
  const dt = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(se)));
  if (isNaN(dt.getTime())) return null;
  return new Date(dt.getTime() - new Date(dt.getTime()).getTimezoneOffset() * 60000).toISOString();
}

function pngOrWebpDate(buf, ext) {
  try {
    if (ext === '.png' && buf.length > 8) {
      const len = buf.readUInt32BE(8);
      const type = buf.toString('latin1', 12, 16);
      if (type === 'IHDR') {
        const chunkLen = buf.readUInt32BE(8);
        const type2 = buf.toString('latin1', 12, 16);
        // 找 tEXt 里的 Creation Time
        let p = 8;
        while (p + 12 < buf.length) {
          const l = buf.readUInt32BE(p);
          const t = buf.toString('latin1', p + 4, p + 8);
          if (t === 'tEXt') {
            const txt = buf.toString('latin1', p + 8, p + 8 + l);
            const mm = /Creation Time\0(.+)/.exec(txt);
            if (mm) return { dateTime: mm[1].trim() };
          }
          p += 12 + l;
          if (l === 0xffffffff) break;
        }
      }
    }
    if (ext === '.webp' && buf.toString('latin1', 12, 16) === 'VP8X') {
      // 只读取 RIFF 内 EXIF 块
      const exif = buf.indexOf('EXIF');
      if (exif > 0) {
        const tiffStart = exif + 8; // 'EXIF' + size(4)
        const sz = buf.readUInt32LE(exif + 4);
        const seg = buf.subarray(tiffStart, tiffStart + sz);
        const wrap = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0, 0]), seg]);
        return parseTiff(seg);
      }
    }
  } catch (_) {}
  return {};
}

async function probeMeta(file, ext) {
  const meta = { exifDate: null, exif: {}, width: null, height: null };
  const fh = await fsp.open(file, 'r');
  try {
    const st = await fh.stat();
    const head = Buffer.alloc(Math.min(st.size, 256 * 1024));
    await fh.read(head, 0, head.length, 0);
    if (ext === '.jpg' || ext === '.jpeg' || ext === '.heic' || ext === '.heif') {
      const ex = readJpegExifDate(head);
      meta.exif = ex;
      meta.exifDate = exifStringToISO(ex.dateOriginal || ex.dateTime || ex.dateDigitized);
    } else if (ext === '.png' || ext === '.webp') {
      const ex = pngOrWebpDate(head, ext);
      meta.exif = ex || {};
      meta.exifDate = exifStringToISO(ex.dateTime || ex.dateOriginal);
    }
    // 尺寸：JPEG SOF / PNG IHDR / GIF
    if (ext === '.png' && head.length > 24) {
      meta.width = head.readUInt32BE(16);
      meta.height = head.readUInt32BE(20);
    } else if (ext === '.gif' && head.length > 10) {
      meta.width = head.readUInt16LE(6);
      meta.height = head.readUInt16LE(8);
    } else if ((ext === '.jpg' || ext === '.jpeg') ) {
      let p = 2;
      while (p + 9 < head.length) {
        if (head[p] !== 0xff) { p++; continue; }
        const mk = head[p + 1];
        if (mk >= 0xc0 && mk <= 0xcf && mk !== 0xc4 && mk !== 0xc8 && mk !== 0xcc) {
          meta.height = head.readUInt16BE(p + 5);
          meta.width = head.readUInt16BE(p + 7);
          break;
        }
        const size = head.readUInt16BE(p + 2);
        if (!size) break;
        p += 2 + size;
      }
    } else if (ext === '.webp' && head.toString('latin1', 12, 16) === 'VP8 ' && head.length > 30) {
      meta.width = head.readUInt16LE(26) & 0x3fff;
      meta.height = head.readUInt16LE(28) & 0x3fff;
    }
  } catch (_) {
  } finally {
    await fh.close();
  }
  // 视频：容器里的尺寸/时长/创建时间统一交给 ffprobe，
  // 自己解 mp4 的 moov 太脆（mov/mkv/webm 的 box 布局都不一样）
  if (VIDEO_EXT.has(ext)) {
    const v = await probeVideo(file);
    if (v) {
      meta.width = v.width;
      meta.height = v.height;
      meta.duration = v.duration;
      if (v.createdAt) {
        meta.exif = { ...(meta.exif || {}), dateTime: v.createdAt };
        meta.exifDate = exifStringToISO(v.createdAt);
      }
    }
  }
  return meta;
}

/** 用 ffprobe 读视频的宽高、时长、创建时间；ffprobe 缺失时返回 null */
async function probeVideo(file) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    let cp;
    try {
      cp = require('child_process').spawn(
        'ffprobe',
        ['-v', 'error', '-select_streams', 'v:0',
          '-show_entries', 'stream=width,height,duration:format=duration:format_tags=creation_time:stream_tags=creation_time',
          '-of', 'json', file],
        { stdio: ['ignore', 'pipe', 'ignore'] }
      );
    } catch (_) {
      return finish(null);
    }
    let out = '';
    cp.stdout.on('data', (d) => { out += d.toString('utf8'); if (out.length > 65536) cp.kill(); });
    cp.on('error', () => finish(null));
    cp.on('close', () => {
      try {
        const j = JSON.parse(out);
        const st = (j.streams && j.streams[0]) || {};
        const fmt = j.format || {};
        const ct = (fmt.tags && fmt.tags.creation_time) || (st.tags && st.tags.creation_time) || null;
        // creation_time 是 ISO8601 UTC（2026-01-02T03:04:05.000000Z），转成 EXIF 风格本地串
        let created = null;
        if (ct) {
          const d = new Date(ct);
          if (!isNaN(d.getTime()) && d.getUTCFullYear() > 1971) {
            const p2 = (n) => String(n).padStart(2, '0');
            created = `${d.getUTCFullYear()}:${p2(d.getUTCMonth() + 1)}:${p2(d.getUTCDate())} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}`;
          }
        }
        const dur = Number(st.duration || fmt.duration || 0) || null;
        finish({
          width: Number(st.width) || null,
          height: Number(st.height) || null,
          duration: dur ? Math.round(dur * 10) / 10 : null,
          createdAt: created,
        });
      } catch (_) { finish(null); }
    });
  });
}

/* ------------------------------------------------------------------ 缩略图（纯 JS 解码） */

function readJpegSize(buf) {
  let p = 2;
  while (p + 9 < buf.length) {
    if (buf[p] !== 0xff) { p++; continue; }
    const mk = buf[p + 1];
    if (mk >= 0xc0 && mk <= 0xcf && mk !== 0xc4 && mk !== 0xc8 && mk !== 0xcc) {
      return { height: buf.readUInt16BE(p + 5), width: buf.readUInt16BE(p + 7) };
    }
    const size = buf.readUInt16BE(p + 2);
    if (!size) break;
    p += 2 + size;
  }
  return null;
}

// 借用浏览器端 OffscreenCanvas 无法在服务端使用，这里用 ffmpeg 生成缩略图；
// 若无 ffmpeg，前端会退化为直接使用原图（懒加载仍生效）
async function makeThumb(src, dest, maxSide) {
  return new Promise((resolve) => {
    const cp = require('child_process').spawn(
      'ffmpeg',
      ['-y', '-loglevel', 'error', '-i', src, '-vf', `scale='min(${maxSide},iw)':-2`, '-frames:v', '1', '-q:v', '4', dest],
      { stdio: 'ignore' }
    );
    cp.on('error', () => resolve(false));
    cp.on('exit', (code) => resolve(code === 0 && fs.existsSync(dest)));
  });
}

async function makeVideoPoster(src, dest, maxSide) {
  return new Promise((resolve) => {
    const cp = require('child_process').spawn(
      'ffmpeg',
      ['-y', '-loglevel', 'error', '-ss', '00:00:00.3', '-i', src, '-frames:v', '1', '-vf', `scale='min(${maxSide},iw)':-2`, '-q:v', '4', dest],
      { stdio: 'ignore' }
    );
    let settled = false;
    const finish = (ok) => { if (!settled) { settled = true; resolve(ok); } };
    cp.on('error', () => finish(false));
    cp.on('close', (code) => {
      const ok = code === 0 && fs.existsSync(dest) && fs.statSync(dest).size > 0;
      finish(ok);
    });
  });
}

/* ------------------------------------------------------------------ 存储：R2 或本地磁盘 */

// R2 配置文件在项目根，和 server.js 同级
let R2;
try { R2 = require('./r2.js'); } catch (_) { R2 = { enabled: false }; }
const r2on = () => !!(R2 && R2.enabled);

// 单张图片压到 2MB 以内：先长边 2000 + q5，仍超标就降质量、再降尺寸
const IMG_MAX_BYTES = Number(process.env.PET_IMAGE_MAX_BYTES || 2 * 1024 * 1024);
const IMG_STEPS = [
  { max: 2000, q: 5 },
  { max: 2000, q: 7 },
  { max: 1800, q: 8 },
  { max: 1600, q: 10 },
  { max: 1400, q: 12 },
];

/**
 * 用 ffmpeg 压一张图，输出 JPEG。
 * @returns {Promise<{ok:boolean,size:number,width:number,height:number,step:object}>}
 */
async function compressImage(src, dest, steps = IMG_STEPS) {
  for (const step of steps) {
    const ok = await new Promise((resolve) => {
      const cp = require('child_process').spawn(
        'ffmpeg',
        ['-y', '-loglevel', 'error', '-i', src, '-vf', `scale='min(${step.max},iw)':-2`,
         '-frames:v', '1', '-q:v', String(step.q), '-f', 'mjpeg', dest],
        { stdio: 'ignore' }
      );
      cp.on('error', () => resolve(false));
      cp.on('exit', (code) => resolve(code === 0 && fs.existsSync(dest)));
    });
    if (!ok) continue;
    const size = (await fsp.stat(dest)).size;
    if (size <= IMG_MAX_BYTES) {
      const dim = await probeMeta(dest, '.jpg');
      return { ok: true, size, width: dim.width, height: dim.height, step };
    }
  }
  // 所有档位都超标（极少见），返回最后一档结果，前端仍能用
  try {
    const size = (await fsp.stat(dest)).size;
    const dim = await probeMeta(dest, '.jpg');
    return { ok: true, size, width: dim.width, height: dim.height, step: steps[steps.length - 1], over: true };
  } catch (_) {
    return { ok: false };
  }
}

/** 把二进制写进 R2（key 如 media/im_xxx.jpg），失败抛错 */
async function r2Put(key, buf, contentType) {
  if (!r2on()) throw new Error('R2 未配置');
  return R2.put(key, buf, contentType);
}

async function r2Del(key) {
  if (!r2on() || !key) return false;
  return R2.del(String(key).replace(/^\/+/, ''));
}

/** 媒体对象的公开 URL：R2 开着就用 R2，否则回退本地 /files/ 路径 */
function mediaURL(file) {
  if (!file) return null;
  if (/^https?:\/\//.test(file)) return file;
  if (r2on()) {
    const u = R2.url(file.replace(/^\/+/, ''));
    if (u) return u;
  }
  return BASE + '/files/' + file;
}

/** 给前端用的 item 副本：把 file/thumb/poster 换成可直接 <img src> 的 URL */
function publicItem(it) {
  return {
    ...it,
    file: it.file,
    src: mediaURL(it.file),
    thumbSrc: it.thumb ? mediaURL(it.thumb) : null,
    posterSrc: it.poster ? thumbPathOf(it, 'poster') : null,
  };
}

// 缩略图与封面始终留在本地（小、要快），只给个本地路径即可
function thumbPathOf(it, field) {
  const v = it[field];
  if (!v) return null;
  if (/^https?:\/\//.test(v)) return v;
  return BASE + '/files/' + v;
}

/* ------------------------------------------------------------------ 多部分表单 */

function parseMultipart(buf, boundary) {
  const parts = [];
  const delim = Buffer.from('--' + boundary);
  let start = buf.indexOf(delim);
  if (start < 0) return parts;
  start += delim.length;
  while (true) {
    // 结束标记 --
    if (buf[start] === 0x2d && buf[start + 1] === 0x2d) break;
    if (buf[start] === 0x0d) start += 2;
    const headEnd = buf.indexOf('\r\n\r\n', start);
    if (headEnd < 0) break;
    const headerText = buf.toString('utf8', start, headEnd);
    const bodyStart = headEnd + 4;
    const next = buf.indexOf(delim, bodyStart);
    if (next < 0) break;
    let bodyEnd = next;
    if (buf[bodyEnd - 2] === 0x0d && buf[bodyEnd - 1] === 0x0a) bodyEnd -= 2;
    const headers = {};
    for (const line of headerText.split('\r\n')) {
      const i = line.indexOf(':');
      if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
    }
    const disp = headers['content-disposition'] || '';
    const nameM = /name="([^"]*)"/.exec(disp);
    const fileM = /filename="([^"]*)"/.exec(disp);
    parts.push({
      name: nameM ? nameM[1] : '',
      filename: fileM ? fileM[1] : null,
      headers,
      data: buf.subarray(bodyStart, bodyEnd),
    });
    start = next + delim.length;
  }
  return parts;
}

function decodeFilename(s) {
  if (!s) return 'file';
  try { return decodeURIComponent(s); } catch (_) { return s; }
}

/* ------------------------------------------------------------------ HTTP 工具 */

function send(res, status, body, headers) {
  const h = { 'X-Content-Type-Options': 'nosniff', ...headers };
  res.writeHead(status, h);
  res.end(body);
}
const sendJSON = (res, status, obj) =>
  send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (c) => {
      total += c.length;
      if (total > limit) {
        reject(Object.assign(new Error('too large'), { code: 'LIMIT' }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.m4v': 'video/mp4',
  '.ogv': 'video/ogg',
  '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

async function serveFile(req, res, file, { cache = 'public, max-age=86400' } = {}) {
  let st;
  try { st = await fsp.stat(file); } catch (_) { return send(res, 404, 'Not Found', { 'Content-Type': 'text/plain' }); }
  if (!st.isFile()) return send(res, 404, 'Not Found', { 'Content-Type': 'text/plain' });
  const ext = path.extname(file).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';
  const etag = `W/"${st.size.toString(16)}-${st.mtimeMs.toString(16)}"`;
  if (req.headers['if-none-match'] === etag) return send(res, 304, '');
  const range = req.headers.range;
  const baseHeaders = { 'Content-Type': type, 'Accept-Ranges': 'bytes', ETag: etag, 'Cache-Control': cache };
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    let start = m && m[1] ? parseInt(m[1], 10) : 0;
    let end = m && m[2] ? parseInt(m[2], 10) : st.size - 1;
    if (isNaN(start) || isNaN(end) || start > end || start >= st.size) {
      return send(res, 416, '', { 'Content-Range': `bytes */${st.size}` });
    }
    end = Math.min(end, st.size - 1);
    res.writeHead(206, { ...baseHeaders, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
    fs.createReadStream(file, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, { ...baseHeaders, 'Content-Length': st.size });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
}

/* ------------------------------------------------------------------ 业务：媒体 */

function sortKey(item) {
  // 拍摄时间优先，缺失退回上传时间
  const t = item.takenAt || item.uploadedAt;
  const v = t ? Date.parse(t) : 0;
  return isNaN(v) ? 0 : v;
}

function sortItems(items) {
  return items.slice().sort((a, b) => {
    const d = sortKey(a) - sortKey(b);
    if (d !== 0) return d;
    return (a.uploadedAt || '').localeCompare(b.uploadedAt || '');
  });
}

/** 媒体条目骨架：字段顺序固定，方便人读 media.json */
function baseItem(o) {
  return {
    id: o.id,
    type: o.type,
    file: o.file,
    originalName: o.originalName,
    size: o.size,
    width: o.width || null,
    height: o.height || null,
    duration: o.type === 'video' && o.duration ? o.duration : null,
    takenAt: o.takenAt || null,
    takenAtSource: o.takenAt ? 'exif' : null,
    uploadedAt: o.uploadedAt,
    fileModifiedAt: o.uploadedAt,
    title: '',
    note: o.note || '',
    tags: [],
    favorite: false,
    exif: o.meta && o.meta.exif && Object.keys(o.meta.exif).length ? o.meta.exif : null,
    thumb: null,
    poster: null,
    sortIndex: null,
  };
}

async function handleUpload(req, res) {
  const ct = req.headers['content-type'] || '';
  const bm = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(ct);
  if (!ct.startsWith('multipart/form-data') || !bm) {
    return sendJSON(res, 400, { error: '需要 multipart/form-data' });
  }
  const boundary = bm[1] || bm[2];
  let buf;
  try {
    buf = await readBody(req, MAX_UPLOAD);
  } catch (e) {
    if (e.code === 'LIMIT') return sendJSON(res, 413, { error: '文件过大' });
    return sendJSON(res, 400, { error: '读取失败' });
  }
  const parts = parseMultipart(buf, boundary);
  const files = parts.filter((p) => p.filename !== null);
  if (!files.length) return sendJSON(res, 400, { error: '没有收到文件' });
  const kindHint = parts.find((p) => p.name === 'kind' && p.filename === null);
  const kind = kindHint ? kindHint.data.toString('utf8').trim() : 'auto';

  const media = await getMedia();
  const pet = await getPet();
  const created = [];
  for (const f of files) {
    const original = decodeFilename(f.filename);
    const ext = path.extname(original).toLowerCase();
    let type = null;
    if (IMAGE_EXT.has(ext)) type = 'image';
    else if (VIDEO_EXT.has(ext)) type = 'video';
    else if (AUDIO_EXT.has(ext) && kind === 'music') type = 'audio';
    else if (AUDIO_EXT.has(ext)) type = 'audio';
    if (!type) continue;

    if (type === 'audio') {
      const id = 'au_' + uid();
      const name = id + ext;
      await fsp.writeFile(path.join(D.musicDir, name), f.data);
      pet.music = { ...(pet.music || {}), track: 'music/' + name, originalName: original };
      continue;
    }

    const id = (type === 'image' ? 'im_' : 'vd_') + uid();

    // 原图先落到临时目录（只为读 EXIF / 尺寸 / 转码），处理完立刻删掉，
    // 磁盘上不留原图 —— 正式文件全部进 R2
    const tmpIn = path.join(D.tmp, id + '_in' + ext);
    await fsp.writeFile(tmpIn, f.data);

    // EXIF 与尺寸从「原图」读，压缩后 EXIF 就丢了
    const meta = await probeMeta(tmpIn, ext);
    const uploadedAt = nowISO();
    const takenAt = meta.exifDate;

    let item = null;
    try {
      if (type === 'image') {
        // R2 模式下压成 JPEG（长边 2000 / q5，超 2MB 自动降档）；
        // 本地模式保持原样，方便调试
        if (r2on()) {
          const outName = id + '.jpg';
          const tmpOut = path.join(D.tmp, outName);
          const cmp = await compressImage(tmpIn, tmpOut);
          if (cmp.ok) {
            const buf = await fsp.readFile(tmpOut);
            const key = 'media/' + outName;
            await r2Put(key, buf, 'image/jpeg');
            item = baseItem({
              id, type, file: key, originalName: original, size: buf.length,
              width: cmp.width, height: cmp.height,
              takenAt, uploadedAt, meta,
              note: cmp.over ? '压缩后仍超过 2MB（最后一档）' : '',
            });
            await fsp.unlink(tmpOut).catch(() => {});
            // 缩略图仍放本地，列表滚动时不必回源 R2
            const t = id + '.jpg';
            if (await makeThumb(tmpIn, path.join(D.mediaDir, t + '.thumb'), 720)) {
              item.thumb = 'media/' + t + '.thumb';
            }
          } else {
            // 压不动（罕见的格式），退回原图直传
            const key = 'media/' + id + ext;
            await r2Put(key, f.data, MIME[ext] || 'application/octet-stream');
            item = baseItem({
              id, type, file: key, originalName: original, size: f.data.length,
              width: meta.width, height: meta.height, takenAt, uploadedAt, meta, note: '原图直传（未能压缩）',
            });
          }
        } else {
          const relName = id + ext;
          await fsp.rename(tmpIn, path.join(D.mediaDir, relName)).catch(async () => {
            await fsp.copyFile(tmpIn, path.join(D.mediaDir, relName));
          });
          item = baseItem({
            id, type, file: 'media/' + relName, originalName: original, size: f.data.length,
            width: meta.width, height: meta.height, takenAt, uploadedAt, meta,
          });
          const t = id + '.jpg';
          if (await makeThumb(path.join(D.mediaDir, relName), path.join(D.mediaDir, t), 720)) item.thumb = 'media/' + t;
        }
      } else {
        // 视频：原片进 R2，封面（第一帧）留本地
        const relName = id + ext;
        if (r2on()) {
          const key = 'media/' + relName;
          await r2Put(key, f.data, MIME[ext] || 'video/mp4');
          item = baseItem({
            id, type, file: key, originalName: original, size: f.data.length,
            width: meta.width, height: meta.height, duration: meta.duration, takenAt, uploadedAt, meta,
          });
          const p = id + '_poster.jpg';
          if (await makeVideoPoster(tmpIn, path.join(D.mediaDir, p), 720)) item.poster = 'media/' + p;
        } else {
          await fsp.rename(tmpIn, path.join(D.mediaDir, relName)).catch(async () => {
            await fsp.copyFile(tmpIn, path.join(D.mediaDir, relName));
          });
          item = baseItem({
            id, type, file: 'media/' + relName, originalName: original, size: f.data.length,
            width: meta.width, height: meta.height, duration: meta.duration, takenAt, uploadedAt, meta,
          });
          const p = id + '_poster.jpg';
          if (await makeVideoPoster(path.join(D.mediaDir, relName), path.join(D.mediaDir, p), 720)) item.poster = 'media/' + p;
        }
      }
    } finally {
      await fsp.unlink(tmpIn).catch(() => {});
    }

    if (!item) continue;
    created.push(item);
    media.items.push(item);
  }
  await writeJSON(D.pet, { ...pet, updatedAt: nowISO() });
  await saveMedia({ ...media, items: sortItems(media.items) });
  return sendJSON(res, 200, { ok: true, added: created.map(publicItem), count: created.length });
}

async function handleReorder(req, res) {
  const body = JSON.parse((await readBody(req, 1 << 20)).toString('utf8') || '{}');
  const ids = Array.isArray(body.ids) ? body.ids : [];
  const media = await getMedia();
  const map = new Map(media.items.map((m) => [m.id, m]));
  const order = new Map();
  ids.forEach((id, i) => { if (map.has(id)) order.set(id, i); });
  media.items.forEach((m) => { m.sortIndex = order.has(m.id) ? order.get(m.id) : null; });
  await saveMedia(media);
  return sendJSON(res, 200, { ok: true });
}

/* ------------------------------------------------------------------ 导出为单文件 HTML */

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fileToDataURI(file) {
  try {
    const ext = path.extname(file).toLowerCase();
    const type = MIME[ext] || 'application/octet-stream';
    const b = fs.readFileSync(file);
    if (b.length > 40 * 1024 * 1024) return null;
    return `data:${type};base64,${b.toString('base64')}`;
  } catch (_) {
    return null;
  }
}

async function handleExport(req, res) {
  const pet = await getPet();
  const media = await getMedia();
  const stories = await getStories();
  // 导出 HTML 时图片已经从 R2 拿的是公网 URL，直接内联在原位即可（不重复下载再 base64）
  const items = sortItems(media.items).map((it) => {
    if (r2on() && it.file && !/^https?:\/\//.test(it.file)) {
      return { ...it, src: mediaURL(it.file), posterSrc: it.poster ? mediaURL(it.poster) : null };
    }
    const abs = path.join(DATA, it.file);
    const uri = fileToDataURI(abs);
    const poster = it.poster ? fileToDataURI(path.join(DATA, it.poster)) : null;
    return { ...it, src: uri, posterSrc: poster };
  }).filter((it) => it.src);
  const storyItems = sortStories(stories.items).map((s) => ({
    ...s,
    images: (s.mediaIds || []).map((id) => items.find((i) => i.id === id)).filter(Boolean).map((i) => i.src),
  }));
  const html = buildExportHTML(pet, items, storyItems);
  const name = `export-${Date.now()}.html`;
  await fsp.writeFile(path.join(D.exportDir, name), html, 'utf8');
  const url = BASE + '/files/export/' + name;
  return sendJSON(res, 200, { ok: true, url, name, size: Buffer.byteLength(html) });
}

function buildExportHTML(pet, items, stories) {
  const photos = items.filter((i) => i.type === 'image');
  const videos = items.filter((i) => i.type === 'video');
  const fmt = (s) => {
    if (!s) return '';
    const d = new Date(s);
    if (isNaN(d)) return '';
    return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;
  };
  const mediaCard = (it) => {
    if (it.type === 'video') {
      return `<figure class="card"><video controls playsinline preload="metadata" poster="${esc(it.posterSrc || '')}" src="${esc(it.src)}"></video><figcaption>${esc(fmt(it.takenAt || it.uploadedAt))}${it.title ? ' · ' + esc(it.title) : ''}</figcaption></figure>`;
    }
    return `<figure class="card"><img loading="lazy" src="${esc(it.src)}" alt="${esc(it.title || it.originalName)}"><figcaption>${esc(fmt(it.takenAt || it.uploadedAt))}${it.title ? ' · ' + esc(it.title) : ''}</figcaption></figure>`;
  };
  const catEyes = `
    <svg class="paw" viewBox="0 0 100 100"><g fill="currentColor">
      <ellipse cx="30" cy="34" rx="11" ry="14"/><ellipse cx="52" cy="26" rx="11" ry="15"/>
      <ellipse cx="74" cy="34" rx="10" ry="13"/><ellipse cx="86" cy="56" rx="9" ry="11"/>
      <path d="M50 44c14 0 26 12 26 24 0 10-9 16-19 12-5-2-9-2-14 0-10 4-19-2-19-12 0-12 12-24 26-24z"/>
    </g></svg>`;
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(pet.siteTitle)} · 图册与故事册</title>
<style>
:root{--bg:#f3f7f2;--ink:#2f3a35;--muted:#7d8f85;--line:#d9e5dc;--accent:#8fbf9f;--paper:#fbfdfa}
*{box-sizing:border-box}
html,body{margin:0}
body{background:linear-gradient(180deg,#eef5ef,var(--bg) 40%,#f7f4ec);color:var(--ink);font-family:"PingFang SC","Hiragino Sans GB","Noto Sans SC",system-ui,sans-serif;line-height:1.8;-webkit-font-smoothing:antialiased}
.wrap{max-width:1080px;margin:0 auto;padding:0 22px}
header.hero{padding:72px 0 36px;text-align:center;position:relative;overflow:hidden}
header.hero:before{content:"";position:absolute;inset:-40% -10% auto;height:520px;background:radial-gradient(60% 60% at 50% 40%,rgba(160,205,175,.35),transparent 70%);filter:blur(10px)}
h1{font-size:clamp(28px,5vw,48px);letter-spacing:.06em;margin:0 0 10px;font-weight:600}
.tag{color:var(--muted);letter-spacing:.12em;font-size:13px}
.paw{width:26px;height:26px;color:var(--accent);opacity:.8}
section{padding:56px 0;border-top:1px dashed var(--line)}
h2{font-size:20px;letter-spacing:.18em;font-weight:600;color:#456052;margin:0 0 6px;display:flex;align-items:center;gap:10px}
h2 small{letter-spacing:.1em;color:var(--muted);font-weight:400;font-size:12px}
.timeline{position:relative;margin-top:34px;padding-left:26px}
.timeline:before{content:"";position:absolute;left:6px;top:6px;bottom:6px;width:1px;background:linear-gradient(180deg,transparent,var(--line),transparent)}
.tl-item{position:relative;margin:0 0 34px}
.tl-item:before{content:"";position:absolute;left:-25px;top:12px;width:9px;height:9px;border-radius:50%;background:var(--paper);border:1.5px solid var(--accent)}
.tl-date{font-size:12px;letter-spacing:.16em;color:var(--muted)}
.tl-text{margin:6px 0 0;white-space:pre-wrap}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:18px;margin-top:26px}
.card{margin:0;background:var(--paper);border-radius:14px;overflow:hidden;box-shadow:0 8px 24px rgba(60,90,70,.08);border:1px solid var(--line)}
.card img,.card video{display:block;width:100%;aspect-ratio:4/3;object-fit:cover;background:#eef2ee}
.card figcaption{font-size:12px;color:var(--muted);padding:10px 12px;letter-spacing:.06em}
.stories{display:grid;gap:22px;margin-top:28px}
.story{background:var(--paper);border:1px solid var(--line);border-radius:16px;padding:22px}
.story h3{margin:0 0 6px;font-size:17px;letter-spacing:.06em}
.story .meta{font-size:12px;color:var(--muted);letter-spacing:.14em}
.story p{white-space:pre-wrap;margin:12px 0 0}
.story .imgs{display:flex;gap:10px;overflow:auto;margin-top:16px;padding-bottom:6px}
.story .imgs img{height:150px;border-radius:10px;object-fit:cover}
footer{padding:48px 0 72px;text-align:center;color:var(--muted);font-size:12px;letter-spacing:.14em}
.petinfo{display:flex;gap:18px;flex-wrap:wrap;justify-content:center;margin-top:18px;color:var(--muted);font-size:13px}
@media print{body{background:#fff}section{page-break-inside:avoid}}
</style></head>
<body>
<header class="hero"><div class="wrap">
  ${catEyes}
  <h1>${esc(pet.siteTitle)}</h1>
  <div class="tag">${esc(pet.tagline || '')}</div>
  <div class="petinfo">
    <span>${esc(pet.pet.name || '')}</span>
    <span>${esc(pet.pet.species || '')}</span>
    <span>${esc(pet.pet.breed || '')}</span>
    ${pet.pet.birthday ? `<span>生日 ${esc(pet.pet.birthday)}</span>` : ''}
    <span>${photos.length} 张照片 · ${videos.length} 段视频 · ${stories.length} 个故事</span>
  </div>
</div></header>

<section><div class="wrap">
  <h2>故事册 <small>STORIES</small></h2>
  <div class="stories">
  ${stories.map((s) => `
    <article class="story">
      <h3>${esc(s.title)}</h3>
      <div class="meta">${esc(fmt(s.date))}${s.mood ? ' · ' + esc(s.mood) : ''}</div>
      <p>${esc(s.body)}</p>
      ${s.images.length ? `<div class="imgs">${s.images.map((u) => `<img loading="lazy" src="${esc(u)}" alt="">`).join('')}</div>` : ''}
    </article>`).join('') || '<p style="color:#7d8f85">还没有故事。</p>'}
  </div>
</div></section>

<section><div class="wrap">
  <h2>图册 <small>ALBUM</small></h2>
  <div class="timeline">
    ${items.map((it) => `
      <div class="tl-item">
        <div class="tl-date">${esc(fmt(it.takenAt || it.uploadedAt))}</div>
        ${mediaCard(it)}
      </div>`).join('') || '<p style="color:#7d8f85">还没有照片或视频。</p>'}
  </div>
</div></section>

<footer>${esc(pet.siteTitle)} · 导出于 ${new Date().toLocaleString('zh-CN')}</footer>
</body></html>`;
}

/* ------------------------------------------------------------------ 故事 */

function sortStories(items) {
  return items.slice().sort((a, b) => {
    const da = Date.parse(a.date || a.createdAt || 0) || 0;
    const db = Date.parse(b.date || b.createdAt || 0) || 0;
    if (da !== db) return db - da;
    return (b.createdAt || '').localeCompare(a.createdAt || '');
  });
}

/* ------------------------------------------------------------------ 路由 */

async function handleApi(req, res, url) {
  const p = url.pathname;
  const method = req.method;

  /* ---------------------------------------------------- 后台登录 / 口令 */
  if (p === '/api/admin/login' && method === 'POST') {
    const ip = clientIP(req);
    const wait = loginLocked(ip);
    const body = JSON.parse((await readBody(req, 64 * 1024)).toString('utf8') || '{}');
    // 正确口令永远放行，避免自己被自己的节流锁在门外
    const a = await getAuth();
    const ok = safeEqual(hashToken(String(body.password || ''), a.salt, String(body.password || '')), a.passHash);
    if (!ok) {
      if (wait > 0) {
        return sendJSON(res, 429, { error: `尝试次数过多，请 ${Math.ceil(wait / 60000)} 分钟后再试`, retryAfter: Math.ceil(wait / 1000) });
      }
      const rec = loginFails.get(ip) || { count: 0, last: 0 };
      rec.count += 1;
      rec.last = Date.now();
      loginFails.set(ip, rec);
      const left = Math.max(0, FAIL_MAX - rec.count);
      return sendJSON(res, 401, {
        error: left > 0 ? `口令不正确，还可以再试 ${left} 次` : '口令不正确，已锁定 10 分钟',
        left,
        locked: left === 0,
      });
    }
    loginFails.delete(ip);
    const token = makeSession(a, SESSION_TTL);
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL / 1000)}`);
    return sendJSON(res, 200, { ok: true });
  }

  // 手动解锁：本机或已登录的会话可以直接清掉当前 IP 的失败计数
  if (p === '/api/admin/unlock' && method === 'POST') {
    const ip = clientIP(req);
    const local = /^(127\.0\.0\.1|::1|localhost)$/.test(ip);
    if (!local && !(await isAuthorized(req))) return sendJSON(res, 401, { error: '未登录' });
    clearFail(ip);
    return sendJSON(res, 200, { ok: true, ip });
  }

  if (p === '/api/admin/logout' && method === 'POST') {
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
    return sendJSON(res, 200, { ok: true });
  }

  if (p === '/api/admin/status' && method === 'GET') {
    return sendJSON(res, 200, { authed: await isAuthorized(req) });
  }

  if (p === '/api/admin/password' && method === 'POST') {
    if (!(await isAuthorized(req))) return sendJSON(res, 401, { error: '未登录' });
    const body = JSON.parse((await readBody(req, 64 * 1024)).toString('utf8') || '{}');
    const next = String(body.password || '');
    if (next.length < 6) return sendJSON(res, 400, { error: '口令至少 6 位' });
    const a = await getAuth();
    const salt = crypto.randomBytes(16).toString('hex');
    const upd = { ...a, salt, passHash: hashToken(next, salt, next), secret: crypto.randomBytes(32).toString('hex'), updatedAt: nowISO() };
    await writeJSON(AUTH_FILE(), upd);
    authCache = upd;
    // 换口令时轮换签名密钥，所有旧会话自动失效
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
    return sendJSON(res, 200, { ok: true, relogin: true });
  }

  if (p === '/api/bootstrap' && method === 'GET') {
    const [pet, media, stories] = await Promise.all([getPet(), getMedia(), getStories()]);
    return sendJSON(res, 200, {
      pet,
      media: sortItems(media.items).map(publicItem),
      stories: sortStories(stories.items),
      base: BASE,
      serverTime: nowISO(),
      features: { ffmpeg: hasFfmpeg(), r2: r2on(), imageMaxBytes: IMG_MAX_BYTES },
      admin: await isAuthorized(req),
    });
  }

  if (p === '/api/pet' && (method === 'PUT' || method === 'POST')) {
    const body = JSON.parse((await readBody(req, 1 << 20)).toString('utf8') || '{}');
    const cur = await getPet();
    const next = {
      ...cur,
      ...body,
      pet: { ...(cur.pet || {}), ...(body.pet || {}) },
      hero: { ...(cur.hero || {}), ...(body.hero || {}) },
      music: { ...(cur.music || {}), ...(body.music || {}) },
      updatedAt: nowISO(),
    };
    await writeJSON(D.pet, next);
    return sendJSON(res, 200, { ok: true, pet: next });
  }

  if (p === '/api/upload' && method === 'POST') return handleUpload(req, res);

  if (p === '/api/media' && method === 'POST') {
    // 批量更新（标题、备注、拍摄时间、收藏、删除）
    const body = JSON.parse((await readBody(req, 2 << 20)).toString('utf8') || '{}');
    const media = await getMedia();
    const ids = new Set(body.ids || (body.id ? [body.id] : []));
    if (body.delete && ids.size) {
      for (const it of media.items) {
        if (!ids.has(it.id)) continue;
        // 远端对象（R2）与本地缩略图分开清
        if (it.file && r2on() && !/^https?:\/\//.test(it.file)) {
          await r2Del(it.file);
        } else if (it.file) {
          try { await fsp.unlink(path.join(DATA, it.file)); } catch (_) {}
        }
        for (const f of [it.thumb, it.poster]) {
          if (f && !/^https?:\/\//.test(f)) { try { await fsp.unlink(path.join(DATA, f)); } catch (_) {} }
        }
      }
      media.items = media.items.filter((it) => !ids.has(it.id));
      // 同步清理故事里的引用
      const st = await getStories();
      st.items.forEach((s) => { s.mediaIds = (s.mediaIds || []).filter((x) => !ids.has(x)); });
      await saveStories(st);
    } else {
      const patch = body.patch || {};
      for (const it of media.items) {
        if (!ids.has(it.id)) continue;
        for (const k of ['title', 'note', 'favorite', 'takenAt', 'takenAtSource', 'tags']) {
          if (k in patch) it[k] = patch[k];
        }
      }
    }
    await saveMedia({ ...media, items: sortItems(media.items) });
    return sendJSON(res, 200, { ok: true, items: sortItems(media.items).map(publicItem) });
  }

  if (p === '/api/media/reorder' && method === 'POST') return handleReorder(req, res);

  if (p === '/api/stories' && method === 'POST') {
    const body = JSON.parse((await readBody(req, 2 << 20)).toString('utf8') || '{}');
    const st = await getStories();
    const story = {
      id: 'st_' + uid(),
      title: body.title || '未命名故事',
      date: body.date || nowISO().slice(0, 10),
      mood: body.mood || '',
      body: body.body || '',
      mediaIds: Array.isArray(body.mediaIds) ? body.mediaIds : [],
      createdAt: nowISO(),
      updatedAt: nowISO(),
    };
    st.items.push(story);
    await saveStories(st);
    return sendJSON(res, 200, { ok: true, story, items: sortStories(st.items) });
  }

  const sm = /^\/api\/stories\/([\w-]+)$/.exec(p);
  if (sm) {
    const id = sm[1];
    const st = await getStories();
    const idx = st.items.findIndex((s) => s.id === id);
    if (idx < 0) return sendJSON(res, 404, { error: 'not found' });
    if (method === 'PUT' || method === 'PATCH') {
      const body = JSON.parse((await readBody(req, 2 << 20)).toString('utf8') || '{}');
      const cur = st.items[idx];
      st.items[idx] = { ...cur, ...body, id: cur.id, updatedAt: nowISO() };
      await saveStories(st);
      return sendJSON(res, 200, { ok: true, story: st.items[idx], items: sortStories(st.items) });
    }
    if (method === 'DELETE') {
      st.items.splice(idx, 1);
      await saveStories(st);
      return sendJSON(res, 200, { ok: true, items: sortStories(st.items) });
    }
  }

  if (p === '/api/export' && method === 'POST') return handleExport(req, res);

  if (p === '/api/music' && method === 'POST') return handleUpload(req, res);

  return sendJSON(res, 404, { error: '未知接口' });
}

let ffmpegCache = null;
function hasFfmpeg() {
  if (ffmpegCache !== null) return ffmpegCache;
  try {
    const r = require('child_process').spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    ffmpegCache = r.status === 0;
  } catch (_) { ffmpegCache = false; }
  return ffmpegCache;
}

async function route(req, res) {
  const url = new URL(req.url, 'http://localhost');
  let pathname = decodeURIComponent(url.pathname);
  if (BASE && pathname.startsWith(BASE)) pathname = pathname.slice(BASE.length) || '/';
  if (process.env.PET_SHOW_BASE !== '0' && pathname === '/api/base') return sendJSON(res, 200, { base: BASE });

  if (pathname.startsWith('/api/')) {
    // 先剥掉 BASE 前缀再判白名单：否则部署在子路径下所有接口都被当成新路由，连登录都会 404
    const apiURL = new URL(req.url, 'http://localhost');
    if (BASE && apiURL.pathname.startsWith(BASE)) apiURL.pathname = apiURL.pathname.slice(BASE.length) || '/';
    const apiPath = apiURL.pathname;
    // 合并查询串：原来只传了 apiURL（只有 pathname），express 里已经丢掉了 req.url 的 ?query
    apiURL.search = url.search;

    const isAdminEndpoint = apiPath.startsWith('/api/admin/') && apiPath !== '/api/admin/password';
    const publicOf = PUBLIC_API.has(apiPath);
    // 公开路径：登录/登出不依赖会话，其余写操作都要有效会话
    if (!publicOf && !isAdminEndpoint) {
      if (!(await isAuthorized(req))) {
        return sendJSON(res, 401, { error: `需要先在 ${ADMIN_PATH} 登录`, needAuth: true });
      }
    }
    try {
      return await handleApi(req, res, apiURL);
    } catch (e) {
      console.error('[api]', apiPath, e);
      return sendJSON(res, 500, { error: String(e && e.message || e) });
    }
  }

  if (pathname === ADMIN_PATH || pathname === ADMIN_PATH + '/') {
    return serveFile(req, res, path.join(PUBLIC, 'admin.html'), { cache: 'no-cache' });
  }
  // 后台文件名不直接暴露：请求到 admin.html（或改名后的同名 .html）一律 404，
  // 后台只认 ADMIN_PATH 这个不透明入口，别人猜 PATH 也猜不到文件
  if (pathname === '/' + ADMIN_PATH.replace(/^\//, '') + '.html' || pathname === '/admin.html') {
    return send(res, 404, 'Not Found', { 'Content-Type': 'text/plain' });
  }

  if (pathname.startsWith('/files/')) {
    const rel = pathname.slice('/files/'.length);
    const abs = path.resolve(DATA, rel);
    if (!abs.startsWith(DATA + path.sep)) return send(res, 403, 'Forbidden');
    // R2 模式：media/ 下的正式文件不在本地，直接 302 到公开域名；
    // 缩略图 / 封面（以 .thumb 或 _poster.jpg 结尾）仍从磁盘读
    if (r2on() && rel.startsWith('media/') && !/_poster\.jpg$/.test(rel) && !/\.thumb$/.test(rel)) {
      const u = R2.url(rel);
      if (u) return send(res, 302, '', { Location: u, 'Cache-Control': 'no-cache' });
    }
    return serveFile(req, res, abs, { cache: 'no-cache' });
  }

  // 静态资源：不再把未知路径回落到首页（否则 /admin 之类的猜测路径会拿到整站 HTML，
  // 子路径部署下接口 404 也会被伪装成 200）；找不到就实实在在 404。
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const abs = path.resolve(PUBLIC, rel);
  if (!abs.startsWith(PUBLIC + path.sep) && abs !== path.join(PUBLIC, 'index.html')) {
    return send(res, 403, 'Forbidden');
  }
  const cache = 'no-cache';
  return serveFile(req, res, abs, { cache });
}

async function main() {
  await ensureDirs();
  const pet = await getPet();
  if (!fs.existsSync(D.pet)) await writeJSON(D.pet, pet);
  if (!fs.existsSync(D.media)) await writeJSON(D.media, { items: [] });
  if (!fs.existsSync(D.stories)) await writeJSON(D.stories, { items: [] });
  const server = http.createServer((req, res) => {
    route(req, res).catch((e) => {
      console.error(e);
      try { sendJSON(res, 500, { error: 'server error' }); } catch (_) {}
    });
  });
  server.headersTimeout = 0;
  server.requestTimeout = 0;
  // PET_PORT 可写多个端口，逗号分隔；云主机上常在多个已放行端口间冗余监听
  const ports = String(process.env.PET_PORT || PORT).split(',').map((x) => Number(x.trim())).filter(Boolean);
  const primary = ports[0] || PORT;
  server.listen(primary, HOST, () => {
    console.log(`[pet-album] listening http://${HOST}:${primary}  data=${DATA}  ffmpeg=${hasFfmpeg()}`);
    for (const extra of ports.slice(1)) {
      const s2 = http.createServer((req, res) => {
        route(req, res).catch((e) => {
          console.error(e);
          try { sendJSON(res, 500, { error: 'server error' }); } catch (_) {}
        });
      });
      s2.headersTimeout = 0;
      s2.requestTimeout = 0;
      s2.on('error', (e) => console.error(`[pet-album] extra port ${extra} failed: ${e.message}`));
      s2.listen(extra, HOST, () => console.log(`[pet-album] listening http://${HOST}:${extra}`));
    }
  });
}

main().catch((e) => { console.error(e); process.exit(1); });
