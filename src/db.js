'use strict';
// Satu instansi better-sqlite3 untuk seluruh backend.
// Path DB: env DATABASE_PATH, default <proyek>/data/bina.db (digitingore).
// Skema dimuat dari src/schema.sql setiap start (CREATE TABLE IF NOT EXISTS).
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const dbPath = process.env.DATABASE_PATH || path.join(__dirname, '..', 'data', 'bina.db');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
db.exec(schema);

module.exports = db;
