'use strict';
// Materi, Pengumuman, Laporan Orang Tua (kontrak §15). Mount di /api.
// Semua route authRequired.
const express = require('express');
const db = require('../db');
const { authRequired } = require('../middleware/auth');
const { isoNow, err, safeJsonParse, toInt, genToken } = require('../utils');

const router = express.Router();

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

function materialPublic(row) {
  const cls = db.prepare('SELECT name FROM classes WHERE id = ?').get(row.class_id);
  return {
    id: row.id,
    classId: row.class_id,
    className: cls ? cls.name : null,
    title: row.title,
    description: row.description || '',
    linkUrl: row.link_url || null,
    fileName: row.file_name || null,
    fileMime: row.file_mime || null,
    hasFile: !!row.has_file,
    createdAt: row.created_at || null,
  };
}

function makeDownloadToken(kind, refId) {
  const token = genToken(32);
  const expires = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  db.prepare('INSERT INTO download_tokens (token, kind, ref_id, expires_at) VALUES (?,?,?,?)')
    .run(token, kind, refId, expires);
  return token;
}

// 15.1 — GET /api/classes/:id/materials
router.get('/classes/:id/materials', authRequired, (req, res) => {
  const classId = toInt(req.params.id);
  const cls = db.prepare('SELECT * FROM classes WHERE id = ?').get(classId);
  if (!cls) return err(res, 404, 'Kelas tidak ditemukan');
  if (!isClassMember(req, classId)) return err(res, 404, 'Kelas tidak ditemukan');
  const rows = db.prepare('SELECT * FROM materials WHERE class_id = ? ORDER BY id').all(classId);
  return res.json({ materials: rows.map(materialPublic) });
});

// 15.2 — POST /api/classes/:id/materials (guru pemilik)
router.post('/classes/:id/materials', authRequired, (req, res) => {
  const classId = toInt(req.params.id);
  const cls = db.prepare('SELECT * FROM classes WHERE id = ?').get(classId);
  if (!cls) return err(res, 404, 'Kelas tidak ditemukan');
  if (!isClassTeacherOrAdmin(req, classId)) return err(res, 403, 'Hanya guru pemilik kelas yang boleh menambah materi');
  const { title, description, linkUrl, file } = req.body || {};
  if (!title || !String(title).trim()) return err(res, 400, 'Judul materi wajib diisi');
  const hasFile = !!(file && file.base64);
  const info = db.prepare(
    'INSERT INTO materials (class_id, title, description, link_url, file_name, file_mime, file_base64, has_file, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
  ).run(
    classId,
    String(title),
    description ? String(description) : '',
    linkUrl ? String(linkUrl) : null,
    hasFile ? String(file.name || 'materi') : null,
    hasFile ? String(file.mime || 'application/octet-stream') : null,
    hasFile ? String(file.base64) : null,
    hasFile ? 1 : 0,
    isoNow(),
  );
  const row = db.prepare('SELECT * FROM materials WHERE id = ?').get(info.lastInsertRowid);
  return res.status(201).json({ material: materialPublic(row) });
});

// 15.3 — DELETE /api/materials/:id (guru pemilik)
router.delete('/materials/:id', authRequired, (req, res) => {
  const row = db.prepare('SELECT * FROM materials WHERE id = ?').get(toInt(req.params.id));
  if (!row) return err(res, 404, 'Materi tidak ditemukan');
  if (!isClassTeacherOrAdmin(req, row.class_id)) return err(res, 403, 'Hanya guru pemilik kelas yang boleh menghapus materi');
  db.prepare('DELETE FROM materials WHERE id = ?').run(row.id);
  return res.json({ ok: true });
});

