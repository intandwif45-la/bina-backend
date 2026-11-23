'use strict';
// Router Tugas / Kuis Online & Skor — kontrak §12 api-contract-inventory.md.
// Mount: app.use('/api', require('./routes/tasks')).
// Semua route authRequired.
//
// Rumus XP (keputusan A11 — didokumentasikan di sini, aplikasi tidak
// memvalidasinya):
//   xp = SUM(point_entries.points)
//      + 10 * jumlah check-in absensi (tabel attendance)
//      +  5 * jawaban live benar (live_quiz_answers correct = 1)
//      + 20 * jumlah lencana (user_badges)
// Skor tes tersinkron (tabel scores: pretest/posttest/latihanBest/
// simulatorBest) TIDAK masuk XP — skor adalah nilai belajar, bukan XP.
// attendance dan liveCorrect dihitung global per user (kedua tabel tidak
// punya class_id), begitu pula total poin dan lencana.
//
// Keputusan atas ambiguitas lain:
// - Leaderboard & monitoring: pesertanya anggota kelas (class_members);
//   guru pemilik tidak termasuk kecuali ia juga anggota. Diurutkan xp desc.
// - POST /tasks/:id/submit: cabang dari bentuk body (A4) — ada field
//   `answers` (array) = kuis, tanpa itu = tugas bebas. Kirim ulang
//   (upsert per (task, user)) menimpa kiriman sebelumnya; kiriman kuis
//   menghapus isi tugas bebas sebelumnya dan sebaliknya.
// - autoScore kuis: round(benar/total*100); correctIndex soal yang hilang
//   dianggap 0 (sama seperti parser aplikasi). Jawaban lebih pendek dari
//   jumlah soal dihitung salah; jawaban berlebih diabaikan.
// - Tenggat: hanya dueAt yang ditegakkan (400 'Tenggat sudah lewat');
//   opensAt tidak ditegakkan server (aplikasi menampilkan status jendela).
// - GET /tasks/:id/results untuk tugas bebas: answers dikirim sebagai Map
//   {text, link} (bukan []) karena parser aplikasi TaskResultRow.fromJson
//   hanya membaca answerText/answerLink dari `answers` bila berbentuk Map;
//   field terpisah answerText/answerLink/fileName tetap dikirim juga.
//   (Perbaikan koordinator 2026-11-23 setelah verifikasi parser.)
// - GET /guru/ungraded: guru melihat kelas yang ia ajar; admin melihat
//   semua kelas. Diurutkan submitted_at terbaru dulu.
// - POST /scores/sync: hanya peran siswa (requireRole('siswa')); bila
//   tidak ada satu pun field skor non-null yang valid -> 400.
const express = require('express');
const db = require('../db');
const { authRequired, requireRole } = require('../middleware/auth');
const { err, isoNow, safeJsonParse, toInt } = require('../utils');

const router = express.Router();
router.use(authRequired);

// ─── Helper ────────────────────────────────────────────────────────────────

function getClassOr404(req, res, classId) {
  const cls = db.prepare('SELECT * FROM classes WHERE id = ?').get(toInt(classId, -1));
  if (!cls) {
    err(res, 404, 'Kelas tidak ditemukan');
    return null;
  }
  return cls;
}

function isMember(classId, userId) {
  return !!db.prepare(
    'SELECT 1 FROM class_members WHERE class_id = ? AND user_id = ?',
  ).get(classId, userId);
}

function isOwnerOrAdmin(cls, user) {
  return cls.teacher_id === user.id || user.role === 'admin';
}

// Anggota kelas ATAU guru pemilik ATAU admin; bila bukan -> 403.
function requireClassAccess(req, res, cls) {
  if (isOwnerOrAdmin(cls, req.user)) return true;
  if (isMember(cls.id, req.user.id)) return true;
  err(res, 403, 'Bukan anggota kelas ini');
  return false;
}

