// zip.js — tiny .zip writer (no compression, "stored" entries). Enough to bundle
// a chat's saved documents into one download. Spec: PKWARE APPNOTE 4.3.
(function (root) {
  'use strict';
  const CBT = (root.CBT = root.CBT || {});

  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }
  function dosTime(d) {
    return {
      time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
      date: ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
    };
  }

  // files: [{ name, bytes: Uint8Array, date?: Date }] → Uint8Array (.zip)
  function makeZip(files) {
    const enc = new TextEncoder();
    const used = new Set();
    const locals = [], centrals = [];
    let offset = 0;
    for (const f of files) {
      const clean = f.name.replace(/^\/+/, '').replace(/[\\:*?"<>|]/g, '_');
      let name = clean;
      // de-duplicate: "a.txt", "a (2).txt", …
      for (let i = 2; used.has(name.toLowerCase()); i++) name = clean.replace(/(\.[^./]*)?$/, ` (${i})$1`);
      used.add(name.toLowerCase());
      const nameBytes = enc.encode(name);
      const crc = crc32(f.bytes);
      const { time, date } = dosTime(f.date || new Date());
      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); // UTF-8 names
      lh.setUint16(8, 0, true); lh.setUint16(10, time, true); lh.setUint16(12, date, true);
      lh.setUint32(14, crc, true); lh.setUint32(18, f.bytes.length, true); lh.setUint32(22, f.bytes.length, true);
      lh.setUint16(26, nameBytes.length, true); lh.setUint16(28, 0, true);
      locals.push(new Uint8Array(lh.buffer), nameBytes, f.bytes);
      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true);
      ch.setUint16(10, 0, true); ch.setUint16(12, time, true); ch.setUint16(14, date, true);
      ch.setUint32(16, crc, true); ch.setUint32(20, f.bytes.length, true); ch.setUint32(24, f.bytes.length, true);
      ch.setUint16(28, nameBytes.length, true); ch.setUint32(42, offset, true);
      centrals.push(new Uint8Array(ch.buffer), nameBytes);
      offset += 30 + nameBytes.length + f.bytes.length;
    }
    const cdSize = centrals.reduce((s, b) => s + b.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
    end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
    const parts = [...locals, ...centrals, new Uint8Array(end.buffer)];
    const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
    let p = 0;
    for (const part of parts) { out.set(part, p); p += part.length; }
    return out;
  }

  CBT.zip = { makeZip, crc32 };
  if (typeof module !== 'undefined' && module.exports) module.exports = CBT.zip;
})(typeof globalThis !== 'undefined' ? globalThis : this);
