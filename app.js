// 如菓現場回報 LIFF 前端（快速版：日報＋缺失）。資料一律由後端驗證身分後才回傳；本檔不含任何資料或機密。
(function () {
  var CFG = window.SITE_CONFIG, L = window.SiteLogic;
  var RETRY = CFG.RETRY_MS || [2000, 5000, 10000];
  var $ = function (id) { return document.getElementById(id); };
  var VIEWS = ['v-consent', 'v-home', 'v-daily', 'v-defect', 'v-done', 'v-mine'];
  var st = { init: null, site: '', photos: { daily: [], defect: [] }, nextSeq: { daily: 1, defect: 1 }, formKey: { daily: '', defect: '' },
    startedAt: { daily: '', defect: '' }, trades: [], sel: {}, sending: false, relogin: false, lastDefect: null };

  function show(id) { VIEWS.forEach(function (v) { $(v).classList.toggle('hidden', v !== id); }); window.scrollTo(0, 0); }
  function msg(el, text, kind) { el.textContent = text || ''; el.className = 'msg ' + (kind || '') + (text ? '' : ' hidden'); }
  function fatal(text) { msg($('fatal'), text, 'bad'); }
  function esc(s) { return String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  // ---------------------------------------------------------------- 後端呼叫（逾時／斷線一律丟 NET）
  function api(payload) {
    payload.idToken = liff.getIDToken();
    payload.ua = navigator.userAgent;
    var ctrl = window.AbortController ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, CFG.TIMEOUT_MS || 30000) : null;
    return fetch(CFG.GAS_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(payload), signal: ctrl ? ctrl.signal : undefined })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (timer) clearTimeout(timer);
        if (j && j.code === 'AUTH_FAILED' && !st.relogin) { st.relogin = true; liff.logout(); liff.login({ redirectUri: location.href }); }
        return j;
      }, function () { if (timer) clearTimeout(timer); throw { net: true }; });
  }

  // ---------------------------------------------------------------- 手機暫存（IndexedDB；不支援時退回記憶體）
  var mem = {}, dbp = null;
  function db() {
    if (dbp) return dbp;
    dbp = new Promise(function (res) {
      try {
        var rq = indexedDB.open('ruguo-site-report', 1);
        rq.onupgradeneeded = function () { rq.result.createObjectStore('drafts', { keyPath: 'submitKey' }); };
        rq.onsuccess = function () { res(rq.result); };
        rq.onerror = function () { res(null); };
      } catch (e) { res(null); }
    });
    return dbp;
  }
  function tx(mode, fn) {
    return db().then(function (d) {
      if (!d) return fn(null);
      return new Promise(function (res) {
        var t = d.transaction('drafts', mode), s = t.objectStore('drafts'), out = fn(s);
        t.oncomplete = function () { res(out && out.result !== undefined ? out.result : undefined); };
        t.onerror = function () { res(undefined); };
      });
    });
  }
  function draftPut(d) { return tx('readwrite', function (s) { if (!s) { mem[d.submitKey] = d; return null; } return s.put(d); }); }
  function draftDel(k) { return tx('readwrite', function (s) { if (!s) { delete mem[k]; return null; } return s.delete(k); }); }
  function draftAll() { return tx('readonly', function (s) { if (!s) return { result: Object.keys(mem).map(function (k) { return mem[k]; }) }; return s.getAll(); }).then(function (r) { return r || []; }); }

  // ---------------------------------------------------------------- 照片處理：讀拍攝時間 → 算雜湊 → 壓縮
  function compress(file) {
    var edge = st.init.settings.PHOTO_EDGE_PX, q = Number(st.init.settings.PHOTO_JPEG_Q);
    var load = window.createImageBitmap ? createImageBitmap(file, { imageOrientation: 'from-image' }).catch(function () { return createImageBitmap(file); })
      : new Promise(function (res, rej) { var img = new Image(); img.onload = function () { res(img); }; img.onerror = rej; img.src = URL.createObjectURL(file); });
    return load.then(function (img) {
      var w = img.width, h = img.height, k = Math.min(1, edge / Math.max(w, h));
      var c = document.createElement('canvas'); c.width = Math.round(w * k); c.height = Math.round(h * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      return c.toDataURL('image/jpeg', q);
    });
  }
  function processFile(file, purpose, reportDate) {
    return file.arrayBuffer().then(function (buf) {
      var exif = L.exifDate(buf), shotAt = exif, source = exif ? 'EXIF' : '無';
      if (!exif && file.lastModified) { shotAt = L.fmtLocal(file.lastModified); source = '檔案時間'; }
      var hashP = window.crypto && crypto.subtle ? crypto.subtle.digest('SHA-256', buf).then(L.hex) : Promise.resolve(L.uuid().replace(/-/g, ''));
      return Promise.all([hashP, compress(file)]).then(function (r) {
        var b64 = r[1].split(',')[1];
        var chk = source === '無' ? { ok: false, why: '讀不到拍攝時間' } : L.windowCheck(shotAt, reportDate, Date.now(), st.init.settings.PHOTO_WINDOW_H);
        return { purpose: purpose, hash: r[0], shotAt: shotAt, timeSource: source, b64: b64, preview: r[1], check: chk };
      });
    });
  }
  function addPhotos(kind, files, reportDate) {
    var list = st.photos[kind], max = st.init.settings.PHOTO_MAX;
    var arr = Array.prototype.slice.call(files, 0, Math.max(0, max - list.length));
    var purpose = kind === 'daily' ? '日報' : '缺失提出';
    return arr.reduce(function (p, f) {
      return p.then(function () {
        return processFile(f, purpose, reportDate).then(function (ph) {
          if (list.some(function (x) { return x.hash === ph.hash; })) return;
          ph.seq = st.nextSeq[kind]++; list.push(ph);
        }, function () { /* 讀不了的檔略過 */ });
      });
    }, Promise.resolve()).then(function () { renderThumbs(kind); });
  }
  function renderThumbs(kind) {
    var box = $(kind === 'daily' ? 'd-thumbs' : 'q-thumbs');
    box.innerHTML = st.photos[kind].map(function (p, i) {
      return '<div class="thumb' + (p.check.ok ? '' : ' bad') + '"><img alt="" src="' + p.preview + '"><button class="x" data-rm="' + kind + ':' + i + '" aria-label="移除">×</button>' +
        '<div class="tag">' + (p.check.ok ? '今天 ' + esc(p.shotAt.slice(11, 16)) : esc(p.check.why) + '・不列入') + '</div></div>';
    }).join('');
  }

  // ---------------------------------------------------------------- 送出（送出 → 照片逐張 → 完成；斷線就暫存）
  function uploadPhoto(id, p) {
    var attempt = 0;
    function once() {
      return api({ action: 'photo', id: id, seq: p.seq, purpose: p.purpose, b64: p.b64, hash: p.hash, shotAt: p.shotAt, timeSource: p.timeSource })
        .then(function (r) { if (!r || !r.ok) throw { server: r }; return r; })
        .catch(function (e) {
          if (e && e.server && e.server.code !== 'SERVER_ERROR') throw e;
          if (attempt >= RETRY.length) throw e;
          return sleep(RETRY[attempt++]).then(once);
        });
    }
    return once();
  }
  function sendDraft(d, progress) {
    return api(Object.assign({ action: 'submit', submitKey: d.submitKey, kind: d.kind, site: d.site }, d.payload)).then(function (r) {
      if (!r.ok) throw { server: r };
      d.id = r.id;
      var got = r.received || [], todo = d.photos.filter(function (p) { return got.indexOf(p.seq) < 0; });
      if (r.status && r.status !== '上傳中') return { resumed: true };
      var n = 0;
      return todo.reduce(function (pr, p) {
        return pr.then(function () { progress('照片 ' + (++n) + '／' + todo.length + ' 上傳中…'); return uploadPhoto(d.id, p); });
      }, Promise.resolve());
    }).then(function () {
      progress('確認中…');
      return api({ action: 'finalize', id: d.id });
    }).then(function (f) {
      if (!f.ok) throw { server: f };
      return f;
    });
  }

  function buildDaily() {
    var details = st.trades.map(function (t) {
      var hc = document.querySelector('[data-hc="' + t + '"]'), pc = document.querySelector('[data-pc="' + t + '"]');
      return { trade: t, headcount: hc && hc.value !== '' ? Number(hc.value) : '', pct: pc && pc.value !== '' ? Number(pc.value) : '' };
    });
    return { date: $('d-date').value, summary: $('d-summary').value.trim(), details: details, tomorrow: $('d-tomorrow').value.trim(), issue: $('d-issue').value.trim(), startedAt: st.startedAt.daily };
  }
  function buildDefect() {
    return { source: $('q-source').value, space: st.sel.space || '', spaceNote: $('q-spacenote').value.trim(), type: st.sel.type || '', desc: $('q-desc').value.trim(),
      severity: st.sel.sev || '', trade: $('q-trade').value, startedAt: st.startedAt.defect };
  }
  function precheck(kind, p) {
    if (kind === 'daily' && p.summary.replace(/\s/g, '').length < 4) return '「今天一句話」至少 4 個字';
    if (kind === 'defect') {
      if (!p.space) return '請選位置'; if (!p.type) return '請選缺失類型';
      if (p.desc.replace(/\s/g, '').length < 2) return '請寫缺失描述'; if (!p.severity) return '請選嚴重度';
    }
    var valid = st.photos[kind].filter(function (x) { return x.check.ok; }).length;
    if (!st.photos[kind].length) return '請先拍照（至少 1 張）';
    if (valid < st.init.settings.PHOTO_MIN) return '需要至少 ' + st.init.settings.PHOTO_MIN + ' 張今天拍的照片；舊照片不列入，請重拍';
    return '';
  }
  function submitForm(kind) {
    if (st.sending) return;
    var m = $(kind === 'daily' ? 'd-msg' : 'q-msg'), btn = $(kind === 'daily' ? 'd-send' : 'q-send');
    var payload = kind === 'daily' ? buildDaily() : buildDefect();
    var err = precheck(kind, payload);
    if (err) return msg(m, err, 'bad');
    st.sending = true; btn.disabled = true; msg(m, '送出中…', '');
    if (!st.formKey[kind]) st.formKey[kind] = L.uuid();
    Promise.resolve().then(function () {
      payload.loc = null; payload.locNote = '不同意定位'; // 10/22 老闆指示：不蒐集定位，固定走「不同意定位」路徑
      var siteObj = curSite();
      var d = { submitKey: st.formKey[kind], kind: kind, site: st.site, siteName: siteObj ? siteObj.name : st.site, payload: payload,
        photos: st.photos[kind].map(function (p) { return { seq: p.seq, purpose: p.purpose, b64: p.b64, hash: p.hash, shotAt: p.shotAt, timeSource: p.timeSource }; }),
        createdAt: L.fmtLocal(Date.now()).slice(0, 16) };
      return draftPut(d).then(function () {
        return sendDraft(d, function (t) { msg(m, t, ''); });
      }).then(function (f) {
        return draftDel(d.submitKey).then(function () { onDone(kind, d, f); });
      }, function (e) {
        if (e && e.net) { msg(m, '網路不穩，已暫存在這支手機。有訊號時打開「現場回報」會提醒你補送。', 'warn'); return refreshDrafts(); }
        var r = (e && e.server) || {};
        return draftDel(d.submitKey).then(function () {
          if (r.code === 'NO_VALID_PHOTO') msg(m, (r.message || '需要今天拍的照片') + '。請補拍後再按送出（同一筆不會重複）。', 'bad');
          else msg(m, r.message || ('送出失敗（' + (r.code || '未知') + '）'), 'bad');
        });
      });
    }).then(function () { st.sending = false; btn.disabled = false; });
  }

  function onDone(kind, d, f) {
    var siteObj = curSite();
    $('done-id').textContent = d.id;
    $('done-detail').textContent = (siteObj ? siteObj.code + '｜' + siteObj.name : d.site) + '｜有效照片 ' + f.valid + ' 張' + (f.deadline ? '｜期限 ' + f.deadline : '');
    var flags = [];
    if (f.outside) flags.push(f.outside + ' 張照片不是今天拍的，不列入照片數');
    if (f.dup) flags.push(f.dup + ' 張照片和以前送過的重複，不列入');
    $('done-flags').innerHTML = flags.map(function (x) { return '<div class="msg warn">' + esc(x) + '</div>'; }).join('');
    $('done-same').classList.toggle('hidden', kind !== 'defect');
    st.lastDefect = kind === 'defect' ? { space: d.payload.space, spaceNote: d.payload.spaceNote, source: d.payload.source } : null;
    resetForm(kind);
    show('v-done');
    if (CFG.RECEIPT && liff.isInClient && liff.isInClient() && liff.sendMessages) {
      var label = kind === 'daily' ? '日報' : '缺失';
      liff.sendMessages([{ type: 'text', text: '【現場回報】' + d.site + ' ' + label + '已送出｜' + d.id + '｜照片 ' + f.valid + ' 張｜' + L.fmtLocal(Date.now()).slice(11, 16) }]).catch(function () {});
    }
  }
  function resetForm(kind) {
    st.photos[kind] = []; st.nextSeq[kind] = 1; st.formKey[kind] = ''; renderThumbs(kind);
    if (kind === 'daily') { $('d-summary').value = ''; $('d-issue').value = ''; }
    else { $('q-desc').value = ''; $('q-spacenote').value = ''; st.sel = {}; }
  }

  // ---------------------------------------------------------------- 未送出草稿
  function refreshDrafts() {
    return draftAll().then(function (list) {
      var bar = $('draftbar');
      if (!list.length) { bar.classList.add('hidden'); bar.innerHTML = ''; return; }
      bar.classList.remove('hidden');
      bar.innerHTML = list.map(function (d) {
        return '<div>有 1 份 ' + esc(d.createdAt.slice(5, 10)) + ' ' + (d.kind === 'daily' ? '日報' : '缺失') + '（' + esc(d.siteName) + '，' + d.photos.length + ' 張照片）未送出</div>' +
          '<button class="btn small" data-resend="' + d.submitKey + '">補送</button><button class="btn small secondary" data-drop="' + d.submitKey + '">捨棄</button>';
      }).join('') + '<div class="note" id="draftmsg"></div>';
    });
  }
  function resend(key) {
    if (st.sending) return;
    st.sending = true;
    draftAll().then(function (list) {
      var d = list.filter(function (x) { return x.submitKey === key; })[0];
      if (!d) return;
      var note = function (t) { var n = $('draftmsg'); if (n) n.textContent = t; };
      return sendDraft(d, note).then(function (f) {
        return draftDel(key).then(function () { st.site = d.site; onDone(d.kind, d, f); });
      }, function (e) {
        if (e && e.net) return note('仍然連不上，稍後再試');
        var r = (e && e.server) || {};
        return draftDel(key).then(refreshDrafts).then(function () { fatal('補送失敗：' + (r.message || r.code)); });
      });
    }).then(function () { st.sending = false; return refreshDrafts(); });
  }

  // ---------------------------------------------------------------- 首頁／表單渲染
  function curSite() { return (st.init.sites || []).filter(function (s) { return s.code === st.site; })[0]; }
  function renderHeader(label) {
    var s = curSite();
    $('siteline').textContent = (s ? s.code + '｜' + s.name : '請選案場') + (label ? '｜' + label : '');
  }
  function renderHome() {
    var s = curSite();
    $('sitestat').textContent = s ? '今天已送 ' + s.todayDaily + ' 份日報・此案 ' + s.openDefects + ' 筆缺失未結' + (s.phase ? '・' + s.phase : '') : '';
    renderHeader('');
    show('v-home');
  }
  function chipGroup(boxId, values, key, multi) {
    var box = $(boxId);
    box.innerHTML = values.map(function (v) { return '<button type="button" class="chip" data-chip="' + key + '" data-v="' + esc(v) + '" aria-pressed="false">' + esc(v) + '</button>'; }).join('');
    box.onclick = function (e) {
      var b = e.target.closest('[data-chip]'); if (!b) return;
      if (multi) { b.setAttribute('aria-pressed', b.getAttribute('aria-pressed') === 'true' ? 'false' : 'true'); }
      else { box.querySelectorAll('.chip').forEach(function (x) { x.setAttribute('aria-pressed', x === b ? 'true' : 'false'); }); st.sel[key] = b.dataset.v; }
      if (key === 'trade') { st.trades = Array.prototype.map.call(box.querySelectorAll('[aria-pressed="true"]'), function (x) { return x.dataset.v; }); renderDetails(); }
    };
  }
  function pressChip(boxId, v) { var b = $(boxId).querySelector('[data-v="' + v + '"]'); if (b) b.click(); }
  function renderDetails() {
    var s = curSite(), last = (s && s.lastPct) || {};
    var keep = {};
    document.querySelectorAll('[data-pc]').forEach(function (x) { keep[x.dataset.pc] = x.value; });
    $('d-details').innerHTML = st.trades.length ? '<div class="detail note"><span>工種</span><span>人數</span><span>累計%</span></div>' + st.trades.map(function (t) {
      var pv = keep[t] !== undefined ? keep[t] : (last[t] !== undefined ? last[t] : '');
      return '<div class="detail"><span>' + esc(t) + '</span><input class="input" type="number" inputmode="numeric" min="0" max="99" data-hc="' + esc(t) + '">' +
        '<input class="input" type="number" inputmode="numeric" min="0" max="100" data-pc="' + esc(t) + '" value="' + esc(pv) + '"></div>';
    }).join('') + '<div class="note">累計% 填 100＝這個工項完成</div>' : '';
  }
  function openDaily() {
    if (!st.site) return fatal('請先選案場');
    var s = curSite();
    st.startedAt.daily = L.fmtLocal(Date.now()).slice(0, 16);
    var today = st.init.today, opts = [today];
    for (var i = 1; i <= st.init.settings.BACKFILL_DAYS; i++) opts.push(L.fmtLocal(L.parseLocal(today + ' 12:00') - i * 86400000).slice(0, 10));
    $('d-date').innerHTML = opts.map(function (d, i) { return '<option value="' + d + '">' + d + (i === 0 ? '（今天）' : '（補報）') + '</option>'; }).join('');
    st.trades = [];
    chipGroup('d-trades', st.init.codes.trades, 'trade', true);
    (s.todayTrades || []).forEach(function (t) { pressChip('d-trades', t); });
    renderDetails();
    $('d-tomorrow').value = s.nextTrade || '';
    msg($('d-msg'), '');
    renderHeader('日報'); show('v-daily');
  }
  function openDefect(keep) {
    if (!st.site) return fatal('請先選案場');
    var s = curSite(), c = st.init.codes;
    st.startedAt.defect = L.fmtLocal(Date.now()).slice(0, 16);
    st.sel = {};
    chipGroup('q-space', c.spaces, 'space'); chipGroup('q-type', c.defectTypes, 'type'); chipGroup('q-sev', ['A 影響交屋／安全', 'B 須改善', 'C 小瑕疵'], 'sevlabel');
    $('q-sev').onclick = (function (orig) { return function (e) { orig(e); var b = e.target.closest('[data-chip]'); if (b) st.sel.sev = b.dataset.v.charAt(0); }; })($('q-sev').onclick);
    $('q-trade').innerHTML = c.trades.map(function (t) { return '<option>' + esc(t) + '</option>'; }).join('');
    $('q-trade').value = (s.todayTrades && s.todayTrades[0]) || '系統櫃';
    $('q-source').innerHTML = c.sources.map(function (t) { return '<option>' + esc(t) + '</option>'; }).join('');
    $('q-source').value = s.phase === '待交屋' ? '交屋驗收' : '施工自檢';
    if (keep) { pressChip('q-space', keep.space); $('q-spacenote').value = keep.spaceNote || ''; $('q-source').value = keep.source; }
    msg($('q-msg'), '');
    renderHeader('缺失'); show('v-defect');
  }

  // ---------------------------------------------------------------- 我的回報（缺失改善／複查）
  function openMine() {
    renderHeader('我的回報'); show('v-mine');
    $('mine-defects').innerHTML = '<div class="note">載入中…</div>'; $('mine-daily').innerHTML = '';
    return api({ action: 'mine' }).then(function (r) {
      if (!r.ok) return fatal(r.message || r.code);
      var ds = r.defects.filter(function (d) { return d.status !== '結案'; });
      $('mine-defects').innerHTML = ds.length ? ds.map(function (d) {
        var act = '';
        if (d.canImprove) act += '<label class="btn small" for="imp-' + esc(d.id) + '">上傳改善照並回報</label><input type="file" accept="image/*" multiple class="vh" id="imp-' + esc(d.id) + '" data-imp="' + esc(d.id) + '" data-seq="' + d.nextImproveSeq + '">';
        if (d.canReview) act += '<button class="btn small" data-close="' + esc(d.id) + '">複查通過・結案</button><button class="btn small danger" data-reject="' + esc(d.id) + '">退回重做</button>' +
          '<input class="input mt hidden" data-reason="' + esc(d.id) + '" placeholder="退回原因（一句話）">';
        if (d.status === '待複查' && !d.canReview) act += '<div class="note">待另一位同仁複查</div>';
        return '<div class="item' + (d.overdue ? ' overdue' : '') + '" data-item="' + esc(d.id) + '"><div class="t">' + esc(d.id) + '<span class="badge' + (d.severity === 'A' ? ' a' : '') + '">' + esc(d.severity) + '</span><span class="badge">' + esc(d.status) + '</span></div>' +
          '<div>' + esc(d.siteName || d.site) + '｜' + esc(d.space) + '｜' + esc(d.type) + '</div><div>' + esc(d.desc) + '</div>' +
          '<div class="note">指派 ' + esc(d.trade) + '・期限 ' + esc(d.deadline) + (d.overdue ? '（已逾期）' : '') + '</div>' + act + '<div class="note" data-note="' + esc(d.id) + '"></div></div>';
      }).join('') : '<div class="note">沒有待處理的缺失</div>';
      $('mine-daily').innerHTML = r.daily.length ? r.daily.map(function (d) {
        return '<div class="item"><div class="t">' + esc(d.id) + ' <span class="badge">' + esc(d.status) + '</span></div><div>' + esc(d.summary) + '</div><div class="note">照片 ' + d.photos + ' 張' + (d.outside ? '・' + d.outside + ' 張非今天拍不列入' : '') + '</div></div>';
      }).join('') : '<div class="note">這週還沒有日報</div>';
    }, function () { $('mine-defects').innerHTML = '<div class="msg warn">網路不穩，請稍後再開</div>'; });
  }
  function improve(id, files, seq0) {
    var note = document.querySelector('[data-note="' + id + '"]');
    note.textContent = '處理照片中…';
    var arr = Array.prototype.slice.call(files, 0, 5), seq = Number(seq0), valid = 0;
    return arr.reduce(function (p, f) {
      return p.then(function () {
        return processFile(f, '缺失改善', st.init.today).then(function (ph) {
          ph.seq = seq++; note.textContent = '上傳改善照 ' + (ph.seq - seq0 + 1) + '／' + arr.length + '…';
          return uploadPhoto(id, ph).then(function (r) { if (r.valid) valid++; });
        });
      });
    }, Promise.resolve()).then(function () {
      if (!valid) { note.textContent = '改善照需要今天拍的照片（舊照片或重複照片不算），請重拍'; return; }
      return api({ action: 'defectImprove', id: id }).then(function (r) { note.textContent = r.ok ? '已回報改善，待複查' : (r.message || r.code); if (r.ok) setTimeout(openMine, 600); });
    }, function (e) { note.textContent = e && e.net ? '網路不穩，請到訊號好的地方再試' : '上傳失敗：' + ((e.server && (e.server.message || e.server.code)) || ''); });
  }
  function review(id, decision) {
    var note = document.querySelector('[data-note="' + id + '"]'), reason = document.querySelector('[data-reason="' + id + '"]');
    if (decision === 'reject' && reason.classList.contains('hidden')) { reason.classList.remove('hidden'); reason.focus(); note.textContent = '寫一句退回原因，再按一次「退回重做」'; return; }
    api({ action: 'defectReview', id: id, decision: decision, reason: reason ? reason.value : '' }).then(function (r) {
      note.textContent = r.ok ? (decision === 'close' ? '已結案' : '已退回，待改善') : (r.message || r.code);
      if (r.ok) setTimeout(openMine, 600);
    }, function () { note.textContent = '網路不穩，請稍後再試'; });
  }

  // ---------------------------------------------------------------- 個資告知
  function renderConsent(c) {
    $('consent-title').textContent = c.title; $('consent-text').textContent = c.text; $('consent-ver').textContent = '版本 ' + c.version + (c.draft ? '（草稿，測試用）' : '');
    show('v-consent');
    $('consent-agree').onclick = function () {
      $('consent-agree').disabled = true;
      api({ action: 'consent', decision: 'agree', version: c.version, hash: c.hash, geo: '不同意' }).then(function (r) {
        $('consent-agree').disabled = false;
        if (!r.ok) return msg($('consent-msg'), r.message || r.code, 'bad');
        boot();
      }, function () { $('consent-agree').disabled = false; msg($('consent-msg'), '網路不穩，請再按一次', 'warn'); });
    };
  }

  // ---------------------------------------------------------------- 啟動與事件
  function wire() {
    $('site').onchange = function () { st.site = this.value; try { localStorage.setItem('rsr.site', st.site); } catch (e) {} renderHome(); };
    $('go-daily').onclick = openDaily;
    $('go-defect').onclick = function () { openDefect(null); };
    $('go-mine').onclick = openMine;
    $('d-send').onclick = function () { submitForm('daily'); };
    $('q-send').onclick = function () { submitForm('defect'); };
    $('d-photos').onchange = function () { var f = this.files; addPhotos('daily', f, $('d-date').value || st.init.today).then(function () { $('d-photos').value = ''; }); };
    $('q-photos').onchange = function () { var f = this.files; addPhotos('defect', f, st.init.today).then(function () { $('q-photos').value = ''; }); };
    $('d-date').onchange = function () { var d = this.value; st.photos.daily.forEach(function (p) { p.check = p.timeSource === '無' ? p.check : L.windowCheck(p.shotAt, d, Date.now(), st.init.settings.PHOTO_WINDOW_H); }); renderThumbs('daily'); };
    document.body.addEventListener('click', function (e) {
      var t = e.target;
      if (t.matches('[data-back]')) { boot(); return; }
      if (t.dataset.rm) { var p = t.dataset.rm.split(':'); st.photos[p[0]].splice(+p[1], 1); renderThumbs(p[0]); return; }
      if (t.dataset.resend) { resend(t.dataset.resend); return; }
      if (t.dataset.drop) { if (confirm('確定捨棄這份未送出的回報？')) draftDel(t.dataset.drop).then(refreshDrafts); return; }
      if (t.dataset.close) { review(t.dataset.close, 'close'); return; }
      if (t.dataset.reject) { review(t.dataset.reject, 'reject'); return; }
    });
    document.body.addEventListener('change', function (e) { var t = e.target; if (t.dataset && t.dataset.imp) improve(t.dataset.imp, t.files, Number(t.dataset.seq)); });
    $('done-again').onclick = function () { boot(); };
    $('done-same').onclick = function () { openDefect(st.lastDefect); };
    $('done-close').onclick = function () { if (liff.isInClient && liff.isInClient()) liff.closeWindow(); else boot(); };
  }

  function boot() {
    msg($('fatal'), '');
    return api({ action: 'init' }).then(function (r) {
      if (!r.ok) { $('siteline').textContent = '無法使用'; return fatal(r.message || ('錯誤：' + r.code)); }
      st.init = r;
      if (!r.consent.agreed) { $('siteline').textContent = '個資告知'; return renderConsent(r.consent); }
      var saved = ''; try { saved = localStorage.getItem('rsr.site') || ''; } catch (e) {}
      var codes = r.sites.map(function (s) { return s.code; });
      st.site = codes.indexOf(st.site) >= 0 ? st.site : (codes.indexOf(saved) >= 0 ? saved : (codes.indexOf(r.lastSite) >= 0 ? r.lastSite : (codes[0] || '')));
      $('site').innerHTML = r.sites.map(function (s) { return '<option value="' + esc(s.code) + '">' + esc(s.code + '｜' + s.name) + '</option>'; }).join('');
      $('site').value = st.site;
      if (!codes.length) { fatal('目前沒有可回報的案場'); }
      renderHome();
      var q = new URLSearchParams(location.search);
      if (!boot.routed) { boot.routed = true; if (q.get('p') === 'mine') openMine(); else if (q.get('t') === 'daily') openDaily(); else if (q.get('t') === 'defect') openDefect(null); }
    }, function () { $('siteline').textContent = '離線'; fatal('網路不穩，連不上系統。未送出的回報仍保存在這支手機。'); });
  }

  wire();
  liff.init({ liffId: CFG.LIFF_ID }).then(function () {
    if (!liff.isLoggedIn()) { liff.login({ redirectUri: location.href }); return; }
    refreshDrafts();
    return boot();
  }).catch(function () { fatal('LINE 初始化失敗，請從 LINE 選單重新開啟'); });
})();