// 15.4 — POST /api/materials/:id/download-token
router.post('/materials/:id/download-token', authRequired, (req, res) => {
  const row = db.prepare('SELECT * FROM materials WHERE id = ?').get(toInt(req.params.id));
  if (!row) return err(res, 404, 'Materi tidak ditemukan');
  if (!isClassMember(req, row.class_id)) return err(res, 404, 'Materi tidak ditemukan');
  if (!row.has_file) return err(res, 400, 'Materi ini tidak memiliki berkas');
  const token = makeDownloadToken('material', row.id);
  return res.json({ url: `/api/files/${token}` });
});

// 15.5 — POST /api/submissions/:id/download-token
router.post('/submissions/:id/download-token', authRequired, (req, res) => {
  const sub = db.prepare('SELECT * FROM submissions WHERE id = ?').get(toInt(req.params.id));
  if (!sub) return err(res, 404, 'Kiriman tidak ditemukan');
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(sub.task_id);
  const allowed = sub.user_id === req.user.id
    || (task && isClassTeacherOrAdmin(req, task.class_id));
  if (!allowed) return err(res, 403, 'Kamu tidak berhak mengunduh kiriman ini');
  if (!sub.file_base64) return err(res, 400, 'Kiriman ini tidak memiliki berkas');
  const token = makeDownloadToken('submission', sub.id);
  return res.json({ url: `/api/files/${token}` });
});

// 15.6 — GET /api/classes/:id/announcements
router.get('/classes/:id/announcements', authRequired, (req, res) => {
  const classId = toInt(req.params.id);
  const cls = db.prepare('SELECT * FROM classes WHERE id = ?').get(classId);
  if (!cls) return err(res, 404, 'Kelas tidak ditemukan');
  if (!isClassMember(req, classId)) return err(res, 404, 'Kelas tidak ditemukan');
  const rows = db.prepare(
    `SELECT a.*, u.name AS authorName FROM announcements a JOIN users u ON u.id = a.author_id
     WHERE a.class_id = ? ORDER BY a.id DESC`,
  ).all(classId);
  return res.json({
    announcements: rows.map((r) => ({
      id: r.id,
      classId: r.class_id,
      authorId: r.author_id,
      authorName: r.authorName || null,
      text: r.text,
      createdAt: r.created_at || null,
    })),
  });
});

// 15.7 — POST /api/classes/:id/announcements (guru pemilik)
router.post('/classes/:id/announcements', authRequired, (req, res) => {
  const classId = toInt(req.params.id);
  const cls = db.prepare('SELECT * FROM classes WHERE id = ?').get(classId);
  if (!cls) return err(res, 404, 'Kelas tidak ditemukan');
  if (!isClassTeacherOrAdmin(req, classId)) return err(res, 403, 'Hanya guru pemilik kelas yang boleh membuat pengumuman');
  const { text } = req.body || {};
  if (!text || !String(text).trim()) return err(res, 400, 'Isi pengumuman wajib diisi');
  const info = db.prepare('INSERT INTO announcements (class_id, author_id, text, created_at) VALUES (?,?,?,?)')
    .run(classId, req.user.id, String(text), isoNow());
  return res.status(201).json({
    announcement: {
      id: info.lastInsertRowid,
      classId,
      authorId: req.user.id,
      authorName: req.user.name,
      text: String(text),
      createdAt: isoNow(),
    },
  });
});

// 15.8 — DELETE /api/announcements/:id (guru pemilik / penulis)
router.delete('/announcements/:id', authRequired, (req, res) => {
  const row = db.prepare('SELECT * FROM announcements WHERE id = ?').get(toInt(req.params.id));
  if (!row) return err(res, 404, 'Pengumuman tidak ditemukan');
  if (!isClassTeacherOrAdmin(req, row.class_id) && row.author_id !== req.user.id) {
    return err(res, 403, 'Kamu tidak berhak menghapus pengumuman ini');
  }
  db.prepare('DELETE FROM announcements WHERE id = ?').run(row.id);
  return res.json({ ok: true });
});

