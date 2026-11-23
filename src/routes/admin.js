'use strict';
// Router Admin — mount di /api/admin (lihat src/server.js).
// Kontrak: api-contract-inventory.md §16 + §0 (envelope {user} WAJIB untuk
// objek tunggal; semua route dijaga peran 'admin' -> 403 bila bukan admin).
const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { authRequired, requireRole } = require('../middleware/auth');
const { isoNow, err, toInt } = require('../utils');

const router = express.Router();

// Semua route admin: authRequired + requireRole('admin').
router.use(authRequired, requireRole('admin'));

const ROLES = ['siswa', 'guru', 'admin'];

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

// Satu baris kelas admin (AdminClassInfo, server_models.dart:1611) —
// dipakai GET /summary (recentClasses) dan GET /classes.
function serializeAdminClass(row) {
  return {
    id: row.id,
    name: row.name,
    code: row.code,
    teacherName: row.teacher_name || '',
    teacherEmail: row.teacher_email || '',
    memberCount: toInt(row.member_count),
    taskCount: toInt(row.task_count),
    materialCount: toInt(row.material_count),
    createdAt: row.created_at || null,
  };
}

const ADMIN_CLASS_SELECT = `
  SELECT c.id, c.name, c.code, c.created_at,
         u.name AS teacher_name, u.email AS teacher_email,
         (SELECT COUNT(*) FROM class_members cm WHERE cm.class_id = c.id) AS member_count,
         (SELECT COUNT(*) FROM tasks t WHERE t.class_id = c.id) AS task_count,
         (SELECT COUNT(*) FROM materials m WHERE m.class_id = c.id) AS material_count
  FROM classes c
  LEFT JOIN users u ON u.id = c.teacher_id
`;

// GET /api/admin/summary — 16.1 kontrak.
// {totals:{users,guru,siswa,admin,classes,tasks,materials},
//  recentUsers:[ServerUser...], recentClasses:[AdminClassInfo...]}
// recent = 5 terbaru.
router.get('/summary', (req, res) => {
  const count = (sql) => toInt(db.prepare(sql).get()['COUNT(*)']);
  const totals = {
    users: count('SELECT COUNT(*) FROM users'),
    guru: count("SELECT COUNT(*) FROM users WHERE role = 'guru'"),
    siswa: count("SELECT COUNT(*) FROM users WHERE role = 'siswa'"),
    admin: count("SELECT COUNT(*) FROM users WHERE role = 'admin'"),
    classes: count('SELECT COUNT(*) FROM classes'),
    tasks: count('SELECT COUNT(*) FROM tasks'),
    materials: count('SELECT COUNT(*) FROM materials'),
  };
  const recentUsers = db
    .prepare('SELECT * FROM users ORDER BY id DESC LIMIT 5')
    .all()
    .map(serializeUser);
  const recentClasses = db
    .prepare(`${ADMIN_CLASS_SELECT} ORDER BY c.id DESC LIMIT 5`)
    .all()
    .map(serializeAdminClass);
  return res.json({ totals, recentUsers, recentClasses });
});

// GET /api/admin/users — 16.2 kontrak.
// {users:[{id,name,email,role,createdAt,classesOwned,memberships}]}
// classesOwned = kelas yang diajar guru itu; memberships = jumlah kelas
// yang diikuti.
router.get('/users', (req, res) => {
  const users = db
    .prepare(
      `SELECT u.id, u.name, u.email, u.role, u.created_at,
              (SELECT COUNT(*) FROM classes c WHERE c.teacher_id = u.id) AS classes_owned,
              (SELECT COUNT(*) FROM class_members cm WHERE cm.user_id = u.id) AS memberships
       FROM users u ORDER BY u.id ASC`,
    )
    .all()
    .map((row) => ({
      id: row.id,
      name: row.name,
      email: row.email,
      role: row.role,
      createdAt: row.created_at || null,
      classesOwned: toInt(row.classes_owned),
      memberships: toInt(row.memberships),
    }));
  return res.json({ users });
});

// POST /api/admin/users — 16.3 kontrak.
// {name,email,password,role} wajib; email duplikat -> 409;
// jawab {user} envelope WAJIB.
router.post('/users', (req, res) => {
  const { name, password } = req.body || {};
  const email = String((req.body && req.body.email) || '').trim().toLowerCase();
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
  return res.status(201).json({ user: serializeUser(user) });
});

