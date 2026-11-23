'use strict';
// Router sinkronisasi BINA — domain: Poin, Lencana, Streak, Progres,
// Sertifikat, Absensi (kontrak api-contract-inventory.md §6–§11).
// Mount di /api (lihat src/server.js). Semua route authRequired.
// Semua operasi memakai better-sqlite3 sinkron (cepat, tanpa I/O lambat)
// agar POST sync selalu menjawab cepat dan lengkap (kontrak A6/A15:
// POST /api/badges/sync pernah timeout 90 detik di server lama).
const express = require('express');
const db = require('../db');
const { authRequired } = require('../middleware/auth');
const { isoNow, weekStartJakartaISO, err, safeJsonParse, toInt } = require('../utils');

const router = express.Router();
router.use(authRequired);

// ---------------------------------------------------------------------------
// Bantuan bersama
// ---------------------------------------------------------------------------

// Kelas harus ada; bila tidak -> 404. Kembalikan baris classes atau null
// (dan respons sudah dikirim).
function loadClass(req, res) {
  const id = toInt(req.params.id, 0);
  const cls = db.prepare('SELECT * FROM classes WHERE id = ?').get(id);
  if (!cls) {
    err(res, 404, 'Kelas tidak ditemukan');
    return null;
  }
  return cls;
}

// Akses baca data kelas: anggota kelas, guru pemilik kelas, atau admin.
function canViewClass(req, cls) {
  if (req.user.role === 'admin') return true;
  if (cls.teacher_id === req.user.id) return true;
  const m = db.prepare(
    'SELECT 1 FROM class_members WHERE class_id = ? AND user_id = ?',
  ).get(cls.id, req.user.id);
  return !!m;
}

// Akses guru atas kelas: hanya guru pemilik kelas atau admin.
function canManageClass(req, cls) {
  if (req.user.role === 'admin') return true;
  return cls.teacher_id === req.user.id;
}

function requireClassView(req, res) {
  const cls = loadClass(req, res);
  if (!cls) return null;
  if (!canViewClass(req, cls)) {
    err(res, 403, 'Akses ditolak: bukan anggota kelas ini');
    return null;
  }
  return cls;
}

// Anggota kelas (siswa yang bergabung) beserta nama — dipakai semua
// endpoint per-kelas. Guru pemilik TIDAK dimasukkan (bukan class_members;
// poin/lencana/streak/progres/sertifikat guru tidak dilacak aplikasi).
function classMembers(classId) {
  return db.prepare(
    'SELECT u.id AS userId, u.name AS name, u.email AS email, u.role AS role '
    + 'FROM class_members cm JOIN users u ON u.id = cm.user_id '
    + 'WHERE cm.class_id = ? ORDER BY u.name ASC',
  ).all(classId);
}

// ---------------------------------------------------------------------------
// Poin (§6)
// ---------------------------------------------------------------------------

function pointTotals(userId) {
  const total = db.prepare(
    'SELECT COALESCE(SUM(points), 0) AS total FROM point_entries WHERE user_id = ?',
  ).get(userId);
  const weekly = db.prepare(
    'SELECT COALESCE(SUM(points), 0) AS total FROM point_entries '
    + 'WHERE user_id = ? AND earned_at >= ?',
  ).get(userId, weekStartJakartaISO());
  return { totalPoints: total.total, weeklyPoints: weekly.total };
}

const insertPoint = db.prepare(
  'INSERT OR IGNORE INTO point_entries '
  + '(user_id, entry_key, points, label, category, earned_at) '
  + 'VALUES (?, ?, ?, ?, ?, ?)',
);

// POST /api/points/sync — INSERT OR IGNORE per entri (UNIQUE user_id+entry_key).
// synced = yang benar-benar masuk, ignored = duplikat yang sudah ada.
router.post('/points/sync', (req, res) => {
  const entries = req.body && req.body.entries;
  if (!Array.isArray(entries)) {
    return err(res, 400, 'Field entries harus berupa array');
  }
  for (const e of entries) {
    if (!e || typeof e.key !== 'string' || e.key.length === 0) {
      return err(res, 400, 'Setiap entri poin wajib memiliki key');
    }
  }
  let synced = 0;
  let ignored = 0;
  for (const e of entries) {
    const info = insertPoint.run(
      req.user.id,
      e.key,
      toInt(e.points, 0),
      typeof e.label === 'string' ? e.label : '',
      typeof e.category === 'string' ? e.category : '',
      typeof e.earnedAt === 'string' && e.earnedAt.length > 0 ? e.earnedAt : isoNow(),
    );
    if (info.changes === 1) synced += 1;
    else ignored += 1;
  }
  const totals = pointTotals(req.user.id);
  return res.json({
    synced,
    ignored,
    totalPoints: totals.totalPoints,
    weeklyPoints: totals.weeklyPoints,
  });
});