function xpParts(userId) {
  const points = db.prepare(
    'SELECT COALESCE(SUM(points), 0) AS total FROM point_entries WHERE user_id = ?',
  ).get(userId).total;
  const attendanceCount = db.prepare(
    'SELECT COUNT(*) AS c FROM attendance WHERE user_id = ?',
  ).get(userId).c;
  const liveCorrect = db.prepare(
    'SELECT COUNT(*) AS c FROM live_quiz_answers WHERE user_id = ? AND correct = 1',
  ).get(userId).c;
  const badgeCount = db.prepare(
    'SELECT COUNT(*) AS c FROM user_badges WHERE user_id = ?',
  ).get(userId).c;
  return { points, attendanceCount, liveCorrect, badgeCount };
}

// Rumus XP (A11): poin + 10*absensi + 5*live benar + 20*lencana.
function computeXp(userId) {
  const p = xpParts(userId);
  return {
    xp: p.points + 10 * p.attendanceCount + 5 * p.liveCorrect + 20 * p.badgeCount,
    attendanceCount: p.attendanceCount,
    liveCorrect: p.liveCorrect,
  };
}

function serializeTask(row, { includeCorrect, mySubmission, className }) {
  const questions = safeJsonParse(row.questions, []);
  const task = {
    id: row.id,
    classId: row.class_id,
    title: row.title,
    description: row.description ? row.description : null,
    questionCount: questions.length,
    questions: questions.map((q) => {
      const item = {
        question: q.question || '',
        options: Array.isArray(q.options) ? q.options.map(String) : [],
      };
      if (includeCorrect && q.correctIndex !== undefined && q.correctIndex !== null) {
        item.correctIndex = toInt(q.correctIndex, 0);
      }
      return item;
    }),
    type: row.type || 'quiz',
    opensAt: row.opens_at || null,
    dueAt: row.due_at || null,
  };
  if (className) task.className = className;
  if (mySubmission) {
    task.mySubmission = {
      autoScore: mySubmission.auto_score,
      score: mySubmission.score === null || mySubmission.score === undefined
        ? null : mySubmission.score,
      review: mySubmission.review || null,
      submittedAt: mySubmission.submitted_at || null,
      fileName: mySubmission.file_name || null,
    };
  }
  return task;
}

function loadMySubmission(taskId, userId) {
  return db.prepare(
    'SELECT * FROM submissions WHERE task_id = ? AND user_id = ?',
  ).get(taskId, userId) || null;
}

function classMembers(clsId) {
  return db.prepare(
    `SELECT u.* FROM users u
       JOIN class_members cm ON cm.user_id = u.id
      WHERE cm.class_id = ?
      ORDER BY u.name ASC, u.id ASC`,
  ).all(clsId);
}

// Hari berurutan (UTC) dengan aktivitas dari streak_days, berakhir hari
// ini atau kemarin; bila tidak ada aktivitas hari ini maupun kemarin -> 0.
function streakDaysFor(userId) {
  const days = new Set(db.prepare(
    'SELECT day FROM streak_days WHERE user_id = ?',
  ).all(userId).map((r) => r.day));
  const today = new Date();
  const fmt = (d) => d.toISOString().slice(0, 10);
  let cursor = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  if (!days.has(fmt(cursor))) {
    cursor = new Date(cursor.getTime() - 24 * 60 * 60 * 1000);
    if (!days.has(fmt(cursor))) return 0;
  }
  let count = 0;
  while (days.has(fmt(cursor))) {
    count += 1;
    cursor = new Date(cursor.getTime() - 24 * 60 * 60 * 1000);
  }
  return count;
}

// ─── 12.1 GET /api/classes/:id/tasks ───────────────────────────────────────
// Hanya anggota / guru pemilik / admin. correctIndex HANYA untuk guru
// (pemilik kelas / admin); untuk siswa field itu dihapus dari tiap soal.
router.get('/classes/:id/tasks', (req, res) => {
  const cls = getClassOr404(req, res, req.params.id);
  if (!cls) return undefined;
  if (!requireClassAccess(req, res, cls)) return undefined;
  const isTeacher = isOwnerOrAdmin(cls, req.user);
  const rows = db.prepare(
    'SELECT * FROM tasks WHERE class_id = ? ORDER BY id ASC',
  ).all(cls.id);
  const tasks = rows.map((row) => serializeTask(row, {
    includeCorrect: isTeacher,
    mySubmission: loadMySubmission(row.id, req.user.id),
    className: cls.name,
  }));
  return res.json({ tasks });
});

