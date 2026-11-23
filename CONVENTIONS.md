# Konvensi Router — WAJIB dibaca sebelum menulis router

Kerangka sudah jadi: `src/db.js`, `src/schema.sql`, `src/middleware/auth.js`,
`src/utils.js`, `src/server.js`. JANGAN ubah file-file itu. Kamu hanya menulis
file router di `src/routes/` yang ditugaskan.

## Impor yang tersedia
- `const db = require('../db');` — instansi better-sqlite3 (sinkron).
  Pakai prepared statement: `db.prepare('SELECT ... WHERE id = ?').get(id)`,
  `.all(...)`, `.run(...)`. Hasil `.run()` membawa `lastInsertRowid`, `changes`.
- `const { authRequired, requireRole } = require('../middleware/auth');`
  Pasang `authRequired` di SEMUA route berauth. `req.user` =
  `{ id, name, email, role, avatarId, bannerId }`.
  Peran: `requireRole('guru')`, `requireRole('admin')` — dipasang SETELAH
  `authRequired`. Peran salah -> 403 `{ error }` (middleware yang menjawab).
- `const { isoNow, weekStartJakartaISO, err, safeJsonParse, toInt, genClassCode, genToken } = require('../utils');`
  `err(res, 400, 'pesan')` untuk semua respons error.

## Aturan respons (kontrak §0 — aplikasi crash bila dilanggar)
- SEMUA respons error: `{ error: 'pesan string' }`, status HTTP yang tepat
  (400 validasi, 401 tanpa token — middleware, 403 peran salah, 404 data
  tidak ada, 409 konflik seperti email sudah terdaftar / kode sudah dipakai).
- Envelope objek tunggal WAJIB persis seperti tabel kontrak
  (`{ class }`, `{ task }`, `{ schedule }`, `{ part }`, `{ session }`,
  `{ material }`, `{ announcement }`, `{ conversation }`, `{ message }`,
  `{ report }`, `{ user }`). Jangan menyeragamkan.
- List: kunci list sesuai tabel; hilang -> `[]` (jangan 404).
- Field tanggal: ISO-8601 UTC (`isoNow()`). Pengecualian: `schedules.date`,
  `attendance.date`, `streak_days.day` = `'YYYY-MM-DD'` apa adanya.
- Body JSON: baca `req.body` apa adanya. `PUT /api/schedule-parts/:id`:
  bedakan `'meetLink' in req.body` (null eksplisit = hapus tautan) dari
  field tidak ada (jangan ubah) — kontrak A8.
- DELETE tidak pernah membawa body (kecuali DELETE bank soal yang membawa
  JSON — lihat domain Bank Soal).

## Skema (src/schema.sql — JANGAN ubah)
Tabel + kolom sudah tetap. Jangan membuat tabel baru tanpa izin koordinator.
Nama kolom snake_case di DB; serialisasi ke aplikasi memakai camelCase
(`teacher_id` -> `teacherId`, `avatar_id` -> `avatarId`, dst).
JSON (options soal, questions tugas, materi snapshot) disimpan sebagai
TEXT berisi JSON string; pakai `JSON.stringify` saat tulis,
`safeJsonParse(..., [])` saat baca.

## Verifikasi file kamu
- `node --check src/routes/<namafile>.js` harus lolos.
- Uji mandiri bila sempat: buat app Express mini yang hanya me-mount
  routermu + `JWT_SECRET=dev-test node` — jangan menjalankan `src/server.js`
  penuh sebelum semua router ada (akan gagal require).
