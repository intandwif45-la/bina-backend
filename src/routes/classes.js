'use strict';
// Router Kelas + Dashboard (kontrak §3).
// Mount di /api. Semua route memakai authRequired.
const express = require('express');
const db = require('../db');
const { authRequired, requireRole } = require('../middleware/auth');
const { isoNow, err, safeJsonParse, toInt, genClassCode } = require('../utils');

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

// 404 bila kelas tidak ada ATAU pemanggil bukan anggota/guru pemilik/admin
// (jangan bocorkan keberadaan kelas).
function canAccess(user, cls) {
  return isOwnerOrAdmin(user, cls) || isMember(cls.id, user.id);
}

function serializeClass(row) {
  const teacher = db.prepare('SELECT name FROM users WHERE id = ?').get(row.teacher_id);
  const memberCount = db
    .prepare('SELECT COUNT(*) AS n FROM class_members WHERE class_id = ?')
    .get(row.id).n;
  const taskCount = db
    .prepare('SELECT COUNT(*) AS n FROM tasks WHERE class_id = ?')
    .get(row.id).n;
  return {
    id: row.id,
    name: row.name,
    code: row.code,
    teacherId: row.teacher_id,
    teacherName: teacher ? teacher.name : '',
    memberCount,
    taskCount,
  };
}

// Kelas-kelas "saya": guru -> yang diajar; siswa/admin -> yang diikuti +
// yang diajar (bila guru). Mengembalikan baris classes (unik, urut nama).
function myClassRows(user) {
  if (user.role === 'guru') {
    return db
      .prepare('SELECT * FROM classes WHERE teacher_id = ? ORDER BY name')
      .all(user.id);
  }
  return db
    .prepare(
      `SELECT * FROM classes WHERE teacher_id = ?
         OR id IN (SELECT class_id FROM class_members WHERE user_id = ?)
       ORDER BY name`,
    )
    .all(user.id, user.id);
}

function genUniqueCode(excludeId) {
  for (let i = 0; i < 20; i++) {
    const code = genClassCode();
    const clash = db.prepare('SELECT id FROM classes WHERE code = ?').get(code);
    if (!clash || (excludeId && clash.id === excludeId)) return code;
  }
  return null;
}

function joinClassRow(userId, cls) {
  db.prepare(
    'INSERT OR IGNORE INTO class_members (class_id, user_id) VALUES (?, ?)',
  ).run(cls.id, userId);
  return serializeClass(cls);
}

// Serialisasi tugas ringkas seperti §12.1; correctIndex DITAHAN untuk siswa.
function serializeTask(taskRow, className, user) {
  const questions = safeJsonParse(taskRow.questions, []);
  const isStudent = user.role === 'siswa';
  const out = {
    id: taskRow.id,
    classId: taskRow.class_id,
    title: taskRow.title,
    description: taskRow.description || null,
    questionCount: questions.length,
    questions: questions.map((q) => {
      const item = {
        question: q.question || '',
        options: Array.isArray(q.options) ? q.options.map(String) : [],
      };
      if (!isStudent && q.correctIndex != null) item.correctIndex = q.correctIndex;
      return item;
    }),
    type: taskRow.type || 'quiz',
    opensAt: taskRow.opens_at || null,
    dueAt: taskRow.due_at || null,
    className: className || null,
  };
  const sub = db
    .prepare('SELECT * FROM submissions WHERE task_id = ? AND user_id = ?')
    .get(taskRow.id, user.id);
  if (sub) {
    out.mySubmission = {
      autoScore: sub.auto_score || 0,
      score: sub.score != null ? sub.score : null,
      review: sub.review || null,
      submittedAt: sub.submitted_at || null,
      fileName: sub.file_name || null,
    };
  }
  return out;
}

// ─── GET /api/classes — kelas saya ───────────────────────────────────────────

router.get('/classes', (req, res) => {
  const rows = myClassRows(req.user);
  return res.json({ classes: rows.map(serializeClass) });
});

// ─── GET /api/classes/discover — semua kelas + joined/owned ────────────────
// (didaftarkan sebelum route :id agar 'discover' tidak ditangkap :id)

