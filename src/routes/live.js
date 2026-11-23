'use strict';
// Kelas Live / BINA LIVE (kontrak §13) + ringkasan guru.
// Mount di /api (server.js). Semua route authRequired.
const express = require('express');
const db = require('../db');
const { authRequired, requireRole } = require('../middleware/auth');
const { isoNow, err, safeJsonParse, toInt } = require('../utils');

const router = express.Router();

function sessionPublic(row) {
  return {
    id: row.id,
    classId: row.class_id,
    teacherId: row.teacher_id,
    title: row.title,
    openingText: row.opening_text || '',
    materialText: row.material_text || '',
    status: row.status,
    startedAt: row.started_at || null,
    endedAt: row.ended_at || null,
  };
}

function loadSession(id) {
  return db.prepare('SELECT * FROM live_sessions WHERE id = ?').get(id);
}

function isClassTeacherOrAdmin(req, classId) {
  if (req.user.role === 'admin') return true;
  const c = db.prepare('SELECT teacher_id FROM classes WHERE id = ?').get(classId);
  return !!c && c.teacher_id === req.user.id;
}

function isClassMember(req, classId) {
  if (req.user.role === 'admin') return true;
  if (isClassTeacherOrAdmin(req, classId)) return true;
  return !!db.prepare('SELECT 1 FROM class_members WHERE class_id = ? AND user_id = ?').get(classId, req.user.id);
}

function quizState(row, userId) {
  const questions = safeJsonParse(row.questions, []);
  const total = questions.length;
  const answeredCount = db.prepare(
    'SELECT COUNT(DISTINCT user_id) AS c FROM live_quiz_answers WHERE quiz_id = ?',
  ).get(row.id).c;
  const myAnsweredCount = db.prepare(
    'SELECT COUNT(*) AS c FROM live_quiz_answers WHERE quiz_id = ? AND user_id = ?',
  ).get(row.id, userId).c;
  const state = {
    id: row.id,
    title: row.title,
    status: row.status,
    currentIndex: row.current_index,
    totalQuestions: total,
    bossMaxHp: row.boss_max_hp,
    bossHpRemaining: row.boss_hp_remaining,
    myAnsweredCount,
    answeredCount,
  };
  // Soal berjalan dikirim TANPA correctIndex (kontrak §13.9).
  if (row.status === 'running' && row.current_index >= 0 && row.current_index < total) {
    const q = questions[row.current_index];
    state.currentQuestion = { question: q.question || '', options: q.options || [] };
  }
  return state;
}

// 13.1 — GET /api/guru/briefing
router.get('/guru/briefing', authRequired, (req, res) => {
  const classIds = db.prepare('SELECT id FROM classes WHERE teacher_id = ?').all(req.user.id).map((r) => r.id);
  const classCount = classIds.length;
  const studentCount = classIds.length
    ? db.prepare(`SELECT COUNT(*) AS c FROM class_members WHERE class_id IN (${classIds.map(() => '?').join(',')})`).get(...classIds).c
    : 0;
  const activeSessionCount = classIds.length
    ? db.prepare(`SELECT COUNT(*) AS c FROM live_sessions WHERE class_id IN (${classIds.map(() => '?').join(',')}) AND status = 'active'`).get(...classIds).c
    : 0;
  const ungradedCount = classIds.length
    ? db.prepare(`SELECT COUNT(*) AS c FROM submissions s JOIN tasks t ON t.id = s.task_id WHERE t.class_id IN (${classIds.map(() => '?').join(',')}) AND s.score IS NULL`).get(...classIds).c
    : 0;
  const recent = classIds.length
    ? db.prepare(`SELECT u.name AS studentName, t.title AS taskTitle, s.auto_score AS autoScore, s.submitted_at AS submittedAt
        FROM submissions s JOIN tasks t ON t.id = s.task_id JOIN users u ON u.id = s.user_id
        WHERE t.class_id IN (${classIds.map(() => '?').join(',')})
        ORDER BY s.submitted_at DESC LIMIT 5`).all(...classIds)
    : [];
  const activeSessions = classIds.length
    ? db.prepare(`SELECT * FROM live_sessions WHERE class_id IN (${classIds.map(() => '?').join(',')}) AND status = 'active' ORDER BY started_at DESC`).all(...classIds).map(sessionPublic)
    : [];
  return res.json({
    classCount,
    studentCount,
    activeSessionCount,
    ungradedCount,
    recentSubmissions: recent.map((r) => ({
      studentName: r.studentName || '',
      taskTitle: r.taskTitle || '',
      autoScore: r.autoScore || 0,
      submittedAt: r.submittedAt || null,
    })),
    activeSessions,
  });
});

