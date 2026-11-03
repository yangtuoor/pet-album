/* ==================================================================
 * r2.js —— Cloudflare R2 极简客户端（S3 兼容 API + Amazon SigV4）
 * 零依赖，只用 Node 内置 https / crypto。
 *
 * 环境变量（缺任意一个就整体退回本地磁盘模式，见 server.js 的 storage()）：
 *   R2_ACCOUNT_ID        Account ID，端点 https://<id>.r2.cloudflarestorage.com
 *   R2_ACCESS_KEY_ID     S3 Token 的 Access Key ID
 *   R2_SECRET_ACCESS_KEY S3 Token 的 Secret Access Key
 *   R2_BUCKET            bucket 名（默认 petalbum）
 *   R2_PUBLIC_BASE       r2.dev 公开域名，如 https://pub-xxx.r2.dev
 *   R2_REGION            签名区域，默认 auto
 * ================================================================== */

const https = require('https');
const crypto = require('crypto');

// 注意：这些配置必须在「调用时」读取，不能在模块加载时快照——
// 否则 server.js 在 require 之前设置 process.env 也不生效，测试脚本更是拿不到值。
const cfg = () => ({
  accountId: process.env.R2_ACCOUNT_ID || '',
  accessKey: process.env.R2_ACCESS_KEY_ID || '',
  secretKey: process.env.R2_SECRET_ACCESS_KEY || '',
  bucket: process.env.R2_BUCKET || 'petalbum',
  publicBase: (process.env.R2_PUBLIC_BASE || '').replace(/\/+$/, ''),
  region: process.env.R2_REGION || 'auto',
  host: process.env.R2_ENDPOINT_HOST || `${process.env.R2_ACCOUNT_ID || ''}.r2.cloudflarestorage.com`,
});

const isEnabled = () => {
  const c = cfg();
  return !!(c.accountId && c.accessKey && c.secretKey && c.bucket);
};

/* ---------------------------------------------------------- SigV4 */

const sha256hex = (b) => crypto.createHash('sha256').update(b).digest('hex');
const hmac = (k, s) => crypto.createHmac('sha256', k).update(s).digest();