router.get('/classes/discover', (req, res) => {
  const rows = db.prepare('SELECT * FROM classes ORDER BY name').all();
  const classes = rows.map((row) => {
    const teacher = db.prepare('SELECT name FROM users WHERE id = ?').get(row.teacher_id);
    const memberCount = db
      .prepare('SELECT COUNT(*) AS n FROM class_members WHERE class_id = ?')
      .get(row.id).n;
    const taskCount = db
      .prepare('SELECT COUNT(*) AS n FROM tasks WHERE class_id = ?')
      .get(row.id).n;
    return {
      id: row.id,
      name: row.name,
      teacherName: teacher ? teacher.name : '',
      memberCount,
      taskCount,
      joined: isMember(row.id, req.user.id),
      owned: row.teacher_id === req.user.id,
    };
  });
  return res.json({ classes });
});

// ─── POST /api/classes — buat kelas (guru/admin) ─────────────────────────────

router.post('/classes', requireRole('guru', 'admin'), (req, res) => {
  const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
  if (!name) return err(res, 400, 'Nama kelas wajib diisi');
  const code = genUniqueCode();
  if (!code) return err(res, 500, 'Gagal membuat kode kelas unik');
  const info = db
    .prepare(
      'INSERT INTO classes (name, code, teacher_id, created_at) VALUES (?, ?, ?, ?)',
    )
    .run(name, code, req.user.id, isoNow());
  const cls = db.prepare('SELECT * FROM classes WHERE id = ?').get(info.lastInsertRowid);
  // Guru pembuat BUKAN anggota kelas (bukan member) — sesuai kontrak.
  return res.status(201).json({ class: serializeClass(cls) });
});

// ─── POST /api/classes/join — gabung via kode ────────────────────────────────
// (didaftarkan sebelum POST /classes/:id/join agar 'join' tidak ditangkap :id)

router.post('/classes/join', (req, res) => {
  const raw = typeof req.body.code === 'string' ? req.body.code : '';
  const code = raw.trim().toUpperCase();
  if (!code) return err(res, 400, 'Kode kelas wajib diisi');
  const cls = db.prepare('SELECT * FROM classes WHERE code = ?').get(code);
  if (!cls) return err(res, 404, 'Kode kelas tidak ditemukan');
  return res.json({ class: joinClassRow(req.user.id, cls) });
});

// ─── GET /api/classes/lookup/:code — pratinjau kelas via kode ───────────────

router.get('/classes/lookup/:code', (req, res) => {
  const code = String(req.params.code || '').trim().toUpperCase();
  const cls = db.prepare('SELECT * FROM classes WHERE code = ?').get(code);
  if (!cls) return err(res, 404, 'Kode kelas tidak ditemukan');
  return res.json({ class: serializeClass(cls) });
});

// ─── POST /api/classes/:id/reset-code — kode baru (pemilik/admin) ────────────

router.post('/classes/:id/reset-code', (req, res) => {
  const cls = findClass(req.params.id);
  if (!cls || !isOwnerOrAdmin(req.user, cls)) {
    return err(res, 404, 'Kelas tidak ditemukan');
  }
  let code = genUniqueCode(cls.id);
  if (!code) return err(res, 500, 'Gagal membuat kode kelas unik');
  if (code === cls.code) code = genUniqueCode(cls.id);
  db.prepare('UPDATE classes SET code = ? WHERE id = ?').run(code, cls.id);
  const updated = findClass(cls.id);
  return res.json({ class: serializeClass(updated) });
});

// ─── POST /api/classes/:id/join — gabung via id (dari Discover) ─────────────

router.post('/classes/:id/join', (req, res) => {
  const cls = findClass(req.params.id);
  if (!cls) return err(res, 404, 'Kelas tidak ditemukan');
  return res.json({ class: joinClassRow(req.user.id, cls) });
});

// ─── DELETE /api/classes/:id/leave — keluar dari kelas ──────────────────────

router.delete('/classes/:id/leave', (req, res) => {
  const cls = findClass(req.params.id);
  if (!cls) return err(res, 404, 'Kelas tidak ditemukan');
  if (cls.teacher_id === req.user.id) {
    return err(res, 400, 'Guru pemilik kelas tidak dapat keluar dari kelasnya sendiri');
  }
  if (!isMember(cls.id, req.user.id)) {
    return err(res, 404, 'Kelas tidak ditemukan');
  }
  db.prepare('DELETE FROM class_members WHERE class_id = ? AND user_id = ?').run(
    cls.id,
    req.user.id,
  );
  return res.json({ ok: true });
});

