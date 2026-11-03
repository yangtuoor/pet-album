/* ==========================================================================
   毛毛的小角落 · 前端
   - 通过 /api/bootstrap 建立"服务端模式"，失败则进入"离线演示模式"
   - 上传 > 拖拽/选择 → XHR 带进度 → 服务端 EXIF 排序
   - 图册三视图 / 故事册双视图 / 灯箱 / 首屏视差 / 滚动揭示
   ========================================================================== */
(function () {
  'use strict';

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

  const state = {
    base: '',
    online: false,
    pet: null,
    media: [],
    stories: [],
    view: 'magazine',
    storyView: 'cards',
    sort: 'auto',
    filter: 'all',
    query: '',
    pageSize: 24,
    shown: 24,
    lightboxIndex: -1,
    storyEditing: null,
    pickedMedia: new Set(),
    musicOn: false,
  };

  /* ---------------------------------------------------------------- 工具 */

  const pad = (n) => String(n).padStart(2, '0');
  const toDate = (s) => {
    if (!s) return null;
    const d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
  };
  const fmtDay = (s) => {
    const d = toDate(s);
    if (!d) return '';
    return `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())}`;
  };
  const fmtFull = (s) => {
    const d = toDate(s);
    if (!d) return '';
    return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  // 视频时长：秒 → 0:07 / 1:23 / 12:34
  const fmtDur = (sec) => {
    const s = Math.max(0, Math.round(Number(sec) || 0));
    if (!s) return '';
    const m = Math.floor(s / 60);
    return `${m}:${pad(s % 60)}`;
  };
  const fmtSize = (n) => {
    if (!n && n !== 0) return '';
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(0) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
  };
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const fileURL = (p) => (p ? `${state.base}/files/${p}` : '');

  function toast(msg, ms = 2400) {
    const wrap = $('#toastWrap');
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = msg;
    wrap.appendChild(el);
    setTimeout(() => {
      el.classList.add('out');
      setTimeout(() => el.remove(), 380);
    }, ms);
  }

  /* ---------------------------------------------------------------- 数据 */

  async function apiBootstrap() {
    const r = await fetch(`${state.base}/api/bootstrap`, { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }

  const PAW = `<svg viewBox="0 0 100 100" aria-hidden="true"><g fill="currentColor"><ellipse cx="30" cy="34" rx="11" ry="14"/><ellipse cx="52" cy="26" rx="11" ry="15"/><ellipse cx="74" cy="34" rx="10" ry="13"/><ellipse cx="86" cy="57" rx="9" ry="11"/><path d="M50 44c14 0 26 12 26 24 0 10-9 16-19 12-5-2-9-2-14 0-10 4-19-2-19-12 0-12 12-24 26-24z"/></g></svg>`;

  // 离线演示数据：让 file:// 直接打开时也能看到完整效果
  function demoData() {
    const grad = (a, b, c) => `linear-gradient(135deg, ${a}, ${b} 55%, ${c})`;
    const img = (a, b, c) =>
      'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 600"><defs>
        <linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset=".55" stop-color="${b}"/><stop offset="1" stop-color="${c}"/></linearGradient>
        <filter id="n"><feTurbulence baseFrequency=".9" numOctaves="2"/><feComponentTransfer><feFuncA type="linear" slope=".07"/></feComponentTransfer></filter>
        </defs><rect width="800" height="600" fill="url(#g)"/>
        <g fill="none" stroke="#ffffff" stroke-opacity=".55" stroke-width="2">
          <circle cx="620" cy="150" r="60"/><path d="M60 470q160-110 320-20t360-60"/>
        </g><rect width="800" height="600" filter="url(#n)"/></svg>`
      );
    const items = [
      { id: 'd1', type: 'image', url: img('#cfe6d6', '#9fc1d1', '#f0d9a8'), title: '窗台上的第一缕阳光', note: '早上六点，它把整张脸贴在玻璃上。', takenAt: '2025-03-18T07:12:00', fav: true },
      { id: 'd2', type: 'image', url: img('#f3e6c8', '#e8b3ae', '#c9d8c2'), title: '沙发扶手', note: '', takenAt: '2025-04-02T15:40:00' },
      { id: 'd3', type: 'image', url: img('#d6e8f0', '#bcd6c6', '#fff6e2'), title: '下雨天', note: '雨点敲窗，它看了很久。', takenAt: '2025-05-21T18:05:00' },
      { id: 'd4', type: 'video', url: '', title: '追激光笔', note: '一段十五秒的疯跑。', takenAt: '2025-06-11T20:30:00' },
      { id: 'd5', type: 'image', url: img('#eae3f0', '#b9cbe0', '#f6efe2'), title: '纸箱', note: '', takenAt: '2025-07-09T13:20:00' },
      { id: 'd6', type: 'image', url: img('#f0e9d6', '#d8c9a8', '#a9c3b2'), title: '午睡', note: '尾巴把鼻子盖住了。', takenAt: '2025-08-30T14:55:00', fav: true },
      { id: 'd7', type: 'image', url: img('#d9ebe4', '#a8c9c0', '#f2e4c8'), title: '秋天', note: '', takenAt: '2025-10-14T09:10:00' },
      { id: 'd8', type: 'image', url: img('#e6e0ef', '#c0b6d8', '#f7ece0'), title: '第一次看雪', note: '', takenAt: '2025-12-25T10:30:00' },
      { id: 'd9', type: 'image', url: img('#f4ecd9', '#e4c9a9', '#cfe0cf'), title: '过年', note: '窗花、橘子、和一只不动的猫。', takenAt: '2026-02-17T19:00:00' },
    ];
    return {
      pet: {
        siteTitle: '毛毛的小角落',
        tagline: '一只小动物，和它留在这个世界上的所有轻软时刻。',
        pet: {
          name: '毛毛', species: '狗', breed: '',
          birthday: '2023-04-01', homeDate: '2023-06-10',
          bio: '它喜欢窗台、纸箱和雨声。\n讨厌吸尘器，但会假装不在意。\n每天晚上十点准时来踩胸口。',
          avatar: null,
        },
        music: { track: null, enabled: true, volume: 0.35 },
      },
      media: items,
      stories: [
        { id: 's1', title: '第一次趴在窗台上睡着', date: '2025-03-18', mood: '懒散', body: '搬来新家的第三天，它终于不再躲在床底。\n\n早上六点，我拉开窗帘，它跳上窗台，把自己摊成一张软软的饼。阳光把它的一侧耳朵照成半透明。\n\n那一刻我想，它大概是认下这里了。', mediaIds: ['d1'] },
        { id: 's2', title: '下雨的下午', date: '2025-05-21', mood: '好奇', body: '雨从下午三点一直下到天黑。\n\n它坐在窗边看了很久，偶尔抬爪去摸玻璃上的水痕，摸不到就装作本来也没想摸。', mediaIds: ['d3'] },
        { id: 's3', title: '追激光笔', date: '2025-06-11', mood: '开心', body: '持续十五秒的疯跑，然后突然躺平，好像什么都没发生。', mediaIds: ['d4'] },
        { id: 's4', title: '第一次看雪', date: '2025-12-25', mood: '好奇', body: '把它抱到窗边，它盯着落下来的白点，尾巴一动不动。\n\n后来雪停了，它在窗台睡了一整个下午。', mediaIds: ['d8'] },
      ],
      offline: true,
    };
  }

  /* ---------------------------------------------------------------- 渲染：首屏 */

  function petAgeDays(from) {
    const d = toDate(from);
    if (!d) return 0;
    return Math.max(0, Math.floor((Date.now() - d.getTime()) / 86400000));
  }

  function countUp(el, to, dur = 1200) {
    if (!el) return;
    const from = 0;
    const t0 = performance.now();
    const step = (t) => {
      const k = Math.min(1, (t - t0) / dur);
      const eased = 1 - Math.pow(1 - k, 3);
      el.textContent = Math.round(from + (to - from) * eased).toLocaleString('zh-CN');
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  function renderChrome() {
    const p = state.pet || {};
    const pet = p.pet || {};

    // 首屏大标题：后台可以改，空格分词逐词入场
    const heroTitleEl = $('#heroTitle');
    if (heroTitleEl) {
      const raw = (p.heroTitle || `${pet.name || '毛毛'} 的小角落`).trim();
      const words = raw.split(/\s+/).filter(Boolean);
      const line = document.createElement('span');
      line.className = 'line';
      words.forEach((w, i) => {
        const s = document.createElement('span');
        s.className = 'word';
        s.dataset.split = '';
        s.dataset.i = String(i);
        s.textContent = w;
        line.appendChild(s);
      });
      // 只重建一次，避免每次 render 都触发重排动画
      if (heroTitleEl.dataset.rendered !== raw) {
        heroTitleEl.dataset.rendered = raw;
        heroTitleEl.dataset.words = String(words.length);
        heroTitleEl.replaceChildren(line);
      }
    }

    document.title = `${p.siteTitle || '毛毛的小角落'} · 图册与故事册`;
    $('#brandName').textContent = p.siteTitle || '毛毛的小角落';
    $('#footTitle').textContent = p.siteTitle || '毛毛的小角落';
    $('#aboutName').textContent = pet.name || '毛毛';
    $('#aboutBio').textContent = pet.bio || '在这里写它的性格、怪癖、喜欢的东西。';
    // 副标题可改；写着 <br> 时保留移动端换行
    const tagEl = $('#heroTagline');
    if (tagEl && p.tagline) {
      tagEl.innerHTML = esc(p.tagline).replace(/\n/g, '<br>') + '<br class="only-mobile">一张照片、一段视频、几句写给它的话。';
    }

    // 头像
    [[$('#heroAvatar')], [$('#aboutAvatar')]].forEach(([el]) => {
      if (!el) return;
      if (pet.avatar) {
        el.style.backgroundImage = `url("${fileURL(pet.avatar)}")`;
        el.innerHTML = '';
      } else {
        el.style.backgroundImage = '';
        el.innerHTML = PAW;
      }
    });

    // 首屏叠放卡片：后台指定的优先，没指定就取最新三张
    const hero = p.hero || {};
    const heroFixed = !!hero.fixed;
    const byId = (id) => (id ? state.media.find((m) => m.id === id) : null);
    const latest = state.media.slice(-3).reverse();
    const slots = ['.c1', '.c2', '.c3'];
    slots.forEach((sel, i) => {
      const card = $(sel);
      if (!card) return;
      const picked = heroFixed && hero.cards && hero.cards[i] ? byId(hero.cards[i]) : null;
      const it = picked || latest[i];
      const ph = card.querySelector('.ph');
      const emptyEl = card.querySelector('.ph-empty');
      const src = it ? thumbOf(it) : '';
      ph.style.backgroundImage = src ? `url("${src}")` : '';
      card.dataset.caption = it ? fmtDay(it.takenAt || it.uploadedAt) : '';
      // 没有照片时卡片不消失，改成一张「待添加」的占位卡，首屏才有画面和引导
      card.classList.toggle('is-empty', !src);
      if (emptyEl) emptyEl.innerHTML = src ? '' : `<div class="pe-inner">${PAW}<span>待添加</span></div>`;
      if (src) {
        const pre = new Image();
        pre.onload = () => card.classList.add('has-photo');
        pre.src = src;
      }
    });
    // 头像：后台指定 > 宠物资料头像 > 最新一张照片；都没有时放爪印占位，别留一个空圆
    const avatarEl = $('#heroAvatar');
    if (avatarEl) {
      const pickedAvatar = heroFixed && hero.avatar ? byId(hero.avatar) : null;
      const src = pickedAvatar ? thumbOf(pickedAvatar) : (pet.avatar ? fileURL(pet.avatar) : (latest[0] ? thumbOf(latest[0]) : ''));
      if (src) {
        avatarEl.style.backgroundImage = `url("${src}")`;
        avatarEl.innerHTML = '';
        avatarEl.classList.remove('is-empty');
      } else {
        avatarEl.style.backgroundImage = '';
        avatarEl.innerHTML = PAW;
        avatarEl.classList.add('is-empty');
      }
    }

    // 统计
    const photos = state.media.filter((m) => m.type === 'image').length;
    const videos = state.media.filter((m) => m.type === 'video').length;
    countUp($('#statDays'), petAgeDays(pet.homeDate || pet.birthday));
    countUp($('#statPhotos'), photos);
    countUp($('#statVideos'), videos);
    countUp($('#statStories'), state.stories.length);
    $('#footCount').textContent = `${photos} 张照片 · ${state.stories.length} 段故事`;

    // 关于
    const facts = [
      ['种类', pet.species || '—'],
      ['品种', pet.breed || '—'],
      ['生日', pet.birthday ? fmtDay(pet.birthday) : '—'],
      ['来家', pet.homeDate ? fmtDay(pet.homeDate) : '—'],
      ['照片', photos + ' 张'],
      ['故事', state.stories.length + ' 个'],
    ];
    $('#facts').innerHTML = facts.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('');

    // 音乐按钮
    const hasTrack = !!((state.pet.music || {}).track);
    const btn = $('#btnMusic');
    btn.classList.toggle('is-on', state.musicOn);
    btn.title = hasTrack ? (state.musicOn ? '背景音乐：开' : '背景音乐：关') : '还没有上传音乐（点我上传）';
    $('#menuMusic').textContent = '背景音乐：' + (state.musicOn ? '开' : '关');
  }

  function thumbOf(it) {
    // 服务端已经把 R2 的公网地址算好放在 thumbSrc / posterSrc / src 里，
    // 有就直接用，免得再拼一次 /files/ 路径
    if (it.thumbSrc) return it.thumbSrc;
    if (it.posterSrc) return it.posterSrc;
    if (it.src) return it.src;
    if (it.thumb) return fileURL(it.thumb);
    if (it.poster) return fileURL(it.poster);
    if (it.file) return fileURL(it.file);
    return it.url || '';
  }
  function fullOf(it) {
    if (it.src) {
      // 占位 thumb 是本地小图时，点开要看 R2 上的正式图
      return it.src;
    }
    if (it.file) return fileURL(it.file);
    return it.url || '';
  }

  /* ---------------------------------------------------------------- 排序筛选 */

  const PLAY_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l11-6.5z" fill="currentColor"/></svg>`;
  const HEART = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20s-7-4.4-7-9.3A4 4 0 0 1 12 8a4 4 0 0 1 7 2.7C19 15.6 12 20 12 20z" fill="currentColor"/></svg>`;
  const VIDEO_BADGE = `<span class="badge">${`<svg viewBox="0 0 24 24"><path d="M4 7.5A2.5 2.5 0 0 1 6.5 5h7A2.5 2.5 0 0 1 16 7.5v9A2.5 2.5 0 0 1 13.5 19h-7A2.5 2.5 0 0 1 4 16.5z" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="m16 10.5 4-2.5v8l-4-2.5z" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>`}视频</span>`;

  function timeKey(it) {
    const t = toDate(it.takenAt || it.uploadedAt);
    return t ? t.getTime() : 0;
  }

  function visibleMedia() {
    let arr = state.media.slice();
    if (state.filter === 'image') arr = arr.filter((m) => m.type === 'image');
    else if (state.filter === 'video') arr = arr.filter((m) => m.type === 'video');
    else if (state.filter === 'fav') arr = arr.filter((m) => m.favorite || m.fav);

    const q = state.query.trim().toLowerCase();
    if (q) {
      arr = arr.filter((m) =>
        [m.title, m.note, m.originalName].filter(Boolean).join(' ').toLowerCase().includes(q)
      );
    }

    if (state.sort === 'auto' || state.sort === 'oldest') {
      arr.sort((a, b) => timeKey(a) - timeKey(b) || String(a.uploadedAt).localeCompare(String(b.uploadedAt)));
    } else if (state.sort === 'newest') {
      arr.sort((a, b) => timeKey(b) - timeKey(a));
    } else if (state.sort === 'fav') {
      arr.sort((a, b) => (b.favorite ? 1 : 0) - (a.favorite ? 1 : 0) || timeKey(b) - timeKey(a));
    }
    // manual: 保持服务端顺序
    return arr;
  }

  /* ---------------------------------------------------------------- 渲染：媒体卡 */

  function mediaCardHTML(it) {
    const isV = it.type === 'video';
    const src = thumbOf(it);
    const cap = it.title ? esc(it.title) : fmtDay(it.takenAt || it.uploadedAt);
    // 视频卡显示「时长 · 拍摄/上传」，时长来自 ffprobe，缺失时不显示
    const sub = isV && it.duration
      ? `${fmtDur(it.duration)} · ${it.takenAt ? '拍摄' : '上传'}`
      : (it.takenAt ? '拍摄' : '上传');
    // 没有 ffmpeg 时视频没有封面：直接用带播放键的占位图，避免 <video> 在深色底上露黑
    const inner = isV
      ? (it.poster
        ? `<video muted playsinline loop preload="none" poster="${esc(fileURL(it.poster))}" data-src="${esc(fullOf(it))}"></video><span class="play">${PLAY_ICON}</span>`
        : `<div class="video-ph">${PLAY_ICON}</div><span class="play">${PLAY_ICON}</span>`)
      : `<img loading="lazy" decoding="async" src="${esc(src)}" alt="${esc(it.title || it.originalName || '')}">`;
    return `<figure class="media ${it.favorite ? 'is-fav' : ''}" data-id="${esc(it.id)}" tabindex="0" role="button" aria-label="${esc(it.title || it.originalName || '照片')}">
      ${inner}
      ${isV ? VIDEO_BADGE : ''}
      <span class="fav-dot">${HEART}</span>
      <span class="shade"></span>
      <figcaption class="cap"><span>${cap}</span><span>${sub}</span></figcaption>
    </figure>`;
  }

  function aspectClass(it) {
    const w = it.width, h = it.height;
    if (!w || !h) return 'normal';
    const r = w / h;
    if (r > 1.5) return 'wide';
    if (r < 0.8) return 'tall';
    return 'normal';
  }

  function renderAlbum() {
    const list = visibleMedia();
    const shown = list.slice(0, state.shown);
    const mag = $('#magazine');
    const tl = $('#timeline');
    const grid = $('#grid');

    $('#albumEmpty').hidden = list.length > 0;
    $('#loadMore').hidden = list.length <= shown;
    if (list.length <= shown) $('#loadMore').hidden = true;

    mag.hidden = state.view !== 'magazine';
    tl.hidden = state.view !== 'timeline';
    grid.hidden = state.view !== 'grid';

    if (state.view === 'magazine') {
      mag.innerHTML = shown.map((it) => `<div class="mag-item ${aspectClass(it)}">${mediaCardHTML(it)}</div>`).join('');
    } else if (state.view === 'grid') {
      grid.innerHTML = shown.map((it) => mediaCardHTML(it)).join('');
    } else {
      // 时间线：按年月分组
      const groups = new Map();
      shown.forEach((it) => {
        const d = toDate(it.takenAt || it.uploadedAt);
        const key = d ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}` : 'unknown';
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(it);
      });
      const parts = [];
      for (const [key, items] of groups) {
        const d = items.length ? toDate(items[0].takenAt || items[0].uploadedAt) : null;
        parts.push(`<div class="tl-group">
          <div class="tl-label"><span class="tl-year">${d ? d.getFullYear() : '未知'}</span><span class="tl-month">${d ? pad(d.getMonth() + 1) + ' 月 · ' + items.length + ' 张' : ''}</span></div>
          <div class="tl-items">${items.map(mediaCardHTML).join('')}</div>
        </div>`);
      }
      tl.innerHTML = parts.join('');
    }

    // 入场动画（交错）
    const cards = $$('.media, .tl-group', $('.album-body'));
    cards.forEach((el, i) => {
      el.classList.add('stagger');
      el.style.transitionDelay = Math.min(i * 45, 520) + 'ms';
      requestAnimationFrame(() => el.classList.add('in'));
    });
    bindMediaEvents();
  }

  function bindMediaEvents() {
    $$('.media').forEach((el) => {
      if (el.dataset.bound) return;
      el.dataset.bound = '1';
      el.addEventListener('click', () => openLightbox(el.dataset.id));
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openLightbox(el.dataset.id); }
      });
      // 悬停即播放视频
      if (el.querySelector('video')) {
        el.addEventListener('mouseenter', () => {
          const v = el.querySelector('video');
          if (!v.src && v.dataset.src) v.src = v.dataset.src;
          v.play().catch(() => {});
        });
        el.addEventListener('mouseleave', () => {
          const v = el.querySelector('video');
          v.pause();
        });
      }
    });
  }

  /* ---------------------------------------------------------------- 渲染：故事 */

  const MOOD_COLOR = { 开心: '#8fbf9f', 懒散: '#9fc1d1', 黏人: '#e8b3ae', 好奇: '#f0d9a8', 生病: '#c7bcd8', 想你: '#b9c9d6' };

  function mediaById(id) {
    return state.media.find((m) => m.id === id);
  }

  function renderStories() {
    const wrap = $('#storyCards');
    const tline = $('#storyTimeline');
    const empty = $('#storyEmpty');
    const items = state.stories.slice();
    empty.hidden = items.length > 0;
    wrap.hidden = state.storyView !== 'cards';
    tline.hidden = state.storyView !== 'timeline';

    wrap.innerHTML = items.map((s) => {
      const thumbs = (s.mediaIds || []).map(mediaById).filter(Boolean).slice(0, 4)
        .map((m) => `<i style="background-image:url('${esc(thumbOf(m))}')"></i>`).join('');
      const mood = s.mood ? `<span class="mood" style="color:${MOOD_COLOR[s.mood] || '#5e9778'}">${esc(s.mood)}</span>` : '';
      return `<article class="story-card" data-sid="${esc(s.id)}">
        ${mood}
        <div class="date">${esc(fmtDay(s.date))}</div>
        <h3>${esc(s.title)}</h3>
        <p class="excerpt">${esc(s.body || '（还没有正文）')}</p>
        ${thumbs ? `<div class="thumbs">${thumbs}</div>` : ''}
      </article>`;
    }).join('');

    tline.innerHTML = items.map((s) => {
      const imgs = (s.mediaIds || []).map(mediaById).filter(Boolean).slice(0, 6)
        .map((m) => `<i style="background-image:url('${esc(thumbOf(m))}')"></i>`).join('');
      return `<article class="st-item" data-sid="${esc(s.id)}">
        <div class="st-date">${esc(fmtDay(s.date))}${s.mood ? ' · ' + esc(s.mood) : ''}</div>
        <div class="st-body">
          <h3>${esc(s.title)}</h3>
          <p>${esc(s.body || '')}</p>
          ${imgs ? `<div class="st-imgs">${imgs}</div>` : ''}
        </div>
      </article>`;
    }).join('');

    $$('[data-sid]', $('.story-stage')).forEach((el) => {
      el.addEventListener('click', () => openStoryEditor(el.dataset.sid));
      el.classList.add('stagger');
      const i = [...el.parentNode.children].indexOf(el);
      el.style.transitionDelay = Math.min(i * 60, 400) + 'ms';
      requestAnimationFrame(() => el.classList.add('in'));
    });
  }

  /* ---------------------------------------------------------------- 灯箱 */

  function openLightbox(id) {
    const list = visibleMedia();
    const idx = list.findIndex((m) => m.id === id);
    if (idx < 0) return;
    state.lightboxIndex = idx;
    state.lightboxList = list;
    const lb = $('#lightbox');
    lb.hidden = false;
    document.body.style.overflow = 'hidden';
    paintLightbox();
  }

  function paintLightbox() {
    const list = state.lightboxList || [];
    const it = list[state.lightboxIndex];
    if (!it) return;
    const fig = $('#lbFigure');
    const src = fullOf(it);
    if (it.type === 'video') {
      fig.innerHTML = `<video controls autoplay muted playsinline src="${esc(src)}" poster="${esc(it.poster ? fileURL(it.poster) : '')}"></video>`;
    } else {
      fig.innerHTML = `<img src="${esc(src)}" alt="${esc(it.title || it.originalName || '')}">`;
    }
    $('#lbDate').textContent = (it.takenAt ? '拍摄于 ' + fmtFull(it.takenAt) : '上传于 ' + fmtFull(it.uploadedAt));
    $('#lbTitle').textContent = it.title || it.originalName || '未命名';
    $('#lbNote').textContent = it.note || '';
    const exifBits = [];
    if (it.width && it.height) exifBits.push(`${it.width} × ${it.height}`);
    if (it.type === 'video' && it.duration) exifBits.push(fmtDur(it.duration));
    if (it.size) exifBits.push(fmtSize(it.size));
    if (it.exif && it.exif.model) exifBits.push(it.exif.model);
    if (it.exif && it.exif.gps) exifBits.push(`${it.exif.gps.lat.toFixed(4)}, ${it.exif.gps.lon.toFixed(4)}`);
    exifBits.push(`${state.lightboxIndex + 1} / ${list.length}`);
    $('#lbMeta').textContent = exifBits.join(' · ');
    $('#lbFav').textContent = it.favorite ? '取消收藏' : '收藏';
    $('#lbFav').classList.toggle('is-on', !!it.favorite);
  }

  function closeLightbox() {
    $('#lightbox').hidden = true;
    $('#lbFigure').innerHTML = '';
    document.body.style.overflow = '';
    state.lightboxIndex = -1;
  }

  function stepLightbox(d) {
    const list = state.lightboxList || [];
    if (!list.length) return;
    state.lightboxIndex = (state.lightboxIndex + d + list.length) % list.length;
    paintLightbox();
  }

  async function patchMedia(id, patch) {
    const it = state.media.find((m) => m.id === id);
    if (!it) return;
    Object.assign(it, patch);
    if (state.online) {
      try {
        const r = await fetch(`${state.base}/api/media`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids: [id], patch }),
        });
        if (!r.ok) throw new Error('HTTP ' + r.status);
      } catch (e) {
        toast('保存失败，稍后再试');
      }
    }
    renderChrome();
    renderAlbum();
    renderStories();
    paintLightbox();
  }

  async function deleteMedia(id) {
    if (!confirm('把这张照片/这段视频从图册里移出？文件也会一起删除。')) return;
    if (!state.online) {
      state.media = state.media.filter((m) => m.id !== id);
      closeLightbox();
      renderAll();
      toast('已移出（演示模式不会真正删除文件）');
      return;
    }
    try {
      const r = await fetch(`${state.base}/api/media`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [id], delete: true }),
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const data = await r.json();
      state.media = data.items;
      state.stories.forEach((s) => { s.mediaIds = (s.mediaIds || []).filter((x) => x !== id); });
      closeLightbox();
      renderAll();
      toast('已移出图册');
    } catch (e) {
      toast('删除失败：' + e.message);
    }
  }

  /* ---------------------------------------------------------------- 上传 */

  function openSheet(id) {
    const el = $(id);
    el.hidden = false;
    document.body.style.overflow = 'hidden';
    const first = el.querySelector('input, textarea, button');
    if (first) setTimeout(() => first.focus({ preventScroll: true }), 60);
  }
  function closeSheet(el) {
    (el || $('.sheet:not([hidden])')).hidden = true;
    if (!$('.sheet:not([hidden])')) document.body.style.overflow = '';
  }

  async function uploadFiles(files) {
    const list = Array.from(files).filter((f) => /^(image|video)\//.test(f.type) || /\.(heic|heif)$/i.test(f.name));
    if (!list.length) { toast('这些文件不是照片或视频'); return; }

    const ul = $('#uploadList');
    const rows = new Map();
    list.forEach((f) => {
      const li = document.createElement('li');
      const url = URL.createObjectURL(f);
      li.innerHTML = `<span class="thumb" style="background-image:url('${url}')"></span>
        <span class="name">${esc(f.name)}<br><span class="muted">${esc(fmtSize(f.size))}</span></span>
        <span class="state">排队中</span>`;
      ul.prepend(li);
      rows.set(f, li);
    });

    if (!state.online) {
      await new Promise((r) => setTimeout(r, 400));
      rows.forEach((li) => {
        li.querySelector('.state').textContent = '演示模式：未上传';
        li.querySelector('.state').classList.add('err');
      });
      toast('当前是离线演示模式，起服务后就能真正上传（见 README）');
      return;
    }

    $('#uploadProgress').hidden = false;
    const total = list.length;
    let done = 0;

    for (const f of list) {
      const li = rows.get(f);
      const st = li.querySelector('.state');
      st.textContent = '上传中…';
      try {
        await uploadOne(f, (pct) => {
          st.textContent = `${Math.min(100, Math.round(pct))}%`;
        });
        done++;
        st.textContent = '✓ 已加入';
        st.classList.add('ok');
        $('#uploadProgress').querySelector('span').style.width = `${(done / total) * 100}%`;
      } catch (e) {
        st.textContent = '失败：' + e.message;
        st.classList.add('err');
      }
    }

    // 重新拉一次，拿服务端的 EXIF 排序结果
    try {
      const data = await apiBootstrap();
      state.media = data.media;
      state.stories = data.stories;
      state.pet = data.pet;
      renderAll();
    } catch (_) {}

    setTimeout(() => { $('#uploadProgress').hidden = true; $('#uploadProgress').querySelector('span').style.width = '0'; }, 900);
    toast(`完成，${done}/${total} 个文件已加入图册`);
  }

  function uploadOne(file, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      const fd = new FormData();
      fd.append('files', file, file.name);
      const isAudio = /^audio\//.test(file.type) || /\.(mp3|m4a|aac|ogg|wav|flac)$/i.test(file.name);
      if (isAudio) fd.append('kind', 'music');
      xhr.open('POST', `${state.base}/api/upload`);
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable && onProgress) onProgress((e.loaded / e.total) * 100);
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) resolve(JSON.parse(xhr.responseText || '{}'));
        else {
          let msg = 'HTTP ' + xhr.status;
          try { msg = JSON.parse(xhr.responseText).error || msg; } catch (_) {}
          reject(new Error(msg));
        }
      };
      xhr.onerror = () => reject(new Error('网络错误'));
      xhr.send(fd);
    });
  }

  /* ---------------------------------------------------------------- 故事编辑 */

  function openStoryEditor(id) {
    state.storyEditing = id || null;
    const s = id ? state.stories.find((x) => x.id === id) : null;
    $('#storyTitle').textContent = s ? '编辑故事' : '写一个故事';
    $('#storyId').value = s ? s.id : '';
    $('#storyInputTitle').value = s ? s.title : '';
    $('#storyInputDate').value = s ? (s.date || '').slice(0, 10) : new Date().toISOString().slice(0, 10);
    $('#storyInputMood').value = s ? (s.mood || '') : '';
    $('#storyInputBody').value = s ? (s.body || '') : '';
    $('#btnDeleteStory').hidden = !s;
    state.pickedMedia = new Set(s ? (s.mediaIds || []) : []);

    const picker = $('#mediaPicker');
    if (!state.media.length) {
      picker.innerHTML = `<p class="muted" style="grid-column:1/-1;margin:0">还没有照片，先去图册上传几张吧。</p>`;
    } else {
      picker.innerHTML = state.media.map((m) =>
        `<button type="button" data-pick="${esc(m.id)}" class="${state.pickedMedia.has(m.id) ? 'is-on' : ''}"
          style="background-image:url('${esc(thumbOf(m))}')" aria-label="${esc(m.title || m.originalName || '')}"></button>`
      ).join('');
      $$('[data-pick]', picker).forEach((b) => {
        b.addEventListener('click', () => {
          const mid = b.dataset.pick;
          if (state.pickedMedia.has(mid)) state.pickedMedia.delete(mid);
          else state.pickedMedia.add(mid);
          b.classList.toggle('is-on');
        });
      });
    }
    openSheet('#storySheet');
  }

  async function saveStory(e) {
    e.preventDefault();
    const payload = {
      title: $('#storyInputTitle').value.trim() || '未命名故事',
      date: $('#storyInputDate').value || new Date().toISOString().slice(0, 10),
      mood: $('#storyInputMood').value,
      body: $('#storyInputBody').value,
      mediaIds: [...state.pickedMedia],
    };
    const id = $('#storyId').value;
    if (!state.online) {
      if (id) {
        const s = state.stories.find((x) => x.id === id);
        Object.assign(s, payload);
      } else {
        state.stories.unshift({ id: 'local_' + Date.now(), ...payload });
      }
      closeSheet($('#storySheet'));
      renderChrome(); renderStories();
      toast('已保存（演示模式，刷新会丢）');
      return;
    }
    try {
      const url = id ? `${state.base}/api/stories/${id}` : `${state.base}/api/stories`;
      const r = await fetch(url, {
        method: id ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const data = await r.json();
      state.stories = data.items;
      closeSheet($('#storySheet'));
      renderChrome(); renderStories();
      toast(id ? '故事已更新' : '故事已收进册子');
    } catch (err) {
      toast('保存失败：' + err.message);
    }
  }

  async function deleteStory() {
    const id = $('#storyId').value;
    if (!id || !confirm('删除这篇故事？')) return;
    if (!state.online) {
      state.stories = state.stories.filter((s) => s.id !== id);
      closeSheet($('#storySheet'));
      renderChrome(); renderStories();
      return;
    }
    try {
      const r = await fetch(`${state.base}/api/stories/${id}`, { method: 'DELETE' });
      const data = await r.json();
      state.stories = data.items;
      closeSheet($('#storySheet'));
      renderChrome(); renderStories();
      toast('已删除');
    } catch (e) {
      toast('删除失败');
    }
  }

  /* ---------------------------------------------------------------- 宠物信息 & 导出 */

  function openPetEditor() {
    const p = state.pet || {};
    const pet = p.pet || {};
    $('#petName').value = pet.name || '';
    $('#petSpecies').value = pet.species || '';
    $('#petBreed').value = pet.breed || '';
    $('#petBirthday').value = (pet.birthday || '').slice(0, 10);
    $('#petHome').value = (pet.homeDate || '').slice(0, 10);
    $('#petBio').value = pet.bio || '';
    $('#siteTitle').value = p.siteTitle || '';
    openSheet('#petSheet');
  }

  async function savePet(e) {
    e.preventDefault();
    const body = {
      siteTitle: $('#siteTitle').value.trim() || '毛毛的小角落',
      pet: {
        name: $('#petName').value.trim() || '毛毛',
        species: $('#petSpecies').value.trim(),
        breed: $('#petBreed').value.trim(),
        birthday: $('#petBirthday').value,
        homeDate: $('#petHome').value,
        bio: $('#petBio').value,
      },
    };
    state.pet = { ...(state.pet || {}), ...body, pet: { ...((state.pet || {}).pet || {}), ...body.pet } };
    if (state.online) {
      try {
        const r = await fetch(`${state.base}/api/pet`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const data = await r.json();
        if (data.pet) state.pet = data.pet;
      } catch (_) { toast('保存失败'); }
    }
    closeSheet($('#petSheet'));
    renderAll();
    toast('已保存');
  }

  async function exportAlbum() {
    if (!state.online) {
      toast('离线演示模式没有导出能力，起服务后可用');
      return;
    }
    toast('正在打包，照片多的话要等一会儿…', 4000);
    try {
      const r = await fetch(`${state.base}/api/export`, { method: 'POST' });
      const data = await r.json();
      if (!data.url) throw new Error(data.error || '导出失败');
      toast('打包完成，开始下载');
      const a = document.createElement('a');
      a.href = data.url;
      a.download = `${(state.pet.pet || {}).name || 'pet'}-album.html`;
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (e) {
      toast('导出失败：' + e.message);
    }
  }

  /* ---------------------------------------------------------------- 音乐 */

  async function toggleMusic() {
    const audio = $('#bgm');
    const track = ((state.pet || {}).music || {}).track;
    if (!track) {
      // 没有音乐时，点一下就让用户上传一首
      const inp = document.createElement('input');
      inp.type = 'file';
      inp.accept = 'audio/*';
      inp.onchange = async () => {
        const f = inp.files && inp.files[0];
        if (!f) return;
        if (!state.online) { toast('离线演示模式无法上传音乐'); return; }
        try {
          await uploadOne(f, () => {});
          const data = await apiBootstrap();
          state.pet = data.pet;
          renderChrome();
          toast('音乐已上传，再点一次播放');
        } catch (e) { toast('上传失败：' + e.message); }
      };
      inp.click();
      return;
    }
    if (state.musicOn) {
      audio.pause();
      state.musicOn = false;
    } else {
      audio.src = fileURL(track);
      audio.volume = ((state.pet.music || {}).volume || 0.35);
      try { await audio.play(); state.musicOn = true; } catch (_) { toast('浏览器拦住了自动播放，再点一次'); }
    }
    renderChrome();
  }

  /* ---------------------------------------------------------------- 动效 */

  function setupReveal() {
    const io = new IntersectionObserver((entries) => {
      entries.forEach((en) => {
        if (en.isIntersecting) {
          en.target.classList.add('in');
          io.unobserve(en.target);
        }
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.06 });
    $$('.reveal').forEach((el, i) => {
      el.style.transitionDelay = (Number(el.dataset.reveal || i % 5) * 90) + 'ms';
      io.observe(el);
    });
    // 首屏内容在首帧就应可见；IntersectionObserver 对已进入视口的元素只会在下一帧回调，
    // 无头截图与慢设备上会看到半透明的初态，所以首屏直接给 .in，动效交给 CSS 的入场动画
    $$('.hero .reveal').forEach((el) => {
      requestAnimationFrame(() => el.classList.add('in'));
    });
  }

  function setupTopbar() {
    const bar = $('#topbar');
    const onScroll = () => bar.classList.toggle('is-stuck', window.scrollY > 24);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
  }

  function setupParallax() {
    const cards = $$('.floating-card');
    if (!cards.length || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    let rx = 0, ry = 0, tx = 0, ty = 0;

    document.addEventListener('mousemove', (e) => {
      const w = innerWidth, h = innerHeight;
      tx = (e.clientX / w - 0.5) * 2;
      ty = (e.clientY / h - 0.5) * 2;
    });
    const hero = $('#hero');
    document.addEventListener('scroll', () => {
      if (!hero) return;
      const y = Math.min(window.scrollY, 700);
      cards.forEach((c, i) => {
        c.style.setProperty('--sy', `${y * (0.06 + i * 0.03)}px`);
      });
    }, { passive: true });

    const loop = () => {
      rx += (tx - rx) * 0.06;
      ry += (ty - ry) * 0.06;
      cards.forEach((c, i) => {
        const depth = 8 + i * 6;
        c.style.transform = `translate3d(${rx * depth}px, calc(${ry * depth}px + var(--sy, 0px)), 0) rotate(${[-7, 6, -2][i]}deg)`;
      });
      const pet = $('.hero-pet');
      if (pet) pet.style.transform = `translate3d(${rx * 14}px, ${ry * 10}px, 0)`;
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  function setupIntersectionPlay() {
    // 视频进入视口自动静音播放
    const io = new IntersectionObserver((entries) => {
      entries.forEach((en) => {
        const v = en.target;
        if (v.tagName !== 'VIDEO') return;
        if (en.isIntersecting) {
          if (!v.src && v.dataset.src) v.src = v.dataset.src;
          v.play().catch(() => {});
        } else {
          v.pause();
        }
      });
    }, { threshold: 0.45 });
    const attach = () => $$('.media video').forEach((v) => { if (!v.dataset.io) { v.dataset.io = '1'; io.observe(v); } });
    attach();
    const mo = new MutationObserver(attach);
    mo.observe($('.album-body'), { childList: true, subtree: true });
  }

  /* ---------------------------------------------------------------- 事件绑定 */

  function bindEvents() {
    // 上传
    $$('[data-open-upload]').forEach((b) => b.addEventListener('click', () => openSheet('#uploadSheet')));
    $('#btnUpload').addEventListener('click', () => openSheet('#uploadSheet'));
    $('#menuUpload').addEventListener('click', () => { hideMenu(); openSheet('#uploadSheet'); });
    $('#btnPickFiles').addEventListener('click', () => $('#fileInput').click());
    $('#dropzone').addEventListener('click', () => $('#fileInput').click());
    $('#dropzone').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') $('#fileInput').click(); });
    $('#fileInput').addEventListener('change', (e) => {
      if (e.target.files && e.target.files.length) uploadFiles(e.target.files);
      e.target.value = '';
    });

    const dz = $('#dropzone');
    ['dragenter', 'dragover'].forEach((t) => dz.addEventListener(t, (e) => {
      e.preventDefault(); dz.classList.add('is-over');
    }));
    ['dragleave', 'drop'].forEach((t) => dz.addEventListener(t, (e) => {
      e.preventDefault(); if (t === 'dragleave' && dz.contains(e.relatedTarget)) return; dz.classList.remove('is-over');
    }));
    dz.addEventListener('drop', (e) => {
      const files = e.dataTransfer && e.dataTransfer.files;
      if (files && files.length) uploadFiles(files);
    });

    // 整页拖拽上传
    let dragDepth = 0;
    window.addEventListener('dragenter', (e) => {
      if (!e.dataTransfer || !Array.from(e.dataTransfer.types || []).includes('Files')) return;
      dragDepth++;
      if (dragDepth === 1) openSheet('#uploadSheet');
    });
    window.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); });
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => {
      e.preventDefault();
      dragDepth = 0;
      const files = e.dataTransfer && e.dataTransfer.files;
      if (files && files.length) {
        openSheet('#uploadSheet');
        uploadFiles(files);
      }
    });

    // 关闭弹层
    $$('[data-close]').forEach((b) => b.addEventListener('click', (e) => closeSheet(e.target.closest('.sheet'))));
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (!$('#lightbox').hidden) closeLightbox();
        else if ($('.sheet:not([hidden])')) closeSheet($('.sheet:not([hidden])'));
        hideMenu();
      }
      if (!$('#lightbox').hidden) {
        if (e.key === 'ArrowLeft') stepLightbox(-1);
        if (e.key === 'ArrowRight') stepLightbox(1);
      }
    });

    // 视图切换
    $$('[data-view]').forEach((b) => b.addEventListener('click', () => {
      $$('[data-view]').forEach((x) => { x.classList.toggle('active', x === b); x.setAttribute('aria-selected', x === b); });
      state.view = b.dataset.view;
      renderAlbum();
    }));
    $$('[data-story-view]').forEach((b) => b.addEventListener('click', () => {
      $$('[data-story-view]').forEach((x) => { x.classList.toggle('active', x === b); x.setAttribute('aria-selected', x === b); });
      state.storyView = b.dataset.storyView;
      renderStories();
    }));

    // 筛选 / 排序 / 搜索
    $$('#typeChips .chip').forEach((b) => b.addEventListener('click', () => {
      $$('#typeChips .chip').forEach((x) => x.classList.toggle('active', x === b));
      state.filter = b.dataset.type;
      state.shown = state.pageSize;
      renderAlbum();
    }));
    $('#sortMode').addEventListener('change', (e) => {
      state.sort = e.target.value;
      state.shown = state.pageSize;
      renderAlbum();
    });
    let searchTimer = null;
    $('#searchInput').addEventListener('input', (e) => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        state.query = e.target.value;
        state.shown = state.pageSize;
        renderAlbum();
      }, 180);
    });
    $('#loadMore').addEventListener('click', () => {
      state.shown += state.pageSize;
      renderAlbum();
    });

    // 故事
    $('#btnNewStory').addEventListener('click', () => openStoryEditor(null));
    $('#btnNewStory2').addEventListener('click', () => openStoryEditor(null));
    $('#menuStory').addEventListener('click', () => { hideMenu(); openStoryEditor(null); });
    $('#storyForm').addEventListener('submit', saveStory);
    $('#btnDeleteStory').addEventListener('click', deleteStory);

    // 宠物信息
    $('#btnEditPet').addEventListener('click', openPetEditor);
    $('#menuPet').addEventListener('click', () => { hideMenu(); openPetEditor(); });
    $('#petForm').addEventListener('submit', savePet);

    // 导出
    $('#btnExport').addEventListener('click', exportAlbum);
    $('#menuExport').addEventListener('click', () => { hideMenu(); exportAlbum(); });

    // 音乐
    $('#btnMusic').addEventListener('click', toggleMusic);
    $('#menuMusic').addEventListener('click', () => { hideMenu(); toggleMusic(); });

    // 更多菜单
    $('#btnMenu').addEventListener('click', (e) => {
      e.stopPropagation();
      const pop = $('#menuPop');
      pop.hidden = !pop.hidden;
    });
    document.addEventListener('click', (e) => {
      const pop = $('#menuPop');
      if (!pop.hidden && !pop.contains(e.target) && e.target !== $('#btnMenu')) hideMenu();
    });

    // 灯箱
    $$('[data-lb-close]').forEach((b) => b.addEventListener('click', closeLightbox));
    $$('[data-lb-prev]').forEach((b) => b.addEventListener('click', () => stepLightbox(-1)));
    $$('[data-lb-next]').forEach((b) => b.addEventListener('click', () => stepLightbox(1)));
    $('#lightbox').addEventListener('click', (e) => {
      if (e.target.id === 'lightbox') closeLightbox();
    });
    $('#lbFav').addEventListener('click', () => {
      const it = (state.lightboxList || [])[state.lightboxIndex];
      if (it) patchMedia(it.id, { favorite: !it.favorite });
    });
    $('#lbDelete').addEventListener('click', () => {
      const it = (state.lightboxList || [])[state.lightboxIndex];
      if (it) deleteMedia(it.id);
    });

    // 键盘左右翻页
    document.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft' && !$('#lightbox').hidden) stepLightbox(-1);
      if (e.key === 'ArrowRight' && !$('#lightbox').hidden) stepLightbox(1);
    });
  }

  function hideMenu() { $('#menuPop').hidden = true; }

  /* ---------------------------------------------------------------- 启动 */

  function renderAll() {
    renderChrome();
    renderAlbum();
    renderStories();
  }

  async function boot() {
    try {
      const data = await apiBootstrap();
      state.online = true;
      state.pet = data.pet;
      state.media = data.media || [];
      state.stories = data.stories || [];
      state.base = data.base || '';
    } catch (_) {
      const demo = demoData();
      state.online = false;
      state.pet = demo.pet;
      state.media = demo.media;
      state.stories = demo.stories;
      // 演示模式下补一个"占位"的媒体来源
      state.base = '';
      setTimeout(() => toast('离线演示模式：看到的是示例内容，起服务后即可上传', 4000), 1200);
    }

    renderAll();
    bindEvents();
    setupReveal();
    setupTopbar();
    setupParallax();
    setupIntersectionPlay();

    requestAnimationFrame(() => {
      document.body.classList.add('loaded');
      setTimeout(() => $('#curtain').classList.add('is-done'), 420);
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
