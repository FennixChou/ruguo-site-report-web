// 前端純函式（瀏覽器與 Node 測試共用）。不含任何資料或機密。
(function (root) {
  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  /** 讀 JPEG EXIF 拍攝時間（DateTimeOriginal，退而求其次 DateTime）-> 'YYYY-MM-DD HH:mm:ss' 或 '' */
  function exifDate(buf) {
    try {
      var v = new DataView(buf);
      if (v.byteLength < 4 || v.getUint16(0) !== 0xFFD8) return '';
      var off = 2;
      while (off + 4 <= v.byteLength) {
        var marker = v.getUint16(off), len = v.getUint16(off + 2);
        if (marker === 0xFFE1 && v.getUint32(off + 4) === 0x45786966) return parseTiff(v, off + 10);
        if ((marker & 0xFF00) !== 0xFF00 || marker === 0xFFDA) return '';
        off += 2 + len;
      }
    } catch (e) { /* 壞檔視為無 EXIF */ }
    return '';
  }
  function parseTiff(v, t) {
    var le = v.getUint16(t) === 0x4949;
    var u16 = function (o) { return v.getUint16(t + o, le); }, u32 = function (o) { return v.getUint32(t + o, le); };
    function readIfd(o) {
      var n = u16(o), out = {};
      for (var i = 0; i < n; i++) {
        var e = o + 2 + i * 12, tag = u16(e), type = u16(e + 2), cnt = u32(e + 4);
        if (type === 2) { var p = cnt > 4 ? u32(e + 8) : e + 8, s = ''; for (var k = 0; k < cnt - 1; k++) s += String.fromCharCode(v.getUint8(t + p + k)); out[tag] = s; }
        else if (type === 4) out[tag] = u32(e + 8);
      }
      return out;
    }
    var ifd0 = readIfd(u32(4)), dt = '';
    if (ifd0[0x8769]) dt = readIfd(ifd0[0x8769])[0x9003] || '';
    if (!dt) dt = ifd0[0x0132] || '';
    var m = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/.exec(dt);
    return m ? m[1] + '-' + m[2] + '-' + m[3] + ' ' + m[4] + ':' + m[5] + ':' + m[6] : '';
  }

  /** 手機本地時間（台北）格式化 */
  function fmtLocal(ms) {
    var d = new Date(ms + 8 * 3600000);
    return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate()) + ' ' + pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes()) + ':' + pad2(d.getUTCSeconds());
  }
  function parseLocal(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(s || '');
    return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)) - 8 * 3600000 : NaN;
  }
  /** 前端預檢（與後端 photoWindow 同規則；最後以後端判定為準） */
  function windowCheck(shotAt, reportDate, nowMs, windowH) {
    var t = parseLocal(shotAt);
    if (isNaN(t)) return { ok: false, why: '讀不到拍攝時間' };
    if (fmtLocal(t).slice(0, 10) !== reportDate) return { ok: false, why: '不是' + (reportDate === fmtLocal(nowMs).slice(0, 10) ? '今天' : '回報日') + '拍的' };
    if (t < nowMs - windowH * 3600000) return { ok: false, why: '超過 ' + windowH + ' 小時前拍的' };
    if (t > nowMs + 10 * 60000) return { ok: false, why: '拍攝時間在未來' };
    return { ok: true, why: '' };
  }

  function uuid() {
    if (root.crypto && root.crypto.randomUUID) return root.crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) { var r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16); });
  }

  function hex(buf) { return Array.prototype.map.call(new Uint8Array(buf), function (b) { return (b < 16 ? '0' : '') + b.toString(16); }).join(''); }

  var api = { exifDate: exifDate, fmtLocal: fmtLocal, parseLocal: parseLocal, windowCheck: windowCheck, uuid: uuid, hex: hex };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.SiteLogic = api;
})(typeof window !== 'undefined' ? window : globalThis);
