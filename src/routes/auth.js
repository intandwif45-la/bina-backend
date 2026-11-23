'use strict';
// Router Auth — mount di /api/auth (lihat src/server.js).
// Kontrak: api-contract-inventory.md §1 + §0 (envelope error {error}, 401
// pada login/register TIDAK memicu logout paksa di aplikasi karena
// pemanggil memakai auth:false).
const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { signToken, authRequired } = require('../middleware/auth');
const { isoNow, err } = require('../utils');

const router = express.Router();
const ROLES = ['siswa', 'guru', 'admin'];

// Serialisasi user ke camelCase (kontrak §0; ServerUser.fromJson toleran
// avatarId/bannerId null).
function serializeUser(row) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    avatarId: row.avatar_id || null,
    bannerId: row.banner_id || null,
  };
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim() !== '';
}

// POST /api/auth/register — tanpa auth.
// 1.1 kontrak: {name, email, password, role} semua wajib; role hanya
// siswa/guru/admin; email duplikat -> 409; jawab {token, user}.
router.post('/register', (req, res) => {
  const { name, password } = req.body || {};
  const email = normalizeEmail(req.body && req.body.email);
  const role = req.body && req.body.role;
  if (!isNonEmptyString(name)) return err(res, 400, 'Nama wajib diisi');
  if (!email) return err(res, 400, 'Email wajib diisi');
  if (!isNonEmptyString(password)) return err(res, 400, 'Kata sandi wajib diisi');
  if (!ROLES.includes(role)) return err(res, 400, 'Peran tidak valid');
  const existing = db.prepare('SELECT id FROM users WHERE LOWER(email) = ?').get(email);
  if (existing) return err(res, 409, 'Email sudah terdaftar');
  const hash = bcrypt.hashSync(password, 10);
  const info = db.prepare(
    'INSERT INTO users (name, email, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(name.trim(), email, hash, role, isoNow());
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
  return res.status(201).json({ token: signToken(user), user: serializeUser(user) });
});

// POST /api/auth/login — tanpa auth.
// 1.2 kontrak: kredensial salah -> 401 {error:'Email atau kata sandi salah'}.
// Aplikasi memanggil dengan auth:false, jadi 401 ini TIDAK memicu logout
// paksa (penanganan 401 terpusat hanya berlaku untuk request berauth).
router.post('/login', (req, res) => {
  const email = normalizeEmail(req.body && req.body.email);
  const password = req.body && req.body.password;
  if (!email || !isNonEmptyString(password)) {
    return err(res, 401, 'Email atau kata sandi salah');
  }
  const user = db.prepare('SELECT * FROM users WHERE LOWER(email) = ?').get(email);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return err(res, 401, 'Email atau kata sandi salah');
  }
  return res.json({ token: signToken(user), user: serializeUser(user) });
});

// POST /api/auth/change-password — authRequired.
// 1.3 kontrak: {currentPassword, newPassword}; sandi lama salah -> 400;
// sukses 2xx (isi bebas).
router.post('/change-password', authRequired, (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!isNonEmptyString(currentPassword) || !isNonEmptyString(newPassword)) {
    return err(res, 400, 'Kata sandi lama dan kata sandi baru wajib diisi');
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user || !bcrypt.compareSync(currentPassword, user.password_hash)) {
    return err(res, 400, 'Kata sandi lama salah');
  }
  const hash = bcrypt.hashSync(newPassword, 10);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, req.user.id);
  return res.json({ ok: true });
});

// POST /api/auth/forgot-password — tanpa auth.
// 1.4 kontrak: SELALU 200 dengan pesan generik yang sama, tanpa membocorkan
// apakah email terdaftar. Bila email ada, simpan kode reset 6 digit angka
// + kedaluwarsa 15 menit di users.reset_code / reset_code_expires.
// CATATAN: tidak ada pengiriman email sungguhan — backend ini tidak punya
// layanan email; kode hanya tersimpan di DB (koordinator perlu memutuskan
// alur pengiriman/penyampaian kode ke pengguna).
router.post('/forgot-password', (req, res) => {
  const message = 'Bila email itu terdaftar, kode reset telah dikirim ke email tersebut.';
  const email = normalizeEmail(req.body && req.body.email);
  if (email) {
    const user = db.prepare('SELECT id FROM users WHERE LOWER(email) = ?').get(email);
    if (user) {
      const code = String(Math.floor(100000 + Math.random() * 900000));
      const expires = new Date(Date.now() + 15 * 60 * 1000).toISOString();
      db.prepare(
        'UPDATE users SET reset_code = ?, reset_code_expires = ? WHERE id = ?',
      ).run(code, expires, user.id);
    }
  }
  return res.json({ message });
});

// POST /api/auth/reset-password — tanpa auth.
// 1.5 kontrak: {email, code, newPassword}; kode salah/kedaluwarsa -> 400;
// sukses -> ganti hash, hapus kode.
router.post('/reset-password', (req, res) => {
  const email = normalizeEmail(req.body && req.body.email);
  const code = req.body && req.body.code;
  const newPassword = req.body && req.body.newPassword;
  if (!email || !isNonEmptyString(code) || !isNonEmptyString(newPassword)) {
    return err(res, 400, 'Email, kode reset, dan kata sandi baru wajib diisi');
  }
  const user = db.prepare('SELECT * FROM users WHERE LOWER(email) = ?').get(email);
  if (
    !user
    || !user.reset_code
    || String(user.reset_code) !== String(code).trim()
    || !user.reset_code_expires
    || new Date(user.reset_code_expires).getTime() <= Date.now()
  ) {
    return err(res, 400, 'Kode reset salah atau sudah kedaluwarsa');
  }
  const hash = bcrypt.hashSync(newPassword, 10);
  db.prepare(
    'UPDATE users SET password_hash = ?, reset_code = NULL, reset_code_expires = NULL WHERE id = ?',
  ).run(hash, user.id);
  return res.json({ ok: true });
});

module.exports = router;
