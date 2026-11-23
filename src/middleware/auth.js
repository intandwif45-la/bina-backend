'use strict';
// Auth JWT untuk semua route berauth.
// - Token: header `Authorization: Bearer <JWT>`, payload { userId, role }.
// - Tanpa token / token tidak valid -> 401 { error } (kontrak A1/A14:
//   route berauth yang ada HARUS menjawab 401, bukan 404, bila dipanggil
//   tanpa token — ini yang membedakan "route tidak ada" dari "butuh login").
// - Peran salah -> 403 { error }.
// - req.user = { id, name, email, role, avatarId, bannerId } (dari DB).
const jwt = require('jsonwebtoken');
const db = require('../db');

function getSecret() {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error('JWT_SECRET belum disetel di environment');
  return s;
}

function signToken(user) {
  return jwt.sign(
    { userId: user.id, role: user.role },
    getSecret(),
    { expiresIn: '30d' },
  );
}

function authRequired(req, res, next) {
  const h = req.headers.authorization || '';
  const m = /^Bearer\s+(.+)$/.exec(h);
  if (!m) return res.status(401).json({ error: 'Token tidak ada' });
  let payload;
  try {
    payload = jwt.verify(m[1], getSecret());
  } catch (_) {
    return res.status(401).json({ error: 'Token tidak valid' });
  }
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(payload.userId);
  if (!row) return res.status(401).json({ error: 'Token tidak valid' });
  req.user = {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    avatarId: row.avatar_id || null,
    bannerId: row.banner_id || null,
  };
  return next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Token tidak ada' });
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Akses ditolak: peran tidak sesuai' });
    }
    return next();
  };
}

module.exports = { signToken, authRequired, requireRole, getSecret };