// RFC3986：除了 unreserved 全部百分号编码（encodeURIComponent 不编码 ! ' ( ) *，S3 会因此签名不匹配）
function rfc3986(s) {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

// 对象 key 里允许斜杠原样出现，其余按段编码
function encodeKey(k) {
  return String(k).split('/').map(rfc3986).join('/');
}

// 真实请求路径与「规范 URI」必须是同一个字符串：/<bucket>/<key>
function rawPath(c, key) {
  return '/' + c.bucket + (key ? '/' + encodeKey(key) : '');
}

function amzDate(d) {
  return d.toISOString().replace(/[:-]|\.\d{3}/g, '');
}

/**
 * 生成签名头。
 * @param {string} method  GET / PUT / DELETE / HEAD
 * @param {string} key     对象 key（不含 bucket），可为空
 * @param {Buffer|null} body
 * @param {object} extra   额外的 header（会被并入签名）
 */
function sign(method, key, body, extra) {
  const c = cfg();
  const now = new Date();
  const stamp = amzDate(now);           // 20261103T190000Z
  const date = stamp.slice(0, 8);       // 20261103
  const payloadHash = body && body.length ? sha256hex(body) : sha256hex(Buffer.alloc(0));

  const headers = {
    host: c.host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': stamp,
    ...(extra || {}),
  };

  const lower = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = String(v).trim().replace(/\s+/g, ' ');
  const signedHeaders = Object.keys(lower).sort();
  const canonicalHeaders = signedHeaders.map((h) => `${h}:${lower[h]}\n`).join('');
  const signedHeaderList = signedHeaders.join(';');

  // 规范 URI 必须与真正发出去的请求路径（line 110 的 rawPath）逐字符一致，
  // 否则 R2 算出的签名对不上。这里统一走同一个函数。
  const canonicalUri = rawPath(c, key);
  const canonicalRequest = [method, canonicalUri, '', canonicalHeaders, signedHeaderList, payloadHash].join('\n');
  const scope = `${date}/${c.region}/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', stamp, scope, sha256hex(Buffer.from(canonicalRequest, 'utf8'))].join('\n');

  const kDate = hmac('AWS4' + c.secretKey, date);
  const kRegion = hmac(kDate, c.region);
  const kService = hmac(kRegion, 's3');
  const kSigning = hmac(kService, 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');

  const out = { ...headers };
  delete out.host;
  out.authorization =
    `AWS4-HMAC-SHA256 Credential=${c.accessKey}/${scope}, ` +
    `SignedHeaders=${signedHeaderList}, Signature=${signature}`;
  return out;
}

/* ---------------------------------------------------------- HTTP */

/**
 * @param {string} key 对象 key；对桶级操作（如列对象）传空串
 */
function request(method, key, body, headers) {
  return new Promise((resolve, reject) => {
    const c = cfg();
    const h = sign(method, key, body, headers);
    // 关键：请求路径必须是 /<bucket>/<key>，且与签名里的规范 URI 完全相同。
    // 之前两处不同步：漏了 bucket 段会被当成 NoSuchBucket；路径与规范 URI 不一致会是 SignatureDoesNotMatch。
    const p = rawPath(c, key);
    // 必须显式给每个请求定长度：Node 默认用 chunked 传输，
    // R2 的 S3 接口会直接 411 MissingContentLength。无 body 用 0。
    const hWithLen = { ...h, host: c.host, 'content-length': String(body && body.length ? body.length : 0) };
    const req = https.request(
      { method, host: c.host, path: p, headers: hWithLen, timeout: 120000 },
      (res) => {
        const chunks = [];
        res.on('data', (ch) => chunks.push(ch));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      }
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('r2 timeout')));
    if (body && body.length) req.write(body);
    req.end();
  });
}

/* ---------------------------------------------------------- 对外 API */

/** 上传对象。key 形如 media/im_xxx.jpg */
async function put(key, body, contentType) {
  const t0 = Date.now();
  const r = await request('PUT', key, body, { 'content-type': contentType || 'application/octet-stream' });
  if (r.status !== 200) {
    throw new Error(`R2 PUT ${key} -> ${r.status} ${r.body.toString('utf8').slice(0, 200)}`);
  }
  return { key, size: body.length, ms: Date.now() - t0 };
}

async function del(key) {
  try {
    const r = await request('DELETE', key, null, {});
    return r.status === 204 || r.status === 200 || r.status === 404;
  } catch (_) {
    return false;
  }
}

async function head(key) {
  try {
    const r = await request('HEAD', key, null, {});
    return r.status === 200 ? Number(r.headers['content-length'] || 0) : -1;
  } catch (_) {
    return -1;
  }
}

/** 列对象（最多 1000 个，够用）——只做连通性自检，不分页 */
async function list(prefix) {
  const r = await request('GET', '', null, {});
  return { status: r.status, text: r.body.toString('utf8', 0, 400), prefix: prefix || '' };
}

/** 把对象 key 变成可给 <img> 用的 URL */
function url(key) {
  if (!key) return null;
  if (/^https?:\/\//.test(key)) return key;
  const base = cfg().publicBase;
  if (base) return `${base}/${key.replace(/^\/+/, '')}`;
  return null;
}

/** 对象 key 前缀，可按需在桶内分目录，这里统放根下 media/ */
const keyFor = (rel) => rel.replace(/^\/+/, '');

module.exports = {
  put, del, head, list, url, keyFor, sign, rfc3986, cfg,
  get enabled() { return isEnabled(); },
  get BUCKET() { return cfg().bucket; },
  get PUBLIC_BASE() { return cfg().publicBase; },
  get HOST() { return cfg().host; },
};
