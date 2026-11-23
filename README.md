# BINA Backend — Rebuild dari Nol

Backend (REST API + SQLite) untuk aplikasi **BINA — Satu Aplikasi Belajar
Merakit PC** (Flutter, peran siswa / guru / admin).

Dibangun ulang dari nol pada 2026-11-23 karena server lama di Render
(`bina-api-0aax.onrender.com`) mati total: semua endpoint menjawab 404,
bahkan `/` dan `/api/health`. Kode backend lama tidak pernah ditemukan —
kontrak API ini direkonstruksi murni dari kode aplikasi Flutter
(`api-contract-inventory.md`, 100 endpoint).

## Menjalankan lokal

```bash
npm install
JWT_SECRET=<rahasia-acak-panjang> npm start
```

- Server jalan di `http://localhost:3000` (`PORT` dari environment, default 3000).
- `JWT_SECRET` **wajib** dari environment — tidak ada nilai default di kode.
  Tanpa itu server menolak start.
- Database: satu file SQLite di `data/bina.db` (dibuat otomatis; sudah di
  `.gitignore`, jangan di-commit).
- Cek cepat: `curl http://localhost:3000/api/health` → `{"ok":true}`.

> **Catatan build di VM ini:** `better-sqlite3` butuh kompilasi native.
> Di VM ini `node-gyp` gagal mengunduh header Node karena sandbox memblokir
> `fchown` — solusinya: ekstrak header Node manual ke
> `~/.cache/node-gyp/<versi>/` + tulis file `installVersion` (isi `11`),
> lalu `npm install` ulang. **Di Render tidak ada masalah ini** (container
> normal, `npm install` langsung jalan).

## Endpoint yang diimplementasikan (100/100)

Base URL aplikasi: `https://bina-api-0aax.onrender.com` (diatur aplikasi,
bukan backend ini). Semua endpoint berauth memakai header
`Authorization: Bearer <JWT>`, kecuali yang ditandai "tanpa auth".
Semua error berbentuk `{ "error": "pesan" }`.

