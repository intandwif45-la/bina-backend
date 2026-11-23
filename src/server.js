'use strict';
// Server utama backend BINA (rebuild 2026-11-23).
// JWT_SECRET WAJIB dari environment (tanpa default). PORT dari env, default 3000.
const express = require('express');
const db = require('./db');
const { getSecret } = require('./middleware/auth');
const { isoNow } = require('./utils');

if (!process.env.JWT_SECRET) {
  console.error('FATAL: JWT_SECRET belum disetel. Jalankan mis. JWT_SECRET=<rahasia> npm start');
  process.exit(1);
}
getSecret();

const app = express();
app.use(express.json({ limit: '20mb' }));

// Kesehatan server — tanpa auth, harus jawab {"ok":true} (kontrak §17).
app.get('/api/health', (req, res) => res.json({ ok: true }));

// Unduh berkas via token bertanda tangan (kontrak A13: url relatif).
// Token dibuat POST /api/materials/:id/download-token dan
// POST /api/submissions/:id/download-token, berlaku ±15 menit.
app.get('/api/files/:token', (req, res) => {
  const row = db.prepare('SELECT * FROM download_tokens WHERE token = ?').get(req.params.token);
  if (!row) return res.status(404).json({ error: 'Tautan unduhan tidak ditemukan' });
  if (new Date(row.expires_at).getTime() < Date.now()) {
    return res.status(410).json({ error: 'Tautan unduhan sudah kedaluwarsa' });
  }
  let file = null;
  if (row.kind === 'material') {
    file = db.prepare('SELECT file_name, file_mime, file_base64 FROM materials WHERE id = ?').get(row.ref_id);
  } else {
    file = db.prepare('SELECT file_name, file_mime, file_base64 FROM submissions WHERE id = ?').get(row.ref_id);
  }
  if (!file || !file.file_base64) return res.status(404).json({ error: 'Berkas tidak ditemukan' });
  const buf = Buffer.from(file.file_base64, 'base64');
  res.setHeader('Content-Type', file.file_mime || 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${file.file_name || 'berkas'}"`);
  return res.send(buf);
});

app.use('/api/auth', require('./routes/auth'));
app.use('/api', require('./routes/profile'));
app.use('/api', require('./routes/classes'));
app.use('/api', require('./routes/schedules'));
app.use('/api/question-banks', require('./routes/questionBanks'));
app.use('/api', require('./routes/sync'));
app.use('/api', require('./routes/tasks'));
app.use('/api', require('./routes/live'));
app.use('/api/chat', require('./routes/chat'));
app.use('/api', require('./routes/materials'));
app.use('/api/admin', require('./routes/admin'));

// Route tidak dikenal -> 404 JSON (bukan HTML Express), agar aplikasi
// menerima { error } yang bisa dibaca (kontrak §0).
app.use((req, res) => res.status(404).json({ error: 'Not Found' }));

// eslint-disable-next-line no-unused-vars
app.use((e, req, res, next) => {
  console.error(e && e.stack ? e.stack : e);
  return res.status(500).json({ error: 'Terjadi kesalahan server' });
});

const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
  console.log(`BINA backend jalan di port ${port} — ${isoNow()}`);
});
