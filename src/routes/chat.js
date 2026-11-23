'use strict';
// Chat langsung guru <-> siswa (kontrak §14). Mount di /api/chat (server.js).
// Semua route authRequired.
const express = require('express');
const db = require('../db');
const { authRequired } = require('../middleware/auth');
const { isoNow, err, toInt } = require('../utils');

const router = express.Router();

function conversationPublic(row, meId) {
  const teacher = db.prepare('SELECT name FROM users WHERE id = ?').get(row.teacher_id);
  const student = db.prepare('SELECT name FROM users WHERE id = ?').get(row.student_id);
  const cls = db.prepare('SELECT name FROM classes WHERE id = ?').get(row.class_id);
  const last = db.prepare(
    'SELECT id, sender_id AS senderId, text, created_at AS createdAt FROM direct_messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 1',
  ).get(row.id);
  // unreadCount: pesan dari lawan bicara yang belum saya baca.
  const unread = db.prepare(
    `SELECT COUNT(*) AS c FROM direct_messages
     WHERE conversation_id = ? AND sender_id != ?
     AND ((? = 'guru' AND read_by_teacher = 0) OR (? = 'siswa' AND read_by_student = 0))`,
  ).get(row.id, meId, meRole(row), meRole(row)).c;
  return {
    id: row.id,
    classId: row.class_id,
    className: cls ? cls.name : null,
    teacherId: row.teacher_id,
    teacherName: teacher ? teacher.name : null,
    studentId: row.student_id,
    studentName: student ? student.name : null,
    lastMessage: last || null,
    unreadCount: unread,
  };
}

// Peran saya di percakapan ini: guru bila saya teacher-nya, siswa bila student-nya.
function meRole(row) {
  return row._meIsTeacher ? 'guru' : 'siswa';
}

function loadConversation(id, me) {
  const row = db.prepare('SELECT * FROM conversations WHERE id = ?').get(id);
  if (!row) return null;
  if (row.teacher_id !== me.id && row.student_id !== me.id && me.role !== 'admin') return null;
  row._meIsTeacher = row.teacher_id === me.id;
  return row;
}

// 14.1 — GET /api/chat/conversations
router.get('/conversations', authRequired, (req, res) => {
  const rows = db.prepare(
    'SELECT * FROM conversations WHERE teacher_id = ? OR student_id = ? ORDER BY id DESC',
  ).all(req.user.id, req.user.id);
  const out = rows.map((r) => {
    r._meIsTeacher = r.teacher_id === req.user.id;
    return conversationPublic(r, req.user.id);
  });
  return res.json({ conversations: out });
});

// 14.2 — POST /api/chat/conversations
router.post('/conversations', authRequired, (req, res) => {
  const { classId, studentId } = req.body || {};
  const cid = toInt(classId, 0);
  const cls = db.prepare('SELECT * FROM classes WHERE id = ?').get(cid);
  if (!cls) return err(res, 404, 'Kelas tidak ditemukan');
  let teacherId;
  let sid;
  if (req.user.role === 'guru') {
    if (!studentId) return err(res, 400, 'studentId wajib diisi guru');
    if (cls.teacher_id !== req.user.id && req.user.role !== 'admin') {
      return err(res, 403, 'Hanya guru pemilik kelas yang boleh membuka percakapan');
    }
    teacherId = cls.teacher_id;
    sid = toInt(studentId, 0);
    const isMember = db.prepare('SELECT 1 FROM class_members WHERE class_id = ? AND user_id = ?').get(cid, sid);
    if (!isMember) return err(res, 404, 'Siswa tidak ditemukan di kelas ini');
  } else if (req.user.role === 'siswa') {
    const isMember = db.prepare('SELECT 1 FROM class_members WHERE class_id = ? AND user_id = ?').get(cid, req.user.id);
    if (!isMember) return err(res, 403, 'Kamu bukan anggota kelas ini');
    teacherId = cls.teacher_id;
    sid = req.user.id;
  } else {
    return err(res, 403, 'Admin tidak membuka percakapan chat');
  }
  let row = db.prepare('SELECT * FROM conversations WHERE class_id = ? AND student_id = ?').get(cid, sid);
  if (!row) {
    const info = db.prepare('INSERT INTO conversations (class_id, teacher_id, student_id) VALUES (?,?,?)')
      .run(cid, teacherId, sid);
    row = db.prepare('SELECT * FROM conversations WHERE id = ?').get(info.lastInsertRowid);
  }
  row._meIsTeacher = row.teacher_id === req.user.id;
  return res.status(201).json({ conversation: conversationPublic(row, req.user.id) });
});