| Domain | Endpoint |
|---|---|
| Kesehatan | `GET /api/health` (tanpa auth) → `{"ok":true}` |
| Auth | `POST /api/auth/register`, `POST /api/auth/login`, `POST /api/auth/change-password`, `POST /api/auth/forgot-password`, `POST /api/auth/reset-password` |
| Profil | `GET /api/me`, `PATCH /api/me` |
| Kelas | `GET /api/classes`, `POST /api/classes`, `POST /api/classes/join`, `GET /api/classes/lookup/:code`, `POST /api/classes/:id/reset-code`, `POST /api/classes/:id/join`, `DELETE /api/classes/:id/leave`, `GET /api/classes/:id/members`, `DELETE /api/classes/:id/members/:userId`, `GET /api/classes/discover`, `GET /api/my/dashboard`, `GET /api/my/results` |
| Jadwal | `GET /api/classes/:id/schedules`, `POST /api/classes/:id/schedules`, `PUT /api/schedules/:id`, `DELETE /api/schedules/:id`, `POST /api/schedules/:id/parts`, `PUT /api/schedule-parts/:id`, `DELETE /api/schedule-parts/:id`, `GET /api/guru/agenda-today` |
| Bank soal | `GET /api/question-banks?set=pretest\|gate\|posttest`, `POST /api/question-banks/:set/questions`, `PUT /api/question-banks/:set/questions`, `PUT /api/question-banks/:set/questions/:id`, `DELETE /api/question-banks/:set/questions`, `DELETE /api/question-banks/:set/questions/:id` |
| Poin | `POST /api/points/sync`, `GET /api/my/points`, `GET /api/classes/:id/points-leaderboard` |
| Lencana | `POST /api/badges/sync`, `GET /api/my/badges`, `GET /api/classes/:id/badges` |
| Streak | `POST /api/streak/sync`, `GET /api/my/streak`, `GET /api/classes/:id/streaks` |
| Progres | `POST /api/progress/sync`, `GET /api/my/progress`, `GET /api/classes/:id/progress` |
| Sertifikat | `POST /api/certificates`, `GET /api/certificates/:code`, `GET /api/classes/:id/certificates` |
| Absensi | `POST /api/attendance/check-in`, `GET /api/attendance/class/:id?date=` |
| Tugas/Kuis | `GET /api/classes/:id/tasks`, `POST /api/classes/:id/tasks`, `POST /api/tasks/:id/submit`, `GET /api/tasks/:id/results`, `PUT /api/submissions/:id/grade`, `POST /api/scores/sync`, `GET /api/classes/:id/leaderboard`, `GET /api/guru/ungraded`, `GET /api/classes/:id/monitoring` |
| Kelas Live | `GET /api/guru/briefing`, `POST /api/classes/:id/sessions`, `GET /api/classes/:id/sessions/active`, `POST /api/sessions/:id/end`, `POST /api/sessions/:id/join`, `PUT /api/sessions/:id/material`, `GET /api/sessions/:id/state`, `POST /api/sessions/:id/quizzes`, `POST /api/quizzes/:id/control`, `POST /api/quizzes/:id/answer`, `PUT /api/sessions/:id/understanding`, `POST /api/sessions/:id/groups`, `GET /api/sessions/:id/groups`, `GET /api/groups/:id/messages`, `POST /api/groups/:id/messages` |
| Chat | `GET /api/chat/conversations`, `POST /api/chat/conversations`, `GET /api/chat/conversations/:id/messages`, `POST /api/chat/conversations/:id/messages`, `POST /api/chat/conversations/:id/read`, `GET /api/chat/unread` |
| Materi/Pengumuman/Laporan | `GET /api/classes/:id/materials`, `POST /api/classes/:id/materials`, `DELETE /api/materials/:id`, `POST /api/materials/:id/download-token`, `POST /api/submissions/:id/download-token`, `GET /api/files/:token`, `GET /api/classes/:id/announcements`, `POST /api/classes/:id/announcements`, `DELETE /api/announcements/:id`, `POST /api/classes/:id/students/:studentId/parent-report`, `GET /api/my/parent-reports` |
| Admin | `GET /api/admin/summary`, `GET /api/admin/users`, `POST /api/admin/users`, `PATCH /api/admin/users/:id/role`, `PATCH /api/admin/users/:id`, `DELETE /api/admin/users/:id`, `GET /api/admin/classes`, `DELETE /api/admin/classes/:id` |

Detail tiap endpoint (body, envelope, perilaku bila field hilang) ada di
`api-contract-inventory.md` (di luar proyek ini).

## Keputusan atas ambiguitas kontrak (A1–A15)

- **A1 — Rebuild dari nol.** Tidak ada route lama yang hidup (semua probe 404,
  bahkan `GET /`). Semua endpoint ditulis baru.
- **A2 — Envelope.** Objek tunggal dibungkus sesuai tabel kontrak
  (`{class}`, `{task}`, `{schedule}`, `{part}`, `{session}`, `{material}`,
  `{announcement}`, `{conversation}`, `{message}`, `{report}`, `{user}`).
  Pengecualian sesuai kontrak: `/api/me` (toleran), dashboard, briefing,
  dan session state (objek langsung).
- **A3 — Kunci list.** Satu kunci per endpoint (yang pertama disebut di
  kontrak): `entries` (leaderboard poin), `badges`, `streaks`, `progress`,
  `certificates`, `leaderboard`.
- **A4 — Submit tugas.** Cabang dari bentuk body: ada `answers` = kuis
  (jawab `{autoScore}`), tanpa `answers` = tugas bebas.
- **A5 — `entries` di `GET /api/my/points`.** Berisi objek entri poin
  `{key, points, label, category, earnedAt}`.
