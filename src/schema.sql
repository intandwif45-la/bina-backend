-- Skema SQLite backend BINA (rebuild 2026-11-23).
-- Ditulis dari kontrak ~/workspace/bina/api-contract-inventory.md.
-- Semua tanggal/waktu disimpan sebagai teks ISO-8601 UTC, KECUALI:
--   streak_days.day ('YYYY-MM-DD' kalender lokal perangkat) dan
--   schedules.date ('YYYY-MM-DD') dan attendance.date ('YYYY-MM-DD').

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('siswa', 'guru', 'admin')),
  avatar_id TEXT,
  banner_id TEXT,
  created_at TEXT NOT NULL,
  reset_code TEXT,
  reset_code_expires TEXT
);

CREATE TABLE IF NOT EXISTS classes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  code TEXT NOT NULL UNIQUE,
  teacher_id INTEGER NOT NULL REFERENCES users (id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS class_members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  class_id INTEGER NOT NULL REFERENCES classes (id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  UNIQUE (class_id, user_id)
);

CREATE TABLE IF NOT EXISTS schedules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  class_id INTEGER NOT NULL REFERENCES classes (id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  date TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS schedule_parts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  schedule_id INTEGER NOT NULL REFERENCES schedules (id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  meet_link TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS question_bank_meta (
  set_name TEXT PRIMARY KEY,
  version INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS question_bank_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  set_name TEXT NOT NULL,
  lang TEXT NOT NULL CHECK (lang IN ('id', 'en')),
  position INTEGER NOT NULL,
  question TEXT NOT NULL,
  options TEXT NOT NULL DEFAULT '[]',
  correct_index INTEGER NOT NULL DEFAULT 0,
  explanation TEXT NOT NULL DEFAULT '',
  component_id TEXT,
  image_asset TEXT,
  image_caption TEXT,
  UNIQUE (set_name, lang, position)
);

CREATE TABLE IF NOT EXISTS point_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  entry_key TEXT NOT NULL,
  points INTEGER NOT NULL DEFAULT 0,
  label TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT '',
  earned_at TEXT NOT NULL,
  UNIQUE (user_id, entry_key)
);

CREATE TABLE IF NOT EXISTS user_badges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  badge_id TEXT NOT NULL,
  unlocked_at TEXT NOT NULL,
  UNIQUE (user_id, badge_id)
);

CREATE TABLE IF NOT EXISTS streak_days (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  UNIQUE (user_id, day)
);

CREATE TABLE IF NOT EXISTS progress_snapshots (
  user_id INTEGER PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  materi TEXT NOT NULL DEFAULT '[false,false,false,false]',
  flashcards_mastered TEXT NOT NULL DEFAULT '[]',
  diagnosis_completed TEXT NOT NULL DEFAULT '[]',
  front_panel_wins INTEGER NOT NULL DEFAULT 0,
  simulator_completed INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS certificates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  score INTEGER NOT NULL DEFAULT 0,
  date TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS attendance (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  time TEXT NOT NULL,
  UNIQUE (user_id, date)
);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  class_id INTEGER NOT NULL REFERENCES classes (id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL DEFAULT 'quiz' CHECK (type IN ('quiz', 'assignment')),
  opens_at TEXT,
  due_at TEXT,
  questions TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  answers TEXT,
  answer_text TEXT,
  answer_link TEXT,
  file_name TEXT,
  file_mime TEXT,
  file_base64 TEXT,
  auto_score INTEGER NOT NULL DEFAULT 0,
  score INTEGER,
  review TEXT,
  submitted_at TEXT NOT NULL,
  UNIQUE (task_id, user_id)
);

CREATE TABLE IF NOT EXISTS scores (
  user_id INTEGER PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  pretest INTEGER,
  posttest INTEGER,
  latihan_best INTEGER,
  simulator_best INTEGER,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS live_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  class_id INTEGER NOT NULL REFERENCES classes (id) ON DELETE CASCADE,
  teacher_id INTEGER NOT NULL REFERENCES users (id),
  title TEXT NOT NULL,
  opening_text TEXT NOT NULL DEFAULT '',
  material_text TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'ended')),
  started_at TEXT NOT NULL,
  ended_at TEXT
);

CREATE TABLE IF NOT EXISTS live_quizzes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES live_sessions (id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'running', 'finished')),
  current_index INTEGER NOT NULL DEFAULT -1,
  boss_max_hp INTEGER NOT NULL DEFAULT 100,
  boss_hp_remaining INTEGER NOT NULL DEFAULT 100,
  questions TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS live_quiz_answers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  quiz_id INTEGER NOT NULL REFERENCES live_quizzes (id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  question_index INTEGER NOT NULL,
  selected_index INTEGER NOT NULL,
  correct INTEGER NOT NULL DEFAULT 0,
  UNIQUE (quiz_id, user_id, question_index)
);

CREATE TABLE IF NOT EXISTS live_understanding (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES live_sessions (id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  level INTEGER NOT NULL DEFAULT 0,
  UNIQUE (session_id, user_id)
);

CREATE TABLE IF NOT EXISTS live_attendance (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES live_sessions (id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  joined_at TEXT NOT NULL,
  UNIQUE (session_id, user_id)
);

CREATE TABLE IF NOT EXISTS breakout_groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES live_sessions (id) ON DELETE CASCADE,
  name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS breakout_group_members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id INTEGER NOT NULL REFERENCES breakout_groups (id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  UNIQUE (group_id, user_id)
);

CREATE TABLE IF NOT EXISTS group_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id INTEGER NOT NULL REFERENCES breakout_groups (id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  class_id INTEGER NOT NULL REFERENCES classes (id) ON DELETE CASCADE,
  teacher_id INTEGER NOT NULL REFERENCES users (id),
  student_id INTEGER NOT NULL REFERENCES users (id),
  UNIQUE (class_id, student_id)
);

CREATE TABLE IF NOT EXISTS direct_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  sender_id INTEGER NOT NULL REFERENCES users (id),
  text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  read_by_teacher INTEGER NOT NULL DEFAULT 0,
  read_by_student INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS materials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  class_id INTEGER NOT NULL REFERENCES classes (id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  link_url TEXT,
  file_name TEXT,
  file_mime TEXT,
  file_base64 TEXT,
  has_file INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS announcements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  class_id INTEGER NOT NULL REFERENCES classes (id) ON DELETE CASCADE,
  author_id INTEGER NOT NULL REFERENCES users (id),
  text TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS parent_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  class_id INTEGER NOT NULL REFERENCES classes (id) ON DELETE CASCADE,
  student_id INTEGER NOT NULL REFERENCES users (id),
  teacher_id INTEGER NOT NULL REFERENCES users (id),
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS download_tokens (
  token TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('material', 'submission')),
  ref_id INTEGER NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_class_members_user ON class_members (user_id);
CREATE INDEX IF NOT EXISTS idx_point_entries_user ON point_entries (user_id);
CREATE INDEX IF NOT EXISTS idx_tasks_class ON tasks (class_id);
CREATE INDEX IF NOT EXISTS idx_submissions_task ON submissions (task_id);
CREATE INDEX IF NOT EXISTS idx_submissions_user ON submissions (user_id);
CREATE INDEX IF NOT EXISTS idx_live_quizzes_session ON live_quizzes (session_id);
CREATE INDEX IF NOT EXISTS idx_direct_messages_conv ON direct_messages (conversation_id);