// 13.2 — POST /api/classes/:id/sessions (guru pemilik)
router.post('/classes/:id/sessions', authRequired, (req, res) => {
  const classId = toInt(req.params.id);
  const cls = db.prepare('SELECT * FROM classes WHERE id = ?').get(classId);
  if (!cls) return err(res, 404, 'Kelas tidak ditemukan');
  if (!isClassTeacherOrAdmin(req, classId)) return err(res, 403, 'Hanya guru pemilik kelas yang boleh memulai sesi live');
  const { title, openingText } = req.body || {};
  if (!title || !String(title).trim()) return err(res, 400, 'Judul sesi wajib diisi');
  // Satu sesi aktif per kelas: sesi aktif lama ditutup dulu.
  db.prepare("UPDATE live_sessions SET status = 'ended', ended_at = ? WHERE class_id = ? AND status = 'active'")
    .run(isoNow(), classId);
  const info = db.prepare(
    'INSERT INTO live_sessions (class_id, teacher_id, title, opening_text, material_text, status, started_at) VALUES (?,?,?,?,?,?,?)',
  ).run(classId, req.user.id, String(title), openingText ? String(openingText) : '', '', 'active', isoNow());
  const row = loadSession(info.lastInsertRowid);
  return res.status(201).json({ session: sessionPublic(row) });
});

// 13.3 — GET /api/classes/:id/sessions/active
router.get('/classes/:id/sessions/active', authRequired, (req, res) => {
  const classId = toInt(req.params.id);
  const cls = db.prepare('SELECT * FROM classes WHERE id = ?').get(classId);
  if (!cls) return err(res, 404, 'Kelas tidak ditemukan');
  if (!isClassMember(req, classId)) return err(res, 404, 'Kelas tidak ditemukan');
  const row = db.prepare(
    "SELECT * FROM live_sessions WHERE class_id = ? AND status = 'active' ORDER BY started_at DESC LIMIT 1",
  ).get(classId);
  return res.json({ session: row ? sessionPublic(row) : null });
});

// 13.4 — POST /api/sessions/:id/end (guru pemilik)
router.post('/sessions/:id/end', authRequired, (req, res) => {
  const s = loadSession(toInt(req.params.id));
  if (!s) return err(res, 404, 'Sesi tidak ditemukan');
  if (!isClassTeacherOrAdmin(req, s.class_id)) return err(res, 403, 'Hanya guru pemilik kelas yang boleh mengakhiri sesi');
  db.prepare("UPDATE live_sessions SET status = 'ended', ended_at = ? WHERE id = ?").run(isoNow(), s.id);
  const attendanceCount = db.prepare('SELECT COUNT(*) AS c FROM live_attendance WHERE session_id = ?').get(s.id).c;
  const quizCount = db.prepare('SELECT COUNT(*) AS c FROM live_quizzes WHERE session_id = ?').get(s.id).c;
  const rows = db.prepare('SELECT level, COUNT(*) AS c FROM live_understanding WHERE session_id = ? GROUP BY level').all(s.id);
  const understandingCounts = { 0: 0, 1: 0, 2: 0 };
  for (const r of rows) understandingCounts[String(r.level)] = r.c;
  return res.json({ summary: { attendanceCount, quizCount, understandingCounts } });
});

// 13.5 — POST /api/sessions/:id/join
router.post('/sessions/:id/join', authRequired, (req, res) => {
  const s = loadSession(toInt(req.params.id));
  if (!s) return err(res, 404, 'Sesi tidak ditemukan');
  if (!isClassMember(req, s.class_id)) return err(res, 404, 'Sesi tidak ditemukan');
  if (s.status !== 'active') return err(res, 400, 'Sesi sudah berakhir');
  const now = isoNow();
  db.prepare('INSERT OR IGNORE INTO live_attendance (session_id, user_id, joined_at) VALUES (?,?,?)')
    .run(s.id, req.user.id, now);
  const row = db.prepare('SELECT * FROM live_attendance WHERE session_id = ? AND user_id = ?').get(s.id, req.user.id);
  return res.json({ attendance: { joinedAt: row.joined_at } });
});