// GET /api/my/points — totalPoints + weeklyPoints selalu ada (non-null).
// entries dikirim apa adanya (A5: aplikasi tidak membacanya).
router.get('/my/points', (req, res) => {
  const rows = db.prepare(
    'SELECT entry_key AS key, points, label, category, earned_at AS earnedAt '
    + 'FROM point_entries WHERE user_id = ? ORDER BY earned_at ASC, id ASC',
  ).all(req.user.id);
  const totals = pointTotals(req.user.id);
  return res.json({
    totalPoints: totals.totalPoints,
    weeklyPoints: totals.weeklyPoints,
    entries: rows.map((r) => ({
      key: r.key,
      points: r.points,
      label: r.label,
      category: r.category,
      earnedAt: r.earnedAt,
    })),
  });
});

// GET /api/classes/:id/points-leaderboard — kunci `entries` (keputusan A3).
router.get('/classes/:id/points-leaderboard', (req, res) => {
  const cls = requireClassView(req, res);
  if (!cls) return undefined;
  const entries = classMembers(cls.id).map((m) => {
    const t = pointTotals(m.userId);
    return {
      userId: m.userId,
      name: m.name,
      totalPoints: t.totalPoints,
      weeklyPoints: t.weeklyPoints,
    };
  });
  entries.sort((a, b) => b.totalPoints - a.totalPoints);
  return res.json({ entries });
});

// ---------------------------------------------------------------------------
// Lencana (§7)
// ---------------------------------------------------------------------------

const insertBadge = db.prepare(
  'INSERT OR IGNORE INTO user_badges (user_id, badge_id, unlocked_at) VALUES (?, ?, ?)',
);

// POST /api/badges/sync — INSERT OR IGNORE (UNIQUE user_id+badge_id).
// badges = list string id lencana yang berhasil disinkronkan.
router.post('/badges/sync', (req, res) => {
  const badges = req.body && req.body.badges;
  if (!Array.isArray(badges)) {
    return err(res, 400, 'Field badges harus berupa array');
  }
  for (const b of badges) {
    if (!b || typeof b.badgeId !== 'string' || b.badgeId.length === 0) {
      return err(res, 400, 'Setiap lencana wajib memiliki badgeId');
    }
  }
  let synced = 0;
  let ignored = 0;
  const syncedIds = [];
  for (const b of badges) {
    const info = insertBadge.run(
      req.user.id,
      b.badgeId,
      typeof b.unlockedAt === 'string' && b.unlockedAt.length > 0 ? b.unlockedAt : isoNow(),
    );
    if (info.changes === 1) {
      synced += 1;
      syncedIds.push(b.badgeId);
    } else {
      ignored += 1;
    }
  }
  return res.json({ synced, ignored, badges: syncedIds });
});

// GET /api/my/badges — list string badgeId.
router.get('/my/badges', (req, res) => {
  const rows = db.prepare(
    'SELECT badge_id FROM user_badges WHERE user_id = ? ORDER BY unlocked_at ASC, id ASC',
  ).all(req.user.id);
  return res.json({ badges: rows.map((r) => r.badge_id) });
});

// GET /api/classes/:id/badges — kunci `badges` (keputusan A3).
router.get('/classes/:id/badges', (req, res) => {
  const cls = requireClassView(req, res);
  if (!cls) return undefined;
  const badges = classMembers(cls.id).map((m) => {
    const rows = db.prepare(
      'SELECT badge_id FROM user_badges WHERE user_id = ? ORDER BY unlocked_at ASC, id ASC',
    ).all(m.userId);
    return {
      userId: m.userId,
      name: m.name,
      badges: rows.map((r) => r.badge_id),
    };
  });
  return res.json({ badges });
});

// ---------------------------------------------------------------------------
// Streak (§8, A9)
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