- **A6 — Ack sinkronisasi.** Semua POST sync menjawab `{synced, ignored}`
  (dan `badges`/`days` bila relevan) agar aplikasi bisa memverifikasi —
  bukan `{}` kosong.
- **A7 — Bank soal.** Bentuk kanonis GET: `{version, questions: {id: [...],
  en: [...]}}`. `version` int, mulai 1, naik +1 tiap perubahan CRUD.
  CRUD per bahasa dikirim 2× (id lalu en) — masing-masing menaikkan version.
  PUT/DELETE tanpa id memakai `index` (position). `imageAsset` hanya
  diteruskan apa adanya; aplikasi yang memvalidasi daftar putih 47 aset.
- **A8 — `PUT /schedule-parts`.** `'meetLink': null` eksplisit = hapus
  tautan; field tidak ada = jangan ubah.
- **A9 — Zona waktu.** Streak menyimpan `day` apa adanya (`YYYY-MM-DD`).
  Poin mingguan: `earned_at >= Senin 00:00 Asia/Jakarta` (UTC+7 tetap).
- **A10 — Sertifikat.** Upsert per `code` unik. Verifikasi
  `GET /api/certificates/:code` (404 = tidak terverifikasi).
- **A11 — Rumus XP** (tidak ada di kontrak — ditetapkan di sini):
  `xp = total poin + 10×jumlah check-in absensi + 5×jawaban live benar +
  20×jumlah lencana`. Skor tes tersinkron **tidak** masuk XP.
- **A12 — `SessionState.myAttendance`.** Selalu objek
  `{joined, present, joinedAt}` — bukan boolean.
- **A13 — Download-token.** `url` selalu path relatif
  (`/api/files/<token>`, berlaku 15 menit); aplikasi menambahkan base URL.
- **A14 — 401 vs 404.** Route berauth tanpa token menjawab **401**
  `{error:"Token tidak ada"}`, bukan 404.
- **A15 — `POST /api/badges/sync`.** Semua POST sync hanya menjalankan
  statement SQLite sinkron — menjawab cepat, tidak pernah menggantung.

Keputusan tambahan (di luar A1–A15):
- **Boss HP kuis live:** jawaban benar pertama per soal mengurangi HP boss
  sebesar `ceil(bossMaxHp / jumlah soal)`; jawaban ulang tidak mengurangi
  lagi. (Rumus tidak ada di kontrak.)
- **Hasil tugas bebas:** `GET /api/tasks/:id/results` mengirim `answers`
  sebagai Map `{text, link}` — karena parser aplikasi
  (`TaskResultRow.fromJson`) hanya membaca teks/tautan dari `answers` bila
  berbentuk Map; field terpisah `answerText`/`answerLink`/`fileName` tetap
  dikirim juga.
- **Laporan orang tua:** isi laporan dibuat otomatis dari data siswa
  (nilai, poin, kehadiran, streak, materi, lencana).
- **Peran guru di kelas:** guru pembuat kelas bukan `class_members`;
  leaderboard/progres kelas hanya mencantumkan siswa anggota.

## Deploy ke Render (langkah demi langkah)

Lakukan satu langkah, tunggu sampai selesai, baru lanjut ke langkah
berikutnya.

**Langkah 1 — Siapkan kode di GitHub.**
Buka github.com, login, klik **New repository**, beri nama mis. `bina-backend`,
pilih **Public**, klik **Create repository**. Di laptop, buka terminal di
folder proyek ini lalu jalankan (ganti `NAMAMU` dengan nama GitHub kamu):

```bash
git init
git add .
git commit -m "BINA backend rebuild"
git branch -M main
git remote add origin https://github.com/NAMAMU/bina-backend.git
git push -u origin main
```

**Langkah 2 — Buat Web Service di Render.**
Buka dashboard.render.com, login, klik **New +** → **Web Service** →
pilih repository `bina-backend` → **Connect**.

**Langkah 3 — Isi pengaturan.**
- **Name:** `bina-api` (atau nama lain; URL akhirnya
  `https://<name>.onrender.com`).