// 13.6 — PUT /api/sessions/:id/material (guru pemilik)
router.put('/sessions/:id/material', authRequired, (req, res) => {
  const s = loadSession(toInt(req.params.id));
  if (!s) return err(res, 404, 'Sesi tidak ditemukan');
  if (!isClassTeacherOrAdmin(req, s.class_id)) return err(res, 403, 'Hanya guru pemilik kelas yang boleh mengubah materi sesi');
  const body = req.body || {};
  const materialText = body.materialText !== undefined && body.materialText !== null ? String(body.materialText) : s.material_text;
  const openingText = body.openingText !== undefined && body.openingText !== null ? String(body.openingText) : s.opening_text;
  db.prepare('UPDATE live_sessions SET material_text = ?, opening_text = ? WHERE id = ?')
    .run(materialText, openingText, s.id);
  return res.json({ session: sessionPublic(loadSession(s.id)) });
});

// 13.7 — GET /api/sessions/:id/state
router.get('/sessions/:id/state', authRequired, (req, res) => {
  const s = loadSession(toInt(req.params.id));
  if (!s) return err(res, 404, 'Sesi tidak ditemukan');
  if (!isClassMember(req, s.class_id)) return err(res, 404, 'Sesi tidak ditemukan');
  const attendanceCount = db.prepare('SELECT COUNT(*) AS c FROM live_attendance WHERE session_id = ?').get(s.id).c;
  const att = db.prepare('SELECT * FROM live_attendance WHERE session_id = ? AND user_id = ?').get(s.id, req.user.id);
  const quizzes = db.prepare('SELECT * FROM live_quizzes WHERE session_id = ? ORDER BY id').all(s.id)
    .map((q) => quizState(q, req.user.id));
  const urows = db.prepare('SELECT level, COUNT(*) AS c FROM live_understanding WHERE session_id = ? GROUP BY level').all(s.id);
  const counts = { 0: 0, 1: 0, 2: 0 };
  for (const r of urows) counts[String(r.level)] = r.c;
  const my = db.prepare('SELECT level FROM live_understanding WHERE session_id = ? AND user_id = ?').get(s.id, req.user.id);
  const understanding = { counts };
  if (my) understanding.myLevel = my.level;
  return res.json({
    session: sessionPublic(s),
    attendanceCount,
    myAttendance: att
      ? { joined: true, present: true, joinedAt: att.joined_at }
      : { joined: false, present: false, joinedAt: null },
    quizzes,
    understanding,
  });
});

// 13.8 — POST /api/sessions/:id/quizzes (guru pemilik)
router.post('/sessions/:id/quizzes', authRequired, (req, res) => {
  const s = loadSession(toInt(req.params.id));
  if (!s) return err(res, 404, 'Sesi tidak ditemukan');
  if (!isClassTeacherOrAdmin(req, s.class_id)) return err(res, 403, 'Hanya guru pemilik kelas yang boleh membuat kuis live');
  const { title, questions, bossMaxHp } = req.body || {};
  if (!title || !String(title).trim()) return err(res, 400, 'Judul kuis wajib diisi');
  if (!Array.isArray(questions) || questions.length === 0) return err(res, 400, 'Kuis harus punya minimal satu soal');
  const maxHp = bossMaxHp !== undefined && bossMaxHp !== null ? toInt(bossMaxHp, 100) : 100;
  db.prepare(
    'INSERT INTO live_quizzes (session_id, title, status, current_index, boss_max_hp, boss_hp_remaining, questions) VALUES (?,?,?,?,?,?,?)',
  ).run(s.id, String(title), 'waiting', -1, maxHp, maxHp, JSON.stringify(questions));
  return res.status(201).json({ ok: true });
});