// ─── GET /api/classes/:id/members — anggota + skor ───────────────────────────

router.get('/classes/:id/members', (req, res) => {
  const cls = findClass(req.params.id);
  if (!cls || !canAccess(req.user, cls)) {
    return err(res, 404, 'Kelas tidak ditemukan');
  }
  const rows = db
    .prepare(
      `SELECT u.id, u.name, u.email FROM class_members cm
         JOIN users u ON u.id = cm.user_id
        WHERE cm.class_id = ? ORDER BY u.name`,
    )
    .all(cls.id);
  const members = rows.map((u) => {
    const member = { id: u.id, name: u.name, email: u.email };
    const s = db.prepare('SELECT * FROM scores WHERE user_id = ?').get(u.id);
    if (s) {
      const scores = {};
      if (s.pretest != null) scores.pretest = s.pretest;
      if (s.posttest != null) scores.posttest = s.posttest;
      if (s.latihan_best != null) scores.latihanBest = s.latihan_best;
      if (s.simulator_best != null) scores.simulatorBest = s.simulator_best;
      if (Object.keys(scores).length > 0) member.scores = scores;
    }
    return member;
  });
  return res.json({ members });
});

// ─── DELETE /api/classes/:id/members/:userId — keluarkan anggota ────────────

router.delete('/classes/:id/members/:userId', (req, res) => {
  const cls = findClass(req.params.id);
  if (!cls || !isOwnerOrAdmin(req.user, cls)) {
    return err(res, 404, 'Kelas tidak ditemukan');
  }
  const info = db
    .prepare('DELETE FROM class_members WHERE class_id = ? AND user_id = ?')
    .run(cls.id, toInt(req.params.userId));
  if (info.changes === 0) return err(res, 404, 'Anggota tidak ditemukan');
  return res.json({ ok: true });
});

// ─── GET /api/my/dashboard — objek langsung TANPA envelope ───────────────────