// 14.3 — GET /api/chat/conversations/:id/messages
router.get('/conversations/:id/messages', authRequired, (req, res) => {
  const conv = loadConversation(toInt(req.params.id), req.user);
  if (!conv) return err(res, 404, 'Percakapan tidak ditemukan');
  const messages = db.prepare(
    `SELECT dm.id, dm.conversation_id AS conversationId, dm.sender_id AS senderId,
            u.name AS senderName, dm.text, dm.created_at AS createdAt
     FROM direct_messages dm JOIN users u ON u.id = dm.sender_id
     WHERE dm.conversation_id = ? ORDER BY dm.id`,
  ).all(conv.id);
  return res.json({ messages });
});

// 14.4 — POST /api/chat/conversations/:id/messages
router.post('/conversations/:id/messages', authRequired, (req, res) => {
  const conv = loadConversation(toInt(req.params.id), req.user);
  if (!conv) return err(res, 404, 'Percakapan tidak ditemukan');
  const { text } = req.body || {};
  if (!text || !String(text).trim()) return err(res, 400, 'Pesan tidak boleh kosong');
  const fromTeacher = req.user.id === conv.teacher_id;
  const info = db.prepare(
    'INSERT INTO direct_messages (conversation_id, sender_id, text, created_at, read_by_teacher, read_by_student) VALUES (?,?,?,?,?,?)',
  ).run(conv.id, req.user.id, String(text), isoNow(), fromTeacher ? 1 : 0, fromTeacher ? 0 : 1);
  return res.status(201).json({
    message: {
      id: info.lastInsertRowid,
      conversationId: conv.id,
      senderId: req.user.id,
      senderName: req.user.name,
      text: String(text),
      createdAt: isoNow(),
    },
  });
});

// 14.5 — POST /api/chat/conversations/:id/read
router.post('/conversations/:id/read', authRequired, (req, res) => {
  const conv = loadConversation(toInt(req.params.id), req.user);
  if (!conv) return err(res, 404, 'Percakapan tidak ditemukan');
  const meIsTeacher = req.user.id === conv.teacher_id;
  if (meIsTeacher) {
    db.prepare('UPDATE direct_messages SET read_by_teacher = 1 WHERE conversation_id = ? AND sender_id != ?')
      .run(conv.id, req.user.id);
  } else {
    db.prepare('UPDATE direct_messages SET read_by_student = 1 WHERE conversation_id = ? AND sender_id != ?')
      .run(conv.id, req.user.id);
  }
  return res.json({ ok: true });
});

// 14.6 — GET /api/chat/unread
router.get('/unread', authRequired, (req, res) => {
  const rows = db.prepare(
    'SELECT * FROM conversations WHERE teacher_id = ? OR student_id = ?',
  ).all(req.user.id, req.user.id);
  let total = 0;
  for (const r of rows) {
    const meIsTeacher = r.teacher_id === req.user.id;
    const row = db.prepare(
      `SELECT COUNT(*) AS c FROM direct_messages
       WHERE conversation_id = ? AND sender_id != ? AND ${meIsTeacher ? 'read_by_teacher = 0' : 'read_by_student = 0'}`,
    ).get(r.id, req.user.id);
    total += row.c;
  }
  return res.json({ total });
});

module.exports = router;