// 13.9 — POST /api/quizzes/:id/control (guru pemilik)
router.post('/quizzes/:id/control', authRequired, (req, res) => {
  const q = db.prepare('SELECT * FROM live_quizzes WHERE id = ?').get(toInt(req.params.id));
  if (!q) return err(res, 404, 'Kuis tidak ditemukan');
  const s = loadSession(q.session_id);
  if (!s || !isClassTeacherOrAdmin(req, s.class_id)) return err(res, 403, 'Hanya guru pemilik kelas yang boleh mengendalikan kuis');
  const { action } = req.body || {};
  const questions = safeJsonParse(q.questions, []);
  let status = q.status;
  let currentIndex = q.current_index;
  if (action === 'start') {
    status = 'running';
    currentIndex = 0;
  } else if (action === 'next') {
    currentIndex += 1;
    if (currentIndex >= questions.length) {
      status = 'finished';
      currentIndex = questions.length - 1;
    } else {
      status = 'running';
    }
  } else if (action === 'finish') {
    status = 'finished';
  } else {
    return err(res, 400, 'Aksi tidak dikenal');
  }
  db.prepare('UPDATE live_quizzes SET status = ?, current_index = ? WHERE id = ?').run(status, currentIndex, q.id);
  const updated = db.prepare('SELECT * FROM live_quizzes WHERE id = ?').get(q.id);
  return res.json({ quiz: quizState(updated, req.user.id) });
});

// 13.10 — POST /api/quizzes/:id/answer
router.post('/quizzes/:id/answer', authRequired, (req, res) => {
  const q = db.prepare('SELECT * FROM live_quizzes WHERE id = ?').get(toInt(req.params.id));
  if (!q) return err(res, 404, 'Kuis tidak ditemukan');
  const s = loadSession(q.session_id);
  if (!s || !isClassMember(req, s.class_id)) return err(res, 404, 'Kuis tidak ditemukan');
  if (q.status !== 'running') return err(res, 400, 'Kuis belum berjalan');
  const { questionIndex, selectedIndex } = req.body || {};
  const qi = toInt(questionIndex, -1);
  const si = toInt(selectedIndex, -1);
  if (qi < 0 || qi !== q.current_index) return err(res, 400, 'Soal tidak aktif');
  const questions = safeJsonParse(q.questions, []);
  const question = questions[qi];
  if (!question) return err(res, 400, 'Soal tidak ditemukan');
  const correct = Number(question.correctIndex) === si;
  const prev = db.prepare('SELECT * FROM live_quiz_answers WHERE quiz_id = ? AND user_id = ? AND question_index = ?')
    .get(q.id, req.user.id, qi);
  // Kerusakan boss: jawaban benar pertama untuk soal ini mengurangi HP boss
  // sebesar ceil(maxHp / jumlah soal). Jawaban ulang tidak mengurangi lagi.
  // (Keputusan koordinator — rumus tidak ada di kontrak; lihat README.)
  if (correct && (!prev || prev.correct !== 1)) {
    const damage = Math.max(1, Math.ceil(q.boss_max_hp / Math.max(1, questions.length)));
    const remaining = Math.max(0, q.boss_hp_remaining - damage);
    db.prepare('UPDATE live_quizzes SET boss_hp_remaining = ? WHERE id = ?').run(remaining, q.id);
  }
  db.prepare(`INSERT INTO live_quiz_answers (quiz_id, user_id, question_index, selected_index, correct)
    VALUES (?,?,?,?,?)
    ON CONFLICT(quiz_id, user_id, question_index) DO UPDATE SET selected_index = excluded.selected_index, correct = excluded.correct`)
    .run(q.id, req.user.id, qi, si, correct ? 1 : 0);
  return res.json({ correct });
});

// 13.11 — PUT /api/sessions/:id/understanding
router.put('/sessions/:id/understanding', authRequired, (req, res) => {
  const s = loadSession(toInt(req.params.id));
  if (!s) return err(res, 404, 'Sesi tidak ditemukan');
  if (!isClassMember(req, s.class_id)) return err(res, 404, 'Sesi tidak ditemukan');
  const level = toInt((req.body || {}).level, -1);
  if (![0, 1, 2].includes(level)) return err(res, 400, 'Level harus 0, 1, atau 2');
  db.prepare(`INSERT INTO live_understanding (session_id, user_id, level) VALUES (?,?,?)
    ON CONFLICT(session_id, user_id) DO UPDATE SET level = excluded.level`)
    .run(s.id, req.user.id, level);
  return res.json({ ok: true });
});