// ─── 12.2 POST /api/classes/:id/tasks (guru pemilik / admin) ───────────────
// Jawab {task:{...}} — envelope WAJIB (cast langsung di aplikasi).
router.post('/classes/:id/tasks', (req, res) => {
  const cls = getClassOr404(req, res, req.params.id);
  if (!cls) return undefined;
  if (!isOwnerOrAdmin(cls, req.user)) {
    return err(res, 403, 'Hanya guru pemilik kelas atau admin yang boleh membuat tugas');
  }
  const body = req.body || {};
  if (typeof body.title !== 'string' || body.title.trim() === '') {
    return err(res, 400, 'title wajib diisi');
  }
  if (!Array.isArray(body.questions)) {
    return err(res, 400, 'questions wajib array');
  }
  for (const q of body.questions) {
    if (!q || typeof q.question !== 'string' || !Array.isArray(q.options)) {
      return err(res, 400, 'Tiap soal wajib berisi question dan options');
    }
  }
  const type = body.type === 'assignment' ? 'assignment' : 'quiz';
  const info = db.prepare(
    `INSERT INTO tasks (class_id, title, description, type, opens_at, due_at, questions, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(cls.id, body.title, body.description || '',
    type, body.opensAt || null, body.dueAt || null,
    JSON.stringify(body.questions), isoNow());
  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(info.lastInsertRowid);
  return res.status(201).json({
    task: serializeTask(row, { includeCorrect: true, className: cls.name }),
  });
});

// ─── 12.3 / 12.4 POST /api/tasks/:id/submit ─────────────────────────────────
// Cabang dari bentuk body (A4): ada `answers` (array) = kuis;
// tanpa `answers` = tugas bebas. Hanya anggota kelas (siswa); guru pemilik
// tidak boleh submit tugas sendiri (403).
router.post('/tasks/:id/submit', (req, res) => {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(toInt(req.params.id, -1));
  if (!task) return err(res, 404, 'Tugas tidak ditemukan');
  const cls = db.prepare('SELECT * FROM classes WHERE id = ?').get(task.class_id);
  if (!cls) return err(res, 404, 'Kelas tidak ditemukan');
  if (cls.teacher_id === req.user.id) {
    return err(res, 403, 'Guru tidak dapat mengumpulkan tugas sendiri');
  }
  if (!isMember(cls.id, req.user.id)) {
    return err(res, 403, 'Hanya anggota kelas yang boleh mengumpulkan tugas');
  }
  if (task.due_at && new Date(task.due_at).getTime() < Date.now()) {
    return err(res, 400, 'Tenggat sudah lewat');
  }
  const body = req.body || {};
  const now = isoNow();

  if (Array.isArray(body.answers)) {
    // — Kuis: hitung autoScore dari correctIndex tersimpan. —
    const questions = safeJsonParse(task.questions, []);
    const total = questions.length;
    let correct = 0;
    questions.forEach((q, i) => {
      const key = (q.correctIndex === undefined || q.correctIndex === null)
        ? 0 : toInt(q.correctIndex, 0);
      if (toInt(body.answers[i], -999) === key) correct += 1;
    });
    const autoScore = total > 0 ? Math.round((correct / total) * 100) : 0;
    db.prepare(
      `INSERT INTO submissions
         (task_id, user_id, answers, answer_text, answer_link, file_name, file_mime,
          file_base64, auto_score, submitted_at)
       VALUES (?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?)
       ON CONFLICT(task_id, user_id) DO UPDATE SET
         answers = excluded.answers, answer_text = NULL, answer_link = NULL,
         file_name = NULL, file_mime = NULL, file_base64 = NULL,
         auto_score = excluded.auto_score, submitted_at = excluded.submitted_at`,
    ).run(task.id, req.user.id, JSON.stringify(body.answers.map((a) => toInt(a, 0))),
      autoScore, now);
    return res.json({ autoScore });
  }

  // — Tugas bebas: simpan text/link/file (base64 di JSON, bukan multipart). —
  const file = body.file && typeof body.file === 'object' ? body.file : null;
  db.prepare(
    `INSERT INTO submissions
       (task_id, user_id, answers, answer_text, answer_link, file_name, file_mime,
        file_base64, auto_score, submitted_at)
     VALUES (?, ?, NULL, ?, ?, ?, ?, ?, 0, ?)
     ON CONFLICT(task_id, user_id) DO UPDATE SET
       answers = NULL, answer_text = excluded.answer_text,
       answer_link = excluded.answer_link, file_name = excluded.file_name,
       file_mime = excluded.file_mime, file_base64 = excluded.file_base64,
       auto_score = 0, submitted_at = excluded.submitted_at`,
  ).run(task.id, req.user.id,
    typeof body.text === 'string' ? body.text : null,
    typeof body.link === 'string' ? body.link : null,
    file ? (file.name || 'kiriman') : null,
    file ? (file.mime || 'application/octet-stream') : null,
    file ? (file.base64 || null) : null,
    now);
  return res.json({ ok: true });
});

// ─── 12.5 GET /api/tasks/:id/results (guru pemilik / admin) ─────────────────
router.get('/tasks/:id/results', (req, res) => {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(toInt(req.params.id, -1));
  if (!task) return err(res, 404, 'Tugas tidak ditemukan');
  const cls = db.prepare('SELECT * FROM classes WHERE id = ?').get(task.class_id);
  if (!cls) return err(res, 404, 'Kelas tidak ditemukan');
  if (!isOwnerOrAdmin(cls, req.user)) {
    return err(res, 403, 'Hanya guru pemilik kelas atau admin yang boleh melihat hasil');
  }
  const rows = db.prepare(
    `SELECT s.*, u.name AS student_name, u.email AS student_email
       FROM submissions s JOIN users u ON u.id = s.user_id
      WHERE s.task_id = ? ORDER BY s.submitted_at ASC, s.id ASC`,
  ).all(task.id);
  const results = rows.map((r) => {
    const isQuiz = r.answers !== null && r.answers !== undefined;
    return {
      submissionId: r.id,
      studentId: r.user_id,
      studentName: r.student_name,
      studentEmail: r.student_email,
      // Tugas bebas: answers dikirim sebagai Map {text, link} karena parser
      // aplikasi (TaskResultRow.fromJson) HANYA membaca answerText/answerLink
      // dari `answers` bila berbentuk Map — field terpisah tetap dikirim juga.
      answers: isQuiz
        ? safeJsonParse(r.answers, []).map((a) => toInt(a, 0))
        : { text: r.answer_text || null, link: r.answer_link || null },
      answerText: r.answer_text || null,
      answerLink: r.answer_link || null,
      fileName: r.file_name || null,
      autoScore: r.auto_score,
      score: r.score === null || r.score === undefined ? null : r.score,
      review: r.review || null,
      submittedAt: r.submitted_at || null,
    };
  });
  return res.json({
    task: serializeTask(task, { includeCorrect: true, className: cls.name }),
    results,
  });
});

// ─── 12.6 PUT /api/submissions/:id/grade (guru pemilik / admin) ─────────────
// {score?, review?} — keduanya boleh tidak ada (body {}).
router.put('/submissions/:id/grade', (req, res) => {
  const sub = db.prepare('SELECT * FROM submissions WHERE id = ?')
    .get(toInt(req.params.id, -1));
  if (!sub) return err(res, 404, 'Kiriman tidak ditemukan');
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(sub.task_id);
  if (!task) return err(res, 404, 'Tugas tidak ditemukan');
  const cls = db.prepare('SELECT * FROM classes WHERE id = ?').get(task.class_id);
  if (!cls) return err(res, 404, 'Kelas tidak ditemukan');
  if (!isOwnerOrAdmin(cls, req.user)) {
    return err(res, 403, 'Hanya guru pemilik kelas atau admin yang boleh menilai');
  }
  const body = req.body || {};
  if ('score' in body) {
    db.prepare('UPDATE submissions SET score = ? WHERE id = ?')
      .run(body.score === null ? null : toInt(body.score, 0), sub.id);
  }
  if ('review' in body) {
    db.prepare('UPDATE submissions SET review = ? WHERE id = ?')
      .run(body.review === null ? null : String(body.review), sub.id);
  }
  return res.json({ ok: true });
});

// ─── 12.7 POST /api/scores/sync (siswa) ─────────────────────────────────────
// Hanya field non-null {pretest?, posttest?, latihanBest?, simulatorBest?}
// (0-100); upsert tabel scores.
router.post('/scores/sync', requireRole('siswa'), (req, res) => {
  const body = req.body || {};
  const cols = ['pretest', 'posttest', 'latihanBest', 'simulatorBest'];
  const dbCols = { pretest: 'pretest', posttest: 'posttest', latihanBest: 'latihan_best', simulatorBest: 'simulator_best' };
  const values = {};
  for (const c of cols) {
    if (body[c] !== undefined && body[c] !== null) {
      const n = toInt(body[c], -1);
      if (n < 0 || n > 100) return err(res, 400, `${c} harus 0-100`);
      values[c] = n;
    }
  }
  if (Object.keys(values).length === 0) {
    return err(res, 400, 'Tidak ada skor untuk disinkronkan');
  }
  const now = isoNow();
  const names = Object.keys(values).map((c) => dbCols[c]);
  const placeholders = names.map(() => '?').join(', ');
  const updates = names.map((c) => `${c} = excluded.${c}`).join(', ');
  db.prepare(
    `INSERT INTO scores (user_id, ${names.join(', ')}, updated_at)
     VALUES (?, ${placeholders}, ?)
     ON CONFLICT(user_id) DO UPDATE SET ${updates}, updated_at = excluded.updated_at`,
  ).run(req.user.id, ...Object.values(values), now);
  return res.json({ ok: true });
});

// ─── 12.8 GET /api/classes/:id/leaderboard ──────────────────────────────────
// xp = poin + 10*absensi + 5*live benar + 20*lencana (A11). Urut xp desc.
router.get('/classes/:id/leaderboard', (req, res) => {
  const cls = getClassOr404(req, res, req.params.id);
  if (!cls) return undefined;
  if (!requireClassAccess(req, res, cls)) return undefined;
  const leaderboard = classMembers(cls.id).map((u) => {
    const { xp, attendanceCount, liveCorrect } = computeXp(u.id);
    const badges = db.prepare(
      'SELECT badge_id FROM user_badges WHERE user_id = ? ORDER BY badge_id ASC',
    ).all(u.id).map((b) => ({ id: b.badge_id, name: b.badge_id }));
    return {
      userId: u.id,
      name: u.name,
      xp,
      badges,
      attendanceCount,
      liveCorrect,
      avatarId: u.avatar_id || null,
      bannerId: u.banner_id || null,
    };
  });
  leaderboard.sort((a, b) => b.xp - a.xp || a.name.localeCompare(b.name));
  return res.json({ leaderboard });
});

// ─── 12.9 GET /api/guru/ungraded ────────────────────────────────────────────
// Submission yang belum dinilai (score IS NULL) dari kelas yang saya ajar
// (admin: semua kelas). Terbaru dulu.
router.get('/guru/ungraded', requireRole('guru', 'admin'), (req, res) => {
  const isAdmin = req.user.role === 'admin';
  const rows = db.prepare(
    `SELECT s.id AS submission_id, s.task_id, s.auto_score, s.submitted_at,
            s.user_id AS student_id, u.name AS student_name,
            t.title AS task_title, t.class_id, c.name AS class_name
       FROM submissions s
       JOIN tasks t ON t.id = s.task_id
       JOIN classes c ON c.id = t.class_id
       JOIN users u ON u.id = s.user_id
      WHERE s.score IS NULL ${isAdmin ? '' : 'AND c.teacher_id = ?'}
      ORDER BY s.submitted_at DESC, s.id DESC`,
  ).all(...(isAdmin ? [] : [req.user.id]));
  return res.json({
    submissions: rows.map((r) => ({
      submissionId: r.submission_id,
      taskId: r.task_id,
      taskTitle: r.task_title,
      classId: r.class_id,
      className: r.class_name,
      studentId: r.student_id,
      studentName: r.student_name,
      autoScore: r.auto_score,
      submittedAt: r.submitted_at || null,
    })),
  });
});

// ─── 12.10 GET /api/classes/:id/monitoring (guru pemilik / admin) ───────────
// completionPercent = round(100*taskSubmitted/taskTotal) bila ada tugas;
// bila tidak ada tugas = round(100*materiBenar/4) dari progress_snapshots.
router.get('/classes/:id/monitoring', (req, res) => {
  const cls = getClassOr404(req, res, req.params.id);
  if (!cls) return undefined;
  if (!isOwnerOrAdmin(cls, req.user)) {
    return err(res, 403, 'Hanya guru pemilik kelas atau admin yang boleh memantau kelas');
  }
  const taskIds = db.prepare('SELECT id FROM tasks WHERE class_id = ?').all(cls.id)
    .map((r) => r.id);
  const taskTotal = taskIds.length;
  const students = classMembers(cls.id).map((u) => {
    const { xp, attendanceCount, liveCorrect } = computeXp(u.id);
    let taskSubmitted = 0;
    let lastActivityAt = null;
    if (taskTotal > 0) {
      taskSubmitted = db.prepare(
        `SELECT COUNT(*) AS c FROM submissions
          WHERE user_id = ? AND task_id IN (${taskIds.map(() => '?').join(', ')})`,
      ).get(u.id, ...taskIds).c;
    }
    // lastActivityAt = max(submitted_at tugas kelas ini, earned_at poin, hari streak).
    const lastSub = db.prepare(
      `SELECT MAX(s.submitted_at) AS m FROM submissions s
         JOIN tasks t ON t.id = s.task_id
        WHERE s.user_id = ? AND t.class_id = ?`,
    ).get(u.id, cls.id).m;
    const lastPoint = db.prepare(
      'SELECT MAX(earned_at) AS m FROM point_entries WHERE user_id = ?',
    ).get(u.id).m;
    const lastStreak = db.prepare(
      'SELECT MAX(day) AS m FROM streak_days WHERE user_id = ?',
    ).get(u.id).m;
    const candidates = [lastSub, lastPoint, lastStreak].filter(Boolean);
    if (candidates.length > 0) {
      // Hari streak 'YYYY-MM-DD' dibandingkan sebagai ISO awal hari.
      lastActivityAt = candidates
        .map((c) => (c.length === 10 ? `${c}T00:00:00.000Z` : c))
        .sort().pop();
    }
    let completionPercent;
    if (taskTotal > 0) {
      completionPercent = Math.round((100 * taskSubmitted) / taskTotal);
    } else {
      const snap = db.prepare(
        'SELECT materi FROM progress_snapshots WHERE user_id = ?',
      ).get(u.id);
      const materi = snap ? safeJsonParse(snap.materi, []) : [];
      const done = Array.isArray(materi) ? materi.filter(Boolean).length : 0;
      completionPercent = Math.round((100 * done) / 4);
    }
    return {
      userId: u.id,
      name: u.name,
      email: u.email,
      xp,
      attendanceCount,
      liveCorrect,
      taskTotal,
      taskSubmitted,
      completionPercent,
      streakDays: streakDaysFor(u.id),
      lastActivityAt,
    };
  });
  return res.json({ students });
});

module.exports = router;
