'use strict';
// Router Bank Soal — kontrak §5 api-contract-inventory.md.
// Mount: app.use('/api/question-banks', require('./routes/questionBanks')).
// Semua route authRequired. QuestionBankService TIDAK punya penanganan 401
// terpusat, tapi tetap mengirim Bearer — middleware auth tetap berlaku.
//
// Bentuk kanonis GET: BENTUK A (keputusan A7):
//   { version: int, questions: { id: [...], en: [...] } }
// Tiap item: { question, options, correctIndex, explanation,
//   componentId?, imageAsset?, imageCaption?, id (server id int) }.
//
// Keputusan atas ambiguitas (didokumentasikan):
// - version default 1 bila belum ada baris di question_bank_meta. Bump
//   pertama membuat baris dengan version 2 (1 implisit + 1), supaya klien
//   yang sudah meng-cache version 1 benar-benar mengunduh ulang.
// - CRUD dikirim aplikasi dua kali (id lalu en) sebagai request terpisah,
//   jadi tiap request menaikkan version set itu +1 (dua kali per soal
//   logis). Itu sesuai spesifikasi tugas ("+1 setiap ada perubahan CRUD").
// - `set` di path adalah otoritatif; bila body.set ada dan berbeda -> 400.
// - `lang` hilang -> default 'id'; nilai selain 'id'/'en' -> 400.
// - POST/PUT: options wajib array tepat 4 string; correctIndex wajib int
//   dalam 0..3. Field opsional yang tidak dikirim pada PUT dipertahankan.
const express = require('express');
const db = require('../db');
const { authRequired, requireRole } = require('../middleware/auth');
const { err, safeJsonParse, toInt } = require('../utils');

const router = express.Router();
router.use(authRequired);

const SETS = ['pretest', 'gate', 'posttest'];
const LANGS = ['id', 'en'];

function validSet(set) {
  return SETS.includes(set);
}

function getVersion(set) {
  const row = db.prepare('SELECT version FROM question_bank_meta WHERE set_name = ?').get(set);
  return row ? row.version : 1;
}

// Naikkan version set itu +1. Bila belum ada baris, baris dibuat dengan
// version = 2 (lihat catatan di atas: 1 implisit + 1).
function bumpVersion(set) {
  const row = db.prepare('SELECT version FROM question_bank_meta WHERE set_name = ?').get(set);
  if (row) {
    db.prepare('UPDATE question_bank_meta SET version = version + 1 WHERE set_name = ?').run(set);
  } else {
    db.prepare('INSERT INTO question_bank_meta (set_name, version) VALUES (?, 2)').run(set);
  }
}

function serializeItem(row) {
  const item = {
    id: row.id,
    question: row.question,
    options: safeJsonParse(row.options, []),
    correctIndex: row.correct_index,
    explanation: row.explanation || '',
  };
  if (row.component_id) item.componentId = row.component_id;
  if (row.image_asset) item.imageAsset = row.image_asset;
  if (row.image_caption) item.imageCaption = row.image_caption;
  return item;
}

// Validasi body soal (POST/PUT). Mengembalikan { ok, lang, data } atau
// mengirim error 400 dan mengembalikan { ok: false }.
function validateItemBody(req, res, set) {
  const body = req.body || {};
  if (body.set !== undefined && body.set !== null && body.set !== set) {
    err(res, 400, 'Field set pada body tidak cocok dengan path');
    return { ok: false };
  }
  const lang = body.lang === undefined || body.lang === null ? 'id' : body.lang;
  if (!LANGS.includes(lang)) {
    err(res, 400, "lang harus 'id' atau 'en'");
    return { ok: false };
  }
  if (typeof body.question !== 'string' || body.question.trim() === '') {
    err(res, 400, 'question wajib diisi');
    return { ok: false };
  }
  if (!Array.isArray(body.options) || body.options.length !== 4
    || body.options.some((o) => typeof o !== 'string')) {
    err(res, 400, 'options wajib array berisi 4 string');
    return { ok: false };
  }
  const correctIndex = toInt(body.correctIndex, -1);
  if (correctIndex < 0 || correctIndex > 3) {
    err(res, 400, 'correctIndex wajib int 0..3');
    return { ok: false };
  }
  return {
    ok: true,
    lang,
    data: {
      question: body.question,
      options: body.options,
      correctIndex,
      explanation: typeof body.explanation === 'string' ? body.explanation : '',
      componentId: body.componentId !== undefined && body.componentId !== null
        ? String(body.componentId) : null,
      imageAsset: body.imageAsset !== undefined && body.imageAsset !== null
        ? String(body.imageAsset) : null,
      imageCaption: body.imageCaption !== undefined && body.imageCaption !== null
        ? String(body.imageCaption) : null,
    },
  };
}

