'use strict';
// Router Profil — mount di /api (lihat src/server.js).
// Kontrak: api-contract-inventory.md §2 + §0 (GET /api/me toleran dua
// bentuk di aplikasi, tapi server selalu menjawab envelope {user}).
const express = require('express');
const db = require('../db');
const { authRequired } = require('../middleware/auth');
const { err } = require('../utils');

const router = express.Router();

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

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim() !== '';
}

// GET /api/me — authRequired.
// 2.1 kontrak: jawab {user: {...}}.
router.get('/me', authRequired, (req, res) => {
  return res.json({ user: serializeUser(req.user) });
});

// PATCH /api/me — authRequired.
// 2.2 kontrak: hanya field non-null/non-kosong yang diubah: name, email,
// avatarId, bannerId. Email duplikat milik user lain -> 409. Jawab {user}
// yang sudah diperbarui.
router.patch('/me', authRequired, (req, res) => {
  const body = req.body || {};
  const updates = [];
  const params = [];

  if (isNonEmptyString(body.name)) {
    updates.push('name = ?');
    params.push(body.name.trim());
  }
  if (isNonEmptyString(body.email)) {
    const email = body.email.trim().toLowerCase();
    const clash = db
      .prepare('SELECT id FROM users WHERE LOWER(email) = ? AND id != ?')
      .get(email, req.user.id);
    if (clash) return err(res, 409, 'Email sudah dipakai pengguna lain');
    updates.push('email = ?');
    params.push(email);
  }
  if (isNonEmptyString(body.avatarId)) {
    updates.push('avatar_id = ?');
    params.push(body.avatarId.trim());
  }
  if (isNonEmptyString(body.bannerId)) {
    updates.push('banner_id = ?');
    params.push(body.bannerId.trim());
  }

  if (updates.length > 0) {
    params.push(req.user.id);
    db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  return res.json({ user: serializeUser(user) });
});

module.exports = router;