// 13.12 — POST /api/sessions/:id/groups (guru pemilik)
router.post('/sessions/:id/groups', authRequired, (req, res) => {
  const s = loadSession(toInt(req.params.id));
  if (!s) return err(res, 404, 'Sesi tidak ditemukan');
  if (!isClassTeacherOrAdmin(req, s.class_id)) return err(res, 403, 'Hanya guru pemilik kelas yang boleh membuat grup');
  const groupCount = toInt((req.body || {}).groupCount, 0);
  if (groupCount < 1) return err(res, 400, 'Jumlah grup minimal 1');
  const attendees = db.prepare(
    'SELECT u.id AS userId, u.name FROM live_attendance la JOIN users u ON u.id = la.user_id WHERE la.session_id = ? ORDER BY la.joined_at',
  ).all(s.id);
  const members = attendees.length
    ? attendees
    : db.prepare('SELECT u.id AS userId, u.name FROM class_members cm JOIN users u ON u.id = cm.user_id WHERE cm.class_id = ? ORDER BY u.name').all(s.class_id);
  db.prepare('DELETE FROM breakout_groups WHERE session_id = ?').run(s.id);
  const groups = [];
  for (let i = 0; i < groupCount; i++) {
    const info = db.prepare('INSERT INTO breakout_groups (session_id, name) VALUES (?,?)')
      .run(s.id, `Kelompok ${i + 1}`);
    groups.push({ id: info.lastInsertRowid, name: `Kelompok ${i + 1}`, members: [] });
  }
  members.forEach((m, idx) => {
    const g = groups[idx % groupCount];
    db.prepare('INSERT INTO breakout_group_members (group_id, user_id) VALUES (?,?)').run(g.id, m.userId);
    g.members.push({ userId: m.userId, name: m.name });
  });
  return res.status(201).json({ groups });
});

// 13.13 — GET /api/sessions/:id/groups
router.get('/sessions/:id/groups', authRequired, (req, res) => {
  const s = loadSession(toInt(req.params.id));
  if (!s) return err(res, 404, 'Sesi tidak ditemukan');
  if (!isClassMember(req, s.class_id)) return err(res, 404, 'Sesi tidak ditemukan');
  const groups = db.prepare('SELECT * FROM breakout_groups WHERE session_id = ? ORDER BY id').all(s.id)
    .map((g) => ({
      id: g.id,
      name: g.name,
      members: db.prepare(
        'SELECT u.id AS userId, u.name FROM breakout_group_members bgm JOIN users u ON u.id = bgm.user_id WHERE bgm.group_id = ? ORDER BY u.name',
      ).all(g.id),
    }));
  const mine = db.prepare(
    'SELECT bgm.group_id FROM breakout_group_members bgm JOIN breakout_groups bg ON bg.id = bgm.group_id WHERE bg.session_id = ? AND bgm.user_id = ?',
  ).get(s.id, req.user.id);
  const out = { groups };
  if (mine) out.myGroupId = mine.group_id;
  return res.json(out);
});

// 13.14 — GET /api/groups/:id/messages
router.get('/groups/:id/messages', authRequired, (req, res) => {
  const groupId = toInt(req.params.id);
  const g = db.prepare('SELECT * FROM breakout_groups WHERE id = ?').get(groupId);
  if (!g) return err(res, 404, 'Grup tidak ditemukan');
  const s = loadSession(g.session_id);
  if (!s || !isClassMember(req, s.class_id)) return err(res, 404, 'Grup tidak ditemukan');
  const messages = db.prepare(
    'SELECT gm.id, gm.user_id AS userId, u.name AS userName, gm.text, gm.created_at AS createdAt FROM group_messages gm JOIN users u ON u.id = gm.user_id WHERE gm.group_id = ? ORDER BY gm.id',
  ).all(groupId);
  return res.json({ messages });
});

// 13.15 — POST /api/groups/:id/messages
router.post('/groups/:id/messages', authRequired, (req, res) => {
  const groupId = toInt(req.params.id);
  const g = db.prepare('SELECT * FROM breakout_groups WHERE id = ?').get(groupId);
  if (!g) return err(res, 404, 'Grup tidak ditemukan');
  const s = loadSession(g.session_id);
  if (!s || !isClassMember(req, s.class_id)) return err(res, 404, 'Grup tidak ditemukan');
  const { text } = req.body || {};
  if (!text || !String(text).trim()) return err(res, 400, 'Pesan tidak boleh kosong');
  const info = db.prepare('INSERT INTO group_messages (group_id, user_id, text, created_at) VALUES (?,?,?,?)')
    .run(groupId, req.user.id, String(text), isoNow());
  return res.status(201).json({
    message: {
      id: info.lastInsertRowid,
      userId: req.user.id,
      userName: req.user.name,
      text: String(text),
      createdAt: isoNow(),
    },
  });
});

module.exports = router;