// Rapatkan position 0..n-1 berurutan untuk satu (set, lang).
function repackPositions(set, lang) {
  const rows = db.prepare(
    'SELECT id FROM question_bank_items WHERE set_name = ? AND lang = ? ORDER BY position ASC, id ASC',
  ).all(set, lang);
  const upd = db.prepare('UPDATE question_bank_items SET position = ? WHERE id = ?');
  rows.forEach((r, i) => upd.run(i, r.id));
}

const repackTx = db.transaction((set, lang) => repackPositions(set, lang));

// GET /api/question-banks?set={pretest|gate|posttest} — BENTUK A kanonis.
router.get('/', (req, res) => {
  const set = req.query.set;
  if (!validSet(set)) {
    return err(res, 400, 'set tidak dikenal (pretest, gate, posttest)');
  }
  const questions = { id: [], en: [] };
  for (const lang of LANGS) {
    const rows = db.prepare(
      'SELECT * FROM question_bank_items WHERE set_name = ? AND lang = ? ORDER BY position ASC, id ASC',
    ).all(set, lang);
    questions[lang] = rows.map(serializeItem);
  }
  return res.json({ version: getVersion(set), questions });
});

// POST /api/question-banks/:set/questions (guru/admin) — soal baru di
// position = max+1 untuk (set, lang).
router.post('/:set/questions', requireRole('guru', 'admin'), (req, res) => {
  const set = req.params.set;
  if (!validSet(set)) return err(res, 400, 'set tidak dikenal (pretest, gate, posttest)');
  const v = validateItemBody(req, res, set);
  if (!v.ok) return undefined;
  const row = db.prepare(
    'SELECT COALESCE(MAX(position), -1) AS m FROM question_bank_items WHERE set_name = ? AND lang = ?',
  ).get(set, v.lang);
  const position = row.m + 1;
  const info = db.prepare(
    `INSERT INTO question_bank_items
       (set_name, lang, position, question, options, correct_index, explanation,
        component_id, image_asset, image_caption)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(set, v.lang, position, v.data.question, JSON.stringify(v.data.options),
    v.data.correctIndex, v.data.explanation, v.data.componentId,
    v.data.imageAsset, v.data.imageCaption);
  bumpVersion(set);
  return res.status(201).json({ ok: true, id: info.lastInsertRowid });
});

// PUT /api/question-banks/:set/questions (guru/admin) — alamat via body:
// bila id ada -> update item ber-id itu; bila tidak ada -> update item
// (set, lang) di position = index.
router.put('/:set/questions', requireRole('guru', 'admin'), (req, res) => {
  const set = req.params.set;
  if (!validSet(set)) return err(res, 400, 'set tidak dikenal (pretest, gate, posttest)');
  const v = validateItemBody(req, res, set);
  if (!v.ok) return undefined;
  const body = req.body || {};
  let row = null;
  if (body.id !== undefined && body.id !== null && body.id !== '') {
    row = db.prepare('SELECT * FROM question_bank_items WHERE id = ?').get(toInt(body.id, -1));
    if (row && row.set_name !== set) row = null;
  }
  if (!row) {
    if (body.index === undefined || body.index === null) {
      return err(res, 400, 'index wajib diisi bila id tidak ada');
    }
    row = db.prepare(
      'SELECT * FROM question_bank_items WHERE set_name = ? AND lang = ? AND position = ?',
    ).get(set, v.lang, toInt(body.index, -1));
  }
  if (!row) return err(res, 404, 'Soal tidak ditemukan');
  db.prepare(
    `UPDATE question_bank_items SET question = ?, options = ?, correct_index = ?,
       explanation = ?, component_id = ?, image_asset = ?, image_caption = ?
     WHERE id = ?`,
  ).run(v.data.question, JSON.stringify(v.data.options), v.data.correctIndex,
    v.data.explanation, v.data.componentId, v.data.imageAsset,
    v.data.imageCaption, row.id);
  bumpVersion(set);
  return res.json({ ok: true, id: row.id });
});

// PUT /api/question-banks/:set/questions/:id (guru/admin) — alamat via :id.
router.put('/:set/questions/:id', requireRole('guru', 'admin'), (req, res) => {
  const set = req.params.set;
  if (!validSet(set)) return err(res, 400, 'set tidak dikenal (pretest, gate, posttest)');
  const v = validateItemBody(req, res, set);
  if (!v.ok) return undefined;
  const row = db.prepare('SELECT * FROM question_bank_items WHERE id = ?')
    .get(toInt(req.params.id, -1));
  if (!row || row.set_name !== set) return err(res, 404, 'Soal tidak ditemukan');
  db.prepare(
    `UPDATE question_bank_items SET question = ?, options = ?, correct_index = ?,
       explanation = ?, component_id = ?, image_asset = ?, image_caption = ?
     WHERE id = ?`,
  ).run(v.data.question, JSON.stringify(v.data.options), v.data.correctIndex,
    v.data.explanation, v.data.componentId, v.data.imageAsset,
    v.data.imageCaption, row.id);
  bumpVersion(set);
  return res.json({ ok: true, id: row.id });
});

// DELETE /api/question-banks/:set/questions (guru/admin) — body JSON
// {set, lang, index} (pengecualian kontrak §0: DELETE ini membawa body).
// Hapus item (set, lang) di position = index, lalu rapatkan position.
router.delete('/:set/questions', requireRole('guru', 'admin'), (req, res) => {
  const set = req.params.set;
  if (!validSet(set)) return err(res, 400, 'set tidak dikenal (pretest, gate, posttest)');
  const body = req.body || {};
  if (body.set !== undefined && body.set !== null && body.set !== set) {
    return err(res, 400, 'Field set pada body tidak cocok dengan path');
  }
  const lang = body.lang === undefined || body.lang === null ? 'id' : body.lang;
  if (!LANGS.includes(lang)) return err(res, 400, "lang harus 'id' atau 'en'");
  if (body.index === undefined || body.index === null) {
    return err(res, 400, 'index wajib diisi');
  }
  const row = db.prepare(
    'SELECT * FROM question_bank_items WHERE set_name = ? AND lang = ? AND position = ?',
  ).get(set, lang, toInt(body.index, -1));
  if (!row) return err(res, 404, 'Soal tidak ditemukan');
  db.prepare('DELETE FROM question_bank_items WHERE id = ?').run(row.id);
  repackTx(set, lang);
  bumpVersion(set);
  return res.json({ ok: true, id: row.id });
});

// DELETE /api/question-banks/:set/questions/:id (guru/admin) — hapus item
// ber-id, rapatkan position pada (set, lang) item itu.
router.delete('/:set/questions/:id', requireRole('guru', 'admin'), (req, res) => {
  const set = req.params.set;
  if (!validSet(set)) return err(res, 400, 'set tidak dikenal (pretest, gate, posttest)');
  const row = db.prepare('SELECT * FROM question_bank_items WHERE id = ?')
    .get(toInt(req.params.id, -1));
  if (!row || row.set_name !== set) return err(res, 404, 'Soal tidak ditemukan');
  db.prepare('DELETE FROM question_bank_items WHERE id = ?').run(row.id);
  repackTx(row.set_name, row.lang);
  bumpVersion(set);
  return res.json({ ok: true, id: row.id });
});

module.exports = router;