router.get('/my/dashboard', (req, res) => {
  const myRows = myClassRows(req.user);
  const myIds = myRows.map((c) => c.id);
  const classById = new Map(myRows.map((c) => [c.id, c]));

  const classes = myRows.map(serializeClass);

  let tasks = [];
  let meetings = [];
  let announcements = [];
  let materials = [];
  let liveSessions = [];
  if (myIds.length > 0) {
    const inList = myIds.map(() => '?').join(',');
    const taskRows = db
      .prepare(`SELECT * FROM tasks WHERE class_id IN (${inList}) ORDER BY class_id, id`)
      .all(...myIds);
    tasks = taskRows.map((t) =>
      serializeTask(t, classById.get(t.class_id)?.name, req.user),
    );

    // Pertemuan = schedule parts yang punya meetLink, tanggal hari ini
    // dan sesudahnya (tanggal server, UTC), urut tanggal.
    const today = new Date().toISOString().slice(0, 10);
    const meetRows = db
      .prepare(
        `SELECT sp.id AS part_id, sp.title AS part_title, sp.meet_link,
                sp.sort_order, s.id AS schedule_id, s.title AS schedule_title,
                s.date, s.class_id, c.name AS class_name
           FROM schedule_parts sp
           JOIN schedules s ON s.id = sp.schedule_id
           JOIN classes c ON c.id = s.class_id
          WHERE s.class_id IN (${inList})
            AND sp.meet_link IS NOT NULL AND sp.meet_link != ''
            AND s.date >= ?
          ORDER BY s.date ASC, sp.sort_order ASC, sp.id ASC`,
      )
      .all(...myIds, today);
    meetings = meetRows.map((r) => ({
      scheduleId: r.schedule_id,
      scheduleTitle: r.schedule_title,
      date: r.date,
      partId: r.part_id,
      partTitle: r.part_title,
      meetLink: r.meet_link,
      classId: r.class_id,
      className: r.class_name,
    }));

    const annRows = db
      .prepare(
        `SELECT a.*, u.name AS author_name, c.name AS class_name
           FROM announcements a
           JOIN users u ON u.id = a.author_id
           JOIN classes c ON c.id = a.class_id
          WHERE a.class_id IN (${inList})
          ORDER BY a.created_at DESC`,
      )
      .all(...myIds);
    announcements = annRows.map((a) => ({
      id: a.id,
      classId: a.class_id,
      className: a.class_name,
      text: a.text,
      authorName: a.author_name || '',
      createdAt: a.created_at || null,
    }));

    const matRows = db
      .prepare(
        `SELECT m.*, c.name AS class_name FROM materials m
           JOIN classes c ON c.id = m.class_id
          WHERE m.class_id IN (${inList})
          ORDER BY m.created_at DESC`,
      )
      .all(...myIds);
    materials = matRows.map((m) => ({
      id: m.id,
      classId: m.class_id,
      className: m.class_name,
      title: m.title,
      description: m.description || null,
      linkUrl: m.link_url || null,
      fileName: m.file_name || null,
      fileMime: m.file_mime || null,
      hasFile: !!m.has_file,
      createdAt: m.created_at || null,
    }));

    const liveRows = db
      .prepare(
        `SELECT ls.*, c.name AS class_name FROM live_sessions ls
           JOIN classes c ON c.id = ls.class_id
          WHERE ls.class_id IN (${inList}) AND ls.status = 'active'
          ORDER BY ls.started_at DESC`,
      )
      .all(...myIds);
    liveSessions = liveRows.map((s) => ({
      id: s.id,
      classId: s.class_id,
      className: s.class_name,
      title: s.title,
      startedAt: s.started_at || null,
    }));
  }

  // Submission saya (semua kelas, bukan hanya yang masih diikuti — nilai
  // tetap tersimpan walau sudah leave, sesuai kontrak §3.7).
  const subRows = db
    .prepare(
      `SELECT s.*, t.title AS task_title, t.type AS task_type,
              t.class_id, c.name AS class_name
         FROM submissions s
         JOIN tasks t ON t.id = s.task_id
         JOIN classes c ON c.id = t.class_id
        WHERE s.user_id = ?
        ORDER BY s.submitted_at DESC`,
    )
    .all(req.user.id);
  const results = subRows.map((s) => ({
    submissionId: s.id,
    taskId: s.task_id,
    taskTitle: s.task_title,
    taskType: s.task_type || 'quiz',
    classId: s.class_id,
    className: s.class_name,
    score: s.score != null ? s.score : s.auto_score || 0,
    finalScore: s.score != null ? s.score : null,
    review: s.review || null,
    submittedAt: s.submitted_at || null,
  }));

  // Pesan langsung belum dibaca untuk saya.
  const unread = db
    .prepare(
      `SELECT COUNT(*) AS n FROM direct_messages dm
         JOIN conversations cv ON cv.id = dm.conversation_id
        WHERE dm.sender_id != ?
          AND ((cv.teacher_id = ? AND dm.read_by_teacher = 0)
            OR (cv.student_id = ? AND dm.read_by_student = 0))`,
    )
    .get(req.user.id, req.user.id, req.user.id).n;

  return res.json({
    classes,
    tasks,
    meetings,
    announcements,
    materials,
    liveSessions,
    results,
    unreadChat: unread || 0,
  });
});

// ─── GET /api/my/results — submission saya ───────────────────────────────────

router.get('/my/results', (req, res) => {
  const rows = db
    .prepare(
      `SELECT s.*, t.title AS task_title, t.class_id, c.name AS class_name
         FROM submissions s
         JOIN tasks t ON t.id = s.task_id
         JOIN classes c ON c.id = t.class_id
        WHERE s.user_id = ?
        ORDER BY s.submitted_at DESC`,
    )
    .all(req.user.id);
  const results = rows.map((s) => ({
    submissionId: s.id,
    taskId: s.task_id,
    taskTitle: s.task_title,
    classId: s.class_id,
    className: s.class_name,
    autoScore: s.auto_score || 0,
    score: s.score != null ? s.score : s.auto_score || 0,
    finalScore: s.score != null ? s.score : null,
    review: s.review || null,
    submittedAt: s.submitted_at || null,
  }));
  return res.json({ results });
});

module.exports = router;