- **Region:** Singapore.
- **Branch:** `main`.
- **Runtime:** `Node`.
- **Build Command:** `npm install`.
- **Start Command:** `npm start`.
- **Instance Type:** **Free**.

**Langkah 4 — Tambah JWT_SECRET.**
Di halaman service, buka tab **Environment** → **Add Environment Variable**:
- **Key:** `JWT_SECRET`
- **Value:** tempel satu string acak panjang (mis. hasil dari
  `openssl rand -hex 32` di terminal; atau deretan huruf-angka acak
  minimal 32 karakter). **Jangan pakai kata sandi yang sama dengan akun
  apa pun, dan jangan bagikan ke siapa pun.**

**Langkah 5 — Deploy dan tunggu.**
Klik **Create Web Service**. Tunggu sampai log menampilkan
`BINA backend jalan di port ...` dan status menjadi **Live**.
Deploy pertama di free tier bisa memakan waktu beberapa menit.

**Langkah 6 — Verifikasi.**
Buka di browser: `https://<name>.onrender.com/api/health` — harus tampil
`{"ok":true}`. Bila tampil itu, server hidup.

**Langkah 7 — Arahkan aplikasi ke server baru.**
Di kode aplikasi Flutter, `lib/config/server_config.dart` berisi base URL
lama (`https://bina-api-0aax.onrender.com`). Ganti dengan URL baru dari
langkah 6, lalu build ulang APK.

**Langkah 8 — Buat akun admin pertama.**
Di aplikasi (atau via `curl`), register dengan `role: "admin"` satu kali.
Setelah itu, buat akun guru/siswa lewat pendaftaran biasa atau lewat
panel admin.

## Batasan yang jujur

- **SQLite di disk Render free tier itu ephemeral.** Data (akun, kelas,
  nilai) bisa hilang saat Render me-restart / redeploy service. Untuk
  pemakaian nyata perlu Postgres (di luar lingkup rebuild ini). Sebelum
  demo penting, cadangkan `data/bina.db` dengan mengunduhnya bila
  memungkinkan, atau isi ulang data demo sesaat sebelum demo.
- **Tidak ada rate limit** (pembatasan jumlah request) — jangan
  mempublikasikan URL API ke publik.
- **Pendaftaran admin terbuka.** `POST /api/auth/register` menerima
  `role: "admin"` sesuai kontrak — siapa pun yang tahu URL bisa membuat
  akun admin. Setelah akun admin pertama dibuat, matikan celah ini dengan
  membatasi peran yang boleh didaftar (perubahan kecil di
  `src/routes/auth.js`) atau jaga URL API tetap privat.
- **Tidak ada pengiriman email.** `forgot-password` hanya menyimpan kode
  reset 6 digit (berlaku 15 menit) di database; tidak ada email yang
  terkirim. Kode harus dibacakan dari database oleh admin, atau
  diintegrasikan dengan layanan email.
- **Tidak ada refresh token / logout server.** Logout sepenuhnya lokal
  di aplikasi (sesuai kontrak).
- **Tidak ada unggah foto profil** (sesuai kontrak — foto tetap lokal di
  aplikasi), tidak ada sinkronisasi riwayat jawaban per soal (hanya total
  nilai), dan set latihan `latihan1`–`latihan4` belum punya endpoint bank
  soal (sesuai Lampiran B kontrak).
- **Kunci JWT** (`JWT_SECRET`) hanya dari environment — jangan pernah
  menulisnya di kode atau membagikannya di chat.

## Verifikasi

Probe lokal 2026-11-23 (server port 3101, DB sementara): **134/134 cek
lolos** — mencakup auth, kelas, jadwal, bank soal, tugas/kuis, semua
sinkronisasi, sertifikat, absensi, kelas live, chat, materi, pengumuman,
laporan orang tua, admin, dan penanganan error (401/403/404). Tabel
lengkap: `probe-results.md` (di luar proyek ini).