// PATCH /api/admin/users/:id/role — 16.4 kontrak.
// {role} wajib; jawab {user} envelope WAJIB.
router.patch('/users/:id/role', (req, res) => {
  const id = toInt(req.params.id, 0);
  const role = req.body && req.body.role;
  if (!ROLES.includes(role)) return err(res, 400, 'Peran tidak valid');
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!user) return err(res, 404, 'Pengguna tidak ditemukan');
  // Keputusan: jangan biarkan admin terakhir kehilangan peran admin
  // (sejalan dengan larangan menghapus admin terakhir di DELETE).
  if (user.role === 'admin' && role !== 'admin') {
    const adminCount = toInt(
      db.prepare("SELECT COUNT(*) FROM users WHERE role = 'admin'").get()['COUNT(*)'],
    );
    if (adminCount <= 1) {
      return err(res, 400, 'Tidak dapat mengubah peran admin terakhir');
    }
  }
  db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, id);
  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  return res.json({ user: serializeUser(updated) });
});

// PATCH /api/admin/users/:id — 16.5 kontrak.
// Hanya field non-null/non-kosong: {name?,email?,role?,password?};
// password kosong/null = sandi tidak diubah; email duplikat -> 409;
// jawab {user} envelope WAJIB.
router.patch('/users/:id', (req, res) => {
  const id = toInt(req.params.id, 0);
  const body = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!user) return err(res, 404, 'Pengguna tidak ditemukan');

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
      .get(email, id);
    if (clash) return err(res, 409, 'Email sudah dipakai pengguna lain');
    updates.push('email = ?');
    params.push(email);
  }
  if (isNonEmptyString(body.role)) {
    if (!ROLES.includes(body.role)) return err(res, 400, 'Peran tidak valid');
    // Keputusan: sama seperti PATCH /role — jangan turunkan admin terakhir.
    if (user.role === 'admin' && body.role !== 'admin') {
      const adminCount = toInt(
        db.prepare("SELECT COUNT(*) FROM users WHERE role = 'admin'").get()['COUNT(*)'],
      );
      if (adminCount <= 1) {
        return err(res, 400, 'Tidak dapat mengubah peran admin terakhir');
      }
    }
    updates.push('role = ?');
    params.push(body.role);
  }
  if (isNonEmptyString(body.password)) {
    updates.push('password_hash = ?');
    params.push(bcrypt.hashSync(body.password, 10));
  }

  if (updates.length > 0) {
    params.push(id);
    db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  }
  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  return res.json({ user: serializeUser(updated) });
});

// DELETE /api/admin/users/:id — 16.6 kontrak.
// 2xx; tidak boleh menghapus dirinya sendiri (403 bila id == req.user.id);
// tidak boleh menghapus admin terakhir (400).
router.delete('/users/:id', (req, res) => {
  const id = toInt(req.params.id, 0);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!user) return err(res, 404, 'Pengguna tidak ditemukan');
  if (id === req.user.id) {
    return err(res, 403, 'Tidak dapat menghapus akun sendiri');
  }
  if (user.role === 'admin') {
    const adminCount = toInt(
      db.prepare("SELECT COUNT(*) FROM users WHERE role = 'admin'").get()['COUNT(*)'],
    );
    if (adminCount <= 1) {
      return err(res, 400, 'Tidak dapat menghapus admin terakhir');
    }
  }
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  return res.json({ ok: true });
});

// GET /api/admin/classes — 16.7 kontrak.
// {classes:[{id,name,code,teacherName,teacherEmail,memberCount,taskCount,
// materialCount,createdAt}]}
router.get('/classes', (req, res) => {
  const classes = db
    .prepare(`${ADMIN_CLASS_SELECT} ORDER BY c.id ASC`)
    .all()
    .map(serializeAdminClass);
  return res.json({ classes });
});

// DELETE /api/admin/classes/:id — 16.8 kontrak.
// 2xx; CASCADE members/schedules/tasks/materials lewat FK
// (ON DELETE CASCADE di schema.sql; foreign_keys=ON di db.js).
router.delete('/classes/:id', (req, res) => {
  const id = toInt(req.params.id, 0);
  const row = db.prepare('SELECT id FROM classes WHERE id = ?').get(id);
  if (!row) return err(res, 404, 'Kelas tidak ditemukan');
  db.prepare('DELETE FROM classes WHERE id = ?').run(id);
  return res.json({ ok: true });
});

module.exports = router;