// 15.9 — POST /api/classes/:id/students/:studentId/parent-report (guru pemilik)
router.post('/classes/:id/students/:studentId/parent-report', authRequired, (req, res) => {
  const classId = toInt(req.params.id);
  const studentId = toInt(req.params.studentId);
  const cls = db.prepare('SELECT * FROM classes WHERE id = ?').get(classId);
  if (!cls) return err(res, 404, 'Kelas tidak ditemukan');
  if (!isClassTeacherOrAdmin(req, classId)) return err(res, 403, 'Hanya guru pemilik kelas yang boleh membuat laporan');
  const student = db.prepare('SELECT * FROM users WHERE id = ?').get(studentId);
  if (!student) return err(res, 404, 'Siswa tidak ditemukan');
  const isMember = db.prepare('SELECT 1 FROM class_members WHERE class_id = ? AND user_id = ?').get(classId, studentId);
  if (!isMember) return err(res, 404, 'Siswa tidak ditemukan di kelas ini');

  const sc = db.prepare('SELECT * FROM scores WHERE user_id = ?').get(studentId);
  const totalPoints = db.prepare('SELECT COALESCE(SUM(points),0) AS t FROM point_entries WHERE user_id = ?').get(studentId).t;
  const attCount = db.prepare('SELECT COUNT(*) AS c FROM attendance WHERE user_id = ?').get(studentId).c;
  const streak = db.prepare('SELECT COUNT(*) AS c FROM streak_days WHERE user_id = ?').get(studentId).c;
  const prog = db.prepare('SELECT * FROM progress_snapshots WHERE user_id = ?').get(studentId);
  const materiDone = prog ? safeJsonParse(prog.materi, []).filter(Boolean).length : 0;
  const badges = db.prepare('SELECT COUNT(*) AS c FROM user_badges WHERE user_id = ?').get(studentId).c;
  const fmt = (v) => (v === null || v === undefined ? '-' : String(v));
  const content = [
    `Laporan Perkembangan Belajar — ${student.name} (${cls.name})`,
    ``,
    `Nilai: Pre-Test ${fmt(sc && sc.pretest)}, Post-Test ${fmt(sc && sc.posttest)}, Latihan Terbaik ${fmt(sc && sc.latihan_best)}, Simulator Terbaik ${fmt(sc && sc.simulator_best)}.`,
    `Total poin: ${totalPoints}. Kehadiran tercatat: ${attCount} hari. Hari aktif (streak): ${streak} hari. Materi selesai: ${materiDone}/4 pertemuan. Lencana: ${badges}.`,
    ``,
    `Laporan ini dibuat otomatis oleh aplikasi BINA berdasarkan data belajar siswa.`,
  ].join('\n');
  const info = db.prepare(
    'INSERT INTO parent_reports (class_id, student_id, teacher_id, content, created_at) VALUES (?,?,?,?,?)',
  ).run(classId, studentId, req.user.id, content, isoNow());
  return res.status(201).json({
    report: {
      id: info.lastInsertRowid,
      classId,
      studentId,
      teacherId: req.user.id,
      content,
      className: cls.name,
      createdAt: isoNow(),
    },
  });
});

// 15.10 — GET /api/my/parent-reports
router.get('/my/parent-reports', authRequired, (req, res) => {
  let rows;
  if (req.user.role === 'guru') {
    rows = db.prepare('SELECT * FROM parent_reports WHERE teacher_id = ? ORDER BY id DESC').all(req.user.id);
  } else {
    rows = db.prepare('SELECT * FROM parent_reports WHERE student_id = ? ORDER BY id DESC').all(req.user.id);
  }
  return res.json({
    reports: rows.map((r) => {
      const cls = db.prepare('SELECT name FROM classes WHERE id = ?').get(r.class_id);
      return {
        id: r.id,
        classId: r.class_id,
        studentId: r.student_id,
        teacherId: r.teacher_id,
        content: r.content,
        className: cls ? cls.name : null,
        createdAt: r.created_at || null,
      };
    }),
  });
});

module.exports = router;
