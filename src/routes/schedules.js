'use strict';
// Router Jadwal (kontrak §4).
// Mount di /api. Semua route memakai authRequired.
const express = require('express');
const db = require('../db');
const { authRequired, requireRole } = require('../middleware/auth');
const { err, toInt } = require('../utils');

const router = express.Router();
router.use(authRequired);

// ─── Pembantu ───────────────────────────────────────────────────────────────

function findClass(id) {
  return db.prepare('SELECT * FROM classes WHERE id = ?').get(toInt(id));
}

function isMember(classId, userId) {
  return !!db
    .prepare('SELECT 1 FROM class_members WHERE class_id = ? AND user_id = ?')
    .get(classId, userId);
}

function isOwnerOrAdmin(user, cls) {
  return user.role === 'admin' || cls.teacher_id === user.id;
}

function canAccess(user, cls) {
  return isOwnerOrAdmin(user, cls) || isMember(cls.id, user.id);
}

function serializePart(row) {
  return {
    id: row.id,
    scheduleId: row.schedule_id,
    title: row.title,
    sortOrder: row.sort_order || 0,
    meetLink: row.meet_link || null,
  };
}

function serializeSchedule(row, withClassName) {
  const parts = db
    .prepare(
      'SELECT * FROM schedule_parts WHERE schedule_id = ? ORDER BY sort_order ASC, id ASC',
    )
    .all(row.id);
  const out = {
    id: row.id,
    classId: row.class_id,
    title: row.title,
    date: row.date,
    parts: parts.map(serializePart),
  };
  if (withClassName) {
    const cls = db.prepare('SELECT name FROM classes WHERE id = ?').get(row.class_id);
    out.className = cls ? cls.name : '';
  }
  return out;
}