// Tanggal "hari ini" dalam kalender Asia/Jakarta (UTC+7), sebagai ms epoch
// tengah malam UTC pada tanggal itu — dipakai sebagai pangkal hitung streak.
function jakartaTodayMidnightMs(now = new Date()) {
  const j = new Date(now.getTime() + 7 * 60 * 60 * 1000);
  return Date.UTC(j.getUTCFullYear(), j.getUTCMonth(), j.getUTCDate());
}

function isoDay(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

// Hari berurutan berakhir hari ini; bila hari ini belum ada, berakhir kemarin.
// day disimpan apa adanya sebagai teks 'YYYY-MM-DD' (A9: tanpa konversi zona).
function currentStreakFor(userId) {
  const rows = db.prepare(
    'SELECT day FROM streak_days WHERE user_id = ?',
  ).all(userId);
  const set = new Set(rows.map((r) => r.day));
  let cursor = jakartaTodayMidnightMs();
  let streak = 0;
  for (let i = 0; i < 3660; i++) {
    if (set.has(isoDay(cursor))) {
      streak += 1;
      cursor -= DAY_MS;
    } else if (streak === 0 && i === 0) {
      // Hari ini belum ada — streak boleh berakhir kemarin.
      cursor -= DAY_MS;
    } else {
      break;
    }
  }
  return streak;
}

const insertStreakDay = db.prepare(
  'INSERT OR IGNORE INTO streak_days (user_id, day) VALUES (?, ?)',
);

// POST /api/streak/sync — INSERT OR IGNORE (UNIQUE user_id+day).
// days = hari yang berhasil disinkronkan (baru masuk).
router.post('/streak/sync', (req, res) => {
  const days = req.body && req.body.days;
  if (!Array.isArray(days)) {
    return err(res, 400, 'Field days harus berupa array');
  }
  for (const d of days) {
    if (typeof d !== 'string' || !DAY_RE.test(d)) {
      return err(res, 400, 'Setiap hari harus berupa string tanggal YYYY-MM-DD');
    }
  }
  let synced = 0;
  let ignored = 0;
  const syncedDays = [];
  for (const d of days) {
    const info = insertStreakDay.run(req.user.id, d);
    if (info.changes === 1) {
      synced += 1;
      syncedDays.push(d);
    } else {
      ignored += 1;
    }
  }
  return res.json({ synced, ignored, days: syncedDays });
});

// GET /api/my/streak
router.get('/my/streak', (req, res) => {
  const rows = db.prepare(
    'SELECT day FROM streak_days WHERE user_id = ? ORDER BY day ASC',
  ).all(req.user.id);
  return res.json({
    currentStreak: currentStreakFor(req.user.id),
    totalActiveDays: rows.length,
    days: rows.map((r) => r.day),
  });
});

// GET /api/classes/:id/streaks — kunci `streaks` (keputusan A3);
// streakDays = currentStreak masing-masing user.
router.get('/classes/:id/streaks', (req, res) => {
  const cls = requireClassView(req, res);
  if (!cls) return undefined;
  const streaks = classMembers(cls.id).map((m) => {
    const rows = db.prepare(
      'SELECT day FROM streak_days WHERE user_id = ? ORDER BY day ASC',
    ).all(m.userId);
    return {
      userId: m.userId,
      streakDays: currentStreakFor(m.userId),
      days: rows.map((r) => r.day),
    };
  });
  return res.json({ streaks });
});

// ---------------------------------------------------------------------------
// Progres (§9)
// ---------------------------------------------------------------------------

function toBoolArray(value) {
  const arr = safeJsonParse(value, []);
  if (!Array.isArray(arr)) return [false, false, false, false];
  const out = [false, false, false, false];
  for (let i = 0; i < 4; i++) out[i] = arr[i] === true || arr[i] === 1;
  return out;
}

function snapshotFromRow(row) {
  return {
    materi: toBoolArray(row.materi),
    flashcardsMastered: safeJsonParse(row.flashcards_mastered, []),
    diagnosisCompleted: safeJsonParse(row.diagnosis_completed, []),
    frontPanelWins: toInt(row.front_panel_wins, 0),
    simulatorCompleted: row.simulator_completed === 1 || row.simulator_completed === true,
    updatedAt: row.updated_at || null,
  };
}

const DEFAULT_PROGRESS = {
  materi: [false, false, false, false],
  flashcardsMastered: [],
  diagnosisCompleted: [],
  frontPanelWins: 0,
  simulatorCompleted: false,
  updatedAt: null,
};

const upsertProgress = db.prepare(
  'INSERT INTO progress_snapshots '
  + '(user_id, materi, flashcards_mastered, diagnosis_completed, front_panel_wins, simulator_completed, updated_at) '
  + 'VALUES (?, ?, ?, ?, ?, ?, ?) '
  + 'ON CONFLICT(user_id) DO UPDATE SET '
  + 'materi = excluded.materi, '
  + 'flashcards_mastered = excluded.flashcards_mastered, '
  + 'diagnosis_completed = excluded.diagnosis_completed, '
  + 'front_panel_wins = excluded.front_panel_wins, '
  + 'simulator_completed = excluded.simulator_completed, '
  + 'updated_at = excluded.updated_at',
);

// POST /api/progress/sync — body = snapshot langsung (tanpa envelope).
// UPSERT satu snapshot per user.
router.post('/progress/sync', (req, res) => {
  const b = req.body || {};
  const materi = Array.isArray(b.materi) ? b.materi : [];
  const materi4 = [false, false, false, false];
  for (let i = 0; i < 4; i++) materi4[i] = materi[i] === true || materi[i] === 1;
  const flashcardsMastered = Array.isArray(b.flashcardsMastered) ? b.flashcardsMastered : [];
  const diagnosisCompleted = Array.isArray(b.diagnosisCompleted) ? b.diagnosisCompleted : [];
  const frontPanelWins = toInt(b.frontPanelWins, 0);
  const simulatorCompleted = b.simulatorCompleted === true || b.simulatorCompleted === 1;
  const updatedAt = typeof b.updatedAt === 'string' && b.updatedAt.length > 0
    ? b.updatedAt
    : isoNow();
  upsertProgress.run(
    req.user.id,
    JSON.stringify(materi4),
    JSON.stringify(flashcardsMastered),
    JSON.stringify(diagnosisCompleted),
    frontPanelWins,
    simulatorCompleted ? 1 : 0,
    updatedAt,
  );
  return res.json({ synced: true, updatedAt });
});

// GET /api/my/progress — tanpa snapshot: progres default (updatedAt null).
router.get('/my/progress', (req, res) => {
  const row = db.prepare(
    'SELECT * FROM progress_snapshots WHERE user_id = ?',
  ).get(req.user.id);
  if (!row) return res.json({ progress: { ...DEFAULT_PROGRESS } });
  return res.json({ progress: snapshotFromRow(row) });
});

// GET /api/classes/:id/progress — kunci `progress` (keputusan A3).
// Anggota tanpa snapshot mendapat nilai default.
router.get('/classes/:id/progress', (req, res) => {
  const cls = requireClassView(req, res);
  if (!cls) return undefined;
  const progress = classMembers(cls.id).map((m) => {
    const row = db.prepare(
      'SELECT * FROM progress_snapshots WHERE user_id = ?',
    ).get(m.userId);
    const snap = row ? snapshotFromRow(row) : { ...DEFAULT_PROGRESS };
    return {
      userId: m.userId,
      name: m.name,
      materi: snap.materi,
      flashcardsMastered: snap.flashcardsMastered,
      diagnosisCompleted: snap.diagnosisCompleted,
      frontPanelWins: snap.frontPanelWins,
      simulatorCompleted: snap.simulatorCompleted,
      updatedAt: snap.updatedAt,
    };
  });
  return res.json({ progress });
});

// ---------------------------------------------------------------------------
// Sertifikat (§10)
// ---------------------------------------------------------------------------

function certificateJson(row) {
  return {
    code: row.code,
    name: row.name,
    score: row.score,
    date: row.date,
  };
}

// POST /api/certificates — semua field wajib; upsert berdasarkan code (UNIQUE).
// Code milik user lain -> 409; milik sendiri -> perbarui.
router.post('/certificates', (req, res) => {
  const b = req.body || {};
  if (typeof b.code !== 'string' || b.code.length === 0
    || typeof b.name !== 'string' || b.name.length === 0
    || b.score === undefined || b.score === null
    || typeof b.date !== 'string' || b.date.length === 0) {
    return err(res, 400, 'Field code, name, score, dan date wajib diisi');
  }
  const existing = db.prepare(
    'SELECT * FROM certificates WHERE code = ?',
  ).get(b.code);
  if (existing && existing.user_id !== req.user.id) {
    return err(res, 409, 'Kode sertifikat sudah dipakai pengguna lain');
  }
  db.prepare(
    'INSERT INTO certificates (code, user_id, name, score, date) VALUES (?, ?, ?, ?, ?) '
    + 'ON CONFLICT(code) DO UPDATE SET name = excluded.name, score = excluded.score, date = excluded.date',
  ).run(b.code, req.user.id, b.name, toInt(b.score, 0), b.date);
  return res.json({
    certificate: {
      code: b.code,
      name: b.name,
      score: toInt(b.score, 0),
      date: b.date,
    },
  });
});

// GET /api/certificates/:code — 404 bila tidak ketemu.
router.get('/certificates/:code', (req, res) => {
  const row = db.prepare(
    'SELECT * FROM certificates WHERE code = ?',
  ).get(req.params.code);
  if (!row) return err(res, 404, 'Sertifikat tidak ditemukan');
  const cert = certificateJson(row);
  cert.userId = row.user_id;
  return res.json({ certificate: cert });
});

// GET /api/classes/:id/certificates — kunci `certificates` (keputusan A3).
router.get('/classes/:id/certificates', (req, res) => {
  const cls = requireClassView(req, res);
  if (!cls) return undefined;
  const members = classMembers(cls.id);
  const memberIds = new Set(members.map((m) => m.userId));
  const nameById = new Map(members.map((m) => [m.userId, m.name]));
  const rows = db.prepare(
    'SELECT * FROM certificates ORDER BY date DESC, id DESC',
  ).all();
  const certificates = rows
    .filter((r) => memberIds.has(r.user_id))
    .map((r) => {
      const cert = certificateJson(r);
      cert.userId = r.user_id;
      cert.userName = nameById.get(r.user_id) || '';
      return cert;
    });
  return res.json({ certificates });
});

// ---------------------------------------------------------------------------
// Absensi (§11)
// ---------------------------------------------------------------------------

// POST /api/attendance/check-in — upsert per (user_id, date);
// kirim ulang memperbarui jam.
router.post('/attendance/check-in', (req, res) => {
  const b = req.body || {};
  if (typeof b.date !== 'string' || !DAY_RE.test(b.date)) {
    return err(res, 400, 'Field date wajib berupa string tanggal YYYY-MM-DD');
  }
  if (typeof b.time !== 'string' || !/^\d{2}:\d{2}$/.test(b.time)) {
    return err(res, 400, 'Field time wajib berupa string jam HH:mm');
  }
  db.prepare(
    'INSERT INTO attendance (user_id, date, time) VALUES (?, ?, ?) '
    + 'ON CONFLICT(user_id, date) DO UPDATE SET time = excluded.time',
  ).run(req.user.id, b.date, b.time);
  return res.json({ date: b.date, time: b.time });
});

// GET /api/attendance/class/:id?date=YYYY-MM-DD — hanya guru pemilik kelas / admin.
// date wajib. students = SEMUA anggota siswa kelas itu.
router.get('/attendance/class/:id', (req, res) => {
  const cls = loadClass(req, res);
  if (!cls) return undefined;
  if (!canManageClass(req, cls)) {
    return err(res, 403, 'Akses ditolak: hanya guru kelas ini');
  }
  const date = req.query.date;
  if (typeof date !== 'string' || !DAY_RE.test(date)) {
    return err(res, 400, 'Query date wajib diisi dengan format YYYY-MM-DD');
  }
  const students = classMembers(cls.id)
    .filter((m) => m.role === 'siswa')
    .map((m) => {
      const att = db.prepare(
        'SELECT time FROM attendance WHERE user_id = ? AND date = ?',
      ).get(m.userId, date);
      const row = {
        userId: m.userId,
        name: m.name,
        email: m.email,
        present: !!att,
      };
      if (att) row.time = att.time;
      return row;
    });
  const presentCount = students.filter((s) => s.present).length;
  return res.json({
    class: { name: cls.name },
    date,
    presentCount,
    totalCount: students.length,
    students,
  });
});

module.exports = router;
