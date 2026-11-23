'use strict';
// Util bersama router. Semua respons error memakai { error: string }
// (kontrak §0: aplikasi membaca body['error'] bila status bukan 2xx).

function isoNow() {
  return new Date().toISOString();
}

// Senin 00:00 Asia/Jakarta (UTC+7, tanpa DST) sebagai ISO UTC.
// Dipakai batas poin mingguan (kontrak A9).
function weekStartJakartaISO(now = new Date()) {
  const jakartaMs = now.getTime() + 7 * 60 * 60 * 1000;
  const j = new Date(jakartaMs);
  const day = j.getUTCDay(); // 0=Min .. 6=Sab
  const diffToMonday = (day + 6) % 7;
  const monday = new Date(Date.UTC(j.getUTCFullYear(), j.getUTCMonth(), j.getUTCDate() - diffToMonday, 0, 0, 0));
  return new Date(monday.getTime() - 7 * 60 * 60 * 1000).toISOString();
}

function err(res, status, message) {
  return res.status(status).json({ error: message });
}

function safeJsonParse(text, fallback) {
  if (text === null || text === undefined) return fallback;
  if (typeof text !== 'string') return text;
  try {
    return JSON.parse(text);
  } catch (_) {
    return fallback;
  }
}

function toInt(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

// Kode kelas 6 karakter huruf+angka kapital (unik di tabel classes).
function genClassCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function genToken(len = 32) {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let s = '';
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

module.exports = { isoNow, weekStartJakartaISO, err, safeJsonParse, toInt, genClassCode, genToken };