function isValidDateStr(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

// ─── GET /api/classes/:id/schedules ─────────────────────────────────────────

router.get('/classes/:id/schedules', (req, res) => {
  const cls = findClass(req.params.id);
  if (!cls || !canAccess(req.user, cls)) {
    return err(res, 404, 'Kelas tidak ditemukan');
  }
  const rows = db
    .prepare('SELECT * FROM schedules WHERE class_id = ? ORDER BY date ASC, id ASC')
    .all(cls.id);
  return res.json({ schedules: rows.map((r) => serializeSchedule(r, false)) });
});

// ─── POST /api/classes/:id/schedules — buat jadwal (pemilik/admin) ──────────

router.post('/classes/:id/schedules', (req, res) => {
  const cls = findClass(req.params.id);
  if (!cls || !isOwnerOrAdmin(req.user, cls)) {
    return err(res, 404, 'Kelas tidak ditemukan');
  }
  const title = typeof req.body.title === 'string' ? req.body.title.trim() : '';
  if (!title) return err(res, 400, 'Judul jadwal wajib diisi');
  if (!isValidDateStr(req.body.date)) {
    return err(res, 400, 'Tanggal wajib format YYYY-MM-DD');
  }
  const info = db
    .prepare('INSERT INTO schedules (class_id, title, date) VALUES (?, ?, ?)')
    .run(cls.id, title, req.body.date);
  const row = db.prepare('SELECT * FROM schedules WHERE id = ?').get(info.lastInsertRowid);
  const schedule = serializeSchedule(row, false);
  schedule.parts = [];
  return res.status(201).json({ schedule });
});

// ─── PUT /api/schedules/:id — ubah jadwal (pemilik/admin) ───────────────────

router.put('/schedules/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM schedules WHERE id = ?').get(toInt(req.params.id));
  if (!row) return err(res, 404, 'Jadwal tidak ditemukan');
  const cls = findClass(row.class_id);
  if (!cls || !isOwnerOrAdmin(req.user, cls)) {
    return err(res, 404, 'Jadwal tidak ditemukan');
  }
  // Hanya field non-null yang diubah.
  const updates = [];
  const params = [];
  if (req.body.title != null) {
    const title = typeof req.body.title === 'string' ? req.body.title.trim() : '';
    if (!title) return err(res, 400, 'Judul jadwal wajib diisi');
    updates.push('title = ?');
    params.push(title);
  }
  if (req.body.date != null) {
    if (!isValidDateStr(req.body.date)) {
      return err(res, 400, 'Tanggal wajib format YYYY-MM-DD');
    }
    updates.push('date = ?');
    params.push(req.body.date);
  }
  if (updates.length > 0) {
    params.push(row.id);
    db.prepare(`UPDATE schedules SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  }
  const updated = db.prepare('SELECT * FROM schedules WHERE id = ?').get(row.id);
  return res.json({ schedule: serializeSchedule(updated, false) });
});

// ─── DELETE /api/schedules/:id — hapus jadwal (pemilik/admin) ───────────────

router.delete('/schedules/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM schedules WHERE id = ?').get(toInt(req.params.id));
  if (!row) return err(res, 404, 'Jadwal tidak ditemukan');
  const cls = findClass(row.class_id);
  if (!cls || !isOwnerOrAdmin(req.user, cls)) {
    return err(res, 404, 'Jadwal tidak ditemukan');
  }
  db.prepare('DELETE FROM schedules WHERE id = ?').run(row.id);
  return res.json({ ok: true });
});

// ─── POST /api/schedules/:id/parts — tambah bagian (pemilik/admin) ───────────

router.post('/schedules/:id/parts', (req, res) => {
  const row = db.prepare('SELECT * FROM schedules WHERE id = ?').get(toInt(req.params.id));
  if (!row) return err(res, 404, 'Jadwal tidak ditemukan');
  const cls = findClass(row.class_id);
  if (!cls || !isOwnerOrAdmin(req.user, cls)) {
    return err(res, 404, 'Jadwal tidak ditemukan');
  }
  const title = typeof req.body.title === 'string' ? req.body.title.trim() : '';
  if (!title) return err(res, 400, 'Judul bagian jadwal wajib diisi');
  const meetLink =
    typeof req.body.meetLink === 'string' && req.body.meetLink.trim() !== ''
      ? req.body.meetLink.trim()
      : null;
  const sortOrder = req.body.sortOrder != null ? toInt(req.body.sortOrder, 0) : 0;
  const info = db
    .prepare(
      'INSERT INTO schedule_parts (schedule_id, title, meet_link, sort_order) VALUES (?, ?, ?, ?)',
    )
    .run(row.id, title, meetLink, sortOrder);
  const part = db
    .prepare('SELECT * FROM schedule_parts WHERE id = ?')
    .get(info.lastInsertRowid);
  return res.status(201).json({ part: serializePart(part) });
});

// ─── PUT /api/schedule-parts/:id — ubah bagian (pemilik/admin) ──────────────
// A8: 'meetLink' in body dengan null eksplisit = HAPUS tautan;
// field tidak ada = jangan ubah.

router.put('/schedule-parts/:id', (req, res) => {
  const part = db
    .prepare('SELECT * FROM schedule_parts WHERE id = ?')
    .get(toInt(req.params.id));
  if (!part) return err(res, 404, 'Bagian jadwal tidak ditemukan');
  const sched = db.prepare('SELECT * FROM schedules WHERE id = ?').get(part.schedule_id);
  const cls = sched ? findClass(sched.class_id) : null;
  if (!cls || !isOwnerOrAdmin(req.user, cls)) {
    return err(res, 404, 'Bagian jadwal tidak ditemukan');
  }
  const updates = [];
  const params = [];
  if (req.body.title != null) {
    const title = typeof req.body.title === 'string' ? req.body.title.trim() : '';
    if (!title) return err(res, 400, 'Judul bagian jadwal wajib diisi');
    updates.push('title = ?');
    params.push(title);
  }
  if ('meetLink' in req.body) {
    const v = req.body.meetLink;
    const link =
      typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
    updates.push('meet_link = ?');
    params.push(link);
  }
  if (req.body.sortOrder != null) {
    updates.push('sort_order = ?');
    params.push(toInt(req.body.sortOrder, 0));
  }
  if (updates.length > 0) {
    params.push(part.id);
    db.prepare(`UPDATE schedule_parts SET ${updates.join(', ')} WHERE id = ?`).run(
      ...params,
    );
  }
  const updated = db
    .prepare('SELECT * FROM schedule_parts WHERE id = ?')
    .get(part.id);
  return res.json({ part: serializePart(updated) });
});

// ─── DELETE /api/schedule-parts/:id — hapus bagian (pemilik/admin) ──────────

router.delete('/schedule-parts/:id', (req, res) => {
  const part = db
    .prepare('SELECT * FROM schedule_parts WHERE id = ?')
    .get(toInt(req.params.id));
  if (!part) return err(res, 404, 'Bagian jadwal tidak ditemukan');
  const sched = db.prepare('SELECT * FROM schedules WHERE id = ?').get(part.schedule_id);
  const cls = sched ? findClass(sched.class_id) : null;
  if (!cls || !isOwnerOrAdmin(req.user, cls)) {
    return err(res, 404, 'Bagian jadwal tidak ditemukan');
  }
  db.prepare('DELETE FROM schedule_parts WHERE id = ?').run(part.id);
  return res.json({ ok: true });
});

// ─── GET /api/guru/agenda-today — jadwal hari ini dari kelas yang saya ajar ─

router.get('/guru/agenda-today', requireRole('guru', 'admin'), (req, res) => {
  const date =
    typeof req.query.date === 'string' && req.query.date !== ''
      ? req.query.date
      : new Date().toISOString().slice(0, 10);
  if (!isValidDateStr(date)) {
    return err(res, 400, 'Tanggal wajib format YYYY-MM-DD');
  }
  const rows = db
    .prepare(
      `SELECT s.* FROM schedules s
         JOIN classes c ON c.id = s.class_id
        WHERE c.teacher_id = ? AND s.date = ?
        ORDER BY c.name ASC, s.id ASC`,
    )
    .all(req.user.id, date);
  return res.json({ schedules: rows.map((r) => serializeSchedule(r, true)) });
});

module.exports = router;
