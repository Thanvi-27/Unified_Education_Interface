/* Unified Education Interface - Node.js (Express) + SQLite backend */
const express = require("express");
const cookieParser = require("cookie-parser");
const bcrypt = require("bcryptjs");
const Database = require("better-sqlite3");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const SUBJECTS = ["Data Structures", "DBMS", "Operating Systems", "Web Development", "Machine Learning"];
const TIMETABLE = {
  1: [["09:00", SUBJECTS[0]], ["11:00", SUBJECTS[1]]], 2: [["10:00", SUBJECTS[2]]],
  3: [["09:00", SUBJECTS[3]], ["14:00", SUBJECTS[4]]], 4: [["11:00", SUBJECTS[1]]],
  5: [["10:00", SUBJECTS[0]]], 6: [], 0: [],
};
const ROLES = ["student", "faculty", "admin"];
const SESSION_DAYS = 7;

/* ---------------------------------------------------------------- database */
const db = new Database(process.env.DB_FILE || "uei.db");
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.exec(`
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'student', topics TEXT DEFAULT '');
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS assignments(id INTEGER PRIMARY KEY, title TEXT NOT NULL, subj TEXT NOT NULL, due TEXT NOT NULL, est REAL DEFAULT 2, created_by INTEGER);
CREATE TABLE IF NOT EXISTS submissions(user_id INTEGER NOT NULL, assignment_id INTEGER NOT NULL, UNIQUE(user_id, assignment_id));
CREATE TABLE IF NOT EXISTS exams(id INTEGER PRIMARY KEY, user_id INTEGER, subj TEXT NOT NULL, date TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS goals(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, text TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS attendance(user_id INTEGER NOT NULL, subject TEXT NOT NULL, attended INTEGER DEFAULT 0, total INTEGER DEFAULT 0, UNIQUE(user_id, subject));
CREATE TABLE IF NOT EXISTS grades(user_id INTEGER NOT NULL, subject TEXT NOT NULL, score INTEGER NOT NULL, UNIQUE(user_id, subject));
CREATE TABLE IF NOT EXISTS materials(id INTEGER PRIMARY KEY, title TEXT NOT NULL, subject TEXT NOT NULL, kind TEXT DEFAULT 'PDF');
CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY, author_id INTEGER NOT NULL, text TEXT NOT NULL, created TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS groups(id INTEGER PRIMARY KEY, name TEXT NOT NULL, subject TEXT NOT NULL, topic TEXT DEFAULT 'General');
CREATE TABLE IF NOT EXISTS group_members(group_id INTEGER NOT NULL, user_id INTEGER NOT NULL, UNIQUE(group_id, user_id));
CREATE TABLE IF NOT EXISTS doubts(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, subject TEXT NOT NULL, question TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS replies(id INTEGER PRIMARY KEY, doubt_id INTEGER NOT NULL, user_id INTEGER NOT NULL, text TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS shared(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, title TEXT NOT NULL, subject TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS career_ticks(user_id INTEGER NOT NULL, key TEXT NOT NULL, UNIQUE(user_id, key));
`);
const q = (sql, ...p) => db.prepare(sql).all(...p);
const one = (sql, ...p) => db.prepare(sql).get(...p);
const run = (sql, ...p) => db.prepare(sql).run(...p);
const today = (off = 0) => { const d = new Date(); d.setDate(d.getDate() + off); return d.toISOString().slice(0, 10); };

/* ---------------------------------------------------------------- app + helpers */
const app = express();
const stateExtenders = [];
app.disable("x-powered-by");
app.use(express.json({ limit: "20kb" }));
app.use(cookieParser());
app.use((req, res, next) => {
  res.set("X-Content-Type-Options", "nosniff");
  res.set("X-Frame-Options", "DENY");
  if (req.path.startsWith("/api/")) res.set("Cache-Control", "no-store");
  // CSRF guard: custom header cannot be sent cross-site without CORS preflight
  if (req.path.startsWith("/api/") && !["GET", "HEAD", "OPTIONS"].includes(req.method) && req.get("X-Requested-With") !== "uei")
    return res.status(400).json({ error: "Bad request" });
  next();
});

class HttpError extends Error { constructor(msg, code = 400) { super(msg); this.code = code; } }
const text = (d, k, n = 200, required = true) => {
  const v = String(d[k] ?? "").trim().slice(0, n);
  if (required && !v) throw new HttpError(`${k} is required`);
  return v;
};
const subject = (d, k = "subject") => {
  const v = d[k] || d.subj;
  if (!SUBJECTS.includes(v)) throw new HttpError("Unknown subject");
  return v;
};
const parseDate = v => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v)) || isNaN(new Date(v))) throw new HttpError("Invalid date");
  return String(v);
};

// sessions: random token in an HttpOnly cookie, stored (revocable) in the database
function startSession(res, userId) {
  const token = crypto.randomBytes(32).toString("hex");
  const expires = Date.now() + SESSION_DAYS * 864e5;
  run("INSERT INTO sessions(token,user_id,expires) VALUES(?,?,?)", token, userId, expires);
  res.cookie("sid", token, { httpOnly: true, sameSite: "lax", secure: process.env.COOKIE_SECURE === "1", maxAge: SESSION_DAYS * 864e5 });
}
const currentUser = req => {
  const t = req.cookies.sid;
  if (!t) return null;
  const s = one("SELECT user_id, expires FROM sessions WHERE token=?", t);
  if (!s) return null;
  if (s.expires < Date.now()) { run("DELETE FROM sessions WHERE token=?", t); return null; }
  return one("SELECT * FROM users WHERE id=?", s.user_id);
};
const need = (...roles) => (handler) => (req, res) => {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: "Please sign in" });
  if (roles.length && !roles.includes(u.role)) return res.status(403).json({ error: "You do not have permission for this action" });
  try { handler(u, req, res); }
  catch (e) {
    if (e instanceof HttpError) return res.status(e.code).json({ error: e.message });
    console.error(e); res.status(500).json({ error: "Server error" });
  }
};
const wrap = fn => (req, res) => {
  try { fn(req, res); }
  catch (e) {
    if (e instanceof HttpError) return res.status(e.code).json({ error: e.message });
    console.error(e); res.status(500).json({ error: "Server error" });
  }
};

// login throttle (in memory): 5 failures / 5 minutes per ip+email
const fails = new Map();
const throttled = key => { const n = Date.now(); const a = (fails.get(key) || []).filter(t => n - t < 3e5); fails.set(key, a); return a.length >= 5; };

/* ---------------------------------------------------------------- auth */
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

app.post("/api/register", wrap((req, res) => {
  const d = req.body || {};
  const name = text(d, "name", 80), email = text(d, "email", 120).toLowerCase();
  const pw = String(d.password || ""), role = d.role || "student";
  if (!EMAIL_RE.test(email)) throw new HttpError("Enter a valid email address");
  if (pw.length < 8) throw new HttpError("Password must be at least 8 characters");
  if (!ROLES.includes(role)) throw new HttpError("Invalid role");
  if (role !== "student") {
    const expected = process.env[role === "faculty" ? "FACULTY_CODE" : "ADMIN_CODE"];
    if (!expected || !safeEq(d.code || "", expected)) throw new HttpError("Invalid invite code for this role", 403);
  }
  if (one("SELECT id FROM users WHERE email=?", email)) throw new HttpError("An account with this email already exists", 409);
  const info = run("INSERT INTO users(name,email,password_hash,role) VALUES(?,?,?,?)", name, email, bcrypt.hashSync(pw, 10), role);
  startSession(res, info.lastInsertRowid);
  res.json({ ok: true });
}));

app.post("/api/login", wrap((req, res) => {
  const d = req.body || {};
  const email = String(d.email || "").trim().toLowerCase();
  const key = `${req.ip}:${email}`;
  if (throttled(key)) throw new HttpError("Too many failed attempts. Try again in a few minutes.", 429);
  const u = one("SELECT * FROM users WHERE email=?", email);
  if (!u || !bcrypt.compareSync(String(d.password || ""), u.password_hash)) {
    fails.get(key).push(Date.now());
    throw new HttpError("Incorrect email or password", 401);
  }
  startSession(res, u.id);
  res.json({ ok: true });
}));

app.post("/api/logout", wrap((req, res) => {
  if (req.cookies.sid) run("DELETE FROM sessions WHERE token=?", req.cookies.sid);
  res.clearCookie("sid");
  res.json({ ok: true });
}));

/* ---------------------------------------------------------------- state (everything the UI needs) */
app.get("/api/state", need()((u, req, res) => {
  const S = { user: { name: u.name, role: u.role, email: u.email }, timetable: TIMETABLE, mytopics: u.topics || "" };
  const counts = Object.fromEntries(q("SELECT assignment_id a, COUNT(*) c FROM submissions GROUP BY assignment_id").map(r => [r.a, r.c]));
  const done = new Set(q("SELECT assignment_id a FROM submissions WHERE user_id=?", u.id).map(r => r.a));
  S.assignments = q("SELECT * FROM assignments ORDER BY due").map(a => ({ id: a.id, title: a.title, subj: a.subj, due: a.due, est: a.est, done: done.has(a.id), subs: counts[a.id] || 0 }));
  S.exams = q("SELECT id,subj,date FROM exams WHERE user_id IS NULL OR user_id=? ORDER BY date", u.id);
  S.materials = q("SELECT title t, subject s, kind k FROM materials ORDER BY id");
  S.messages = q("SELECT m.text, m.created at, u.name, u.role FROM messages m JOIN users u ON u.id=m.author_id ORDER BY m.id LIMIT 100")
    .map(m => ({ from: `${m.name} (${m.role})`, text: m.text, at: m.at }));
  S.goals = q("SELECT id,text FROM goals WHERE user_id=?", u.id);
  const att = Object.fromEntries(q("SELECT subject,attended,total FROM attendance WHERE user_id=?", u.id).map(a => [a.subject, [a.attended, a.total]]));
  S.attendance = Object.fromEntries(SUBJECTS.map(s => [s, att[s] || [0, 0]]));
  S.grades = Object.fromEntries(q("SELECT subject,score FROM grades WHERE user_id=?", u.id).map(g => [g.subject, g.score]));
  S.career = { done: Object.fromEntries(q("SELECT key FROM career_ticks WHERE user_id=?", u.id).map(c => [c.key, true])) };
  // peer learning
  S.groups = q("SELECT * FROM groups ORDER BY id").map(g => {
    const ms = q("SELECT u.id, u.name FROM group_members gm JOIN users u ON u.id=gm.user_id WHERE gm.group_id=?", g.id);
    return { id: g.id, name: g.name, subj: g.subject, topic: g.topic, joined: ms.some(m => m.id === u.id), members: ms.filter(m => m.id !== u.id).map(m => m.name) };
  });
  S.doubts = q("SELECT d.id, d.subject subj, d.question q, u.name by FROM doubts d JOIN users u ON u.id=d.user_id ORDER BY d.id DESC LIMIT 100")
    .map(d => ({ ...d, replies: q("SELECT u.name by, r.text FROM replies r JOIN users u ON u.id=r.user_id WHERE r.doubt_id=? ORDER BY r.id", d.id) }));
  S.shared = q("SELECT s.title t, u.name by, s.subject s FROM shared s JOIN users u ON u.id=s.user_id ORDER BY s.id DESC");
  S.classmates = q("SELECT name n, topics FROM users WHERE role='student' AND id<>? AND topics<>''", u.id)
    .map(c => ({ n: c.n, topics: c.topics.split(",").map(t => t.trim()).filter(Boolean) }));
  if (u.role === "faculty") S.students = q("SELECT id,name FROM users WHERE role='student' ORDER BY name");
  if (u.role === "admin") S.stats = Object.fromEntries(ROLES.map(r => [r, one("SELECT COUNT(*) c FROM users WHERE role=?", r).c]));
  for (const extender of stateExtenders) extender(S, u);
  res.json(S);
}));

/* ---------------------------------------------------------------- planner */
app.post("/api/goals", need("student")((u, req, res) => { run("INSERT INTO goals(user_id,text) VALUES(?,?)", u.id, text(req.body || {}, "text")); res.json({ ok: true }); }));
app.delete("/api/goals/:id", need("student")((u, req, res) => { run("DELETE FROM goals WHERE id=? AND user_id=?", +req.params.id, u.id); res.json({ ok: true }); }));
app.post("/api/exams", need("student", "faculty")((u, req, res) => {
  const d = req.body || {};
  run("INSERT INTO exams(user_id,subj,date) VALUES(?,?,?)", u.role === "faculty" ? null : u.id, subject(d), parseDate(d.date));
  res.json({ ok: true });
}));

/* ---------------------------------------------------------------- core modules */
app.post("/api/assignments", need("faculty")((u, req, res) => {
  const d = req.body || {};
  const est = Math.max(0.5, Math.min(Number(d.est) || 2, 40));
  run("INSERT INTO assignments(title,subj,due,est,created_by) VALUES(?,?,?,?,?)", text(d, "title", 120), subject(d), parseDate(d.due), est, u.id);
  res.json({ ok: true });
}));
app.post("/api/assignments/:id/submit", need("student")((u, req, res) => {
  const id = +req.params.id;
  if (!one("SELECT id FROM assignments WHERE id=?", id)) throw new HttpError("Assignment not found", 404);
  run("INSERT OR IGNORE INTO submissions(user_id,assignment_id) VALUES(?,?)", u.id, id);
  res.json({ ok: true });
}));
app.post("/api/materials", need("faculty")((u, req, res) => {
  const d = req.body || {};
  run("INSERT INTO materials(title,subject,kind) VALUES(?,?,?)", text(d, "title", 120), subject(d), ["PDF", "Video", "E-book"].includes(d.kind) ? d.kind : "PDF");
  res.json({ ok: true });
}));
app.post("/api/messages", need()((u, req, res) => { run("INSERT INTO messages(author_id,text,created) VALUES(?,?,?)", u.id, text(req.body || {}, "text", 500), today()); res.json({ ok: true }); }));

const studentOf = d => {
  const s = one("SELECT id FROM users WHERE id=? AND role='student'", +d.student_id || 0);
  if (!s) throw new HttpError("Student not found");
  return s.id;
};
app.post("/api/attendance", need("faculty")((u, req, res) => {
  const d = req.body || {}, sid = studentOf(d), sub = subject(d);
  run(`INSERT INTO attendance(user_id,subject,attended,total) VALUES(?,?,?,1)
       ON CONFLICT(user_id,subject) DO UPDATE SET total=total+1, attended=attended+?`, sid, sub, d.present ? 1 : 0, d.present ? 1 : 0);
  res.json({ ok: true });
}));
app.post("/api/grades", need("faculty")((u, req, res) => {
  const d = req.body || {}, sid = studentOf(d), sub = subject(d), score = Math.trunc(Number(d.score));
  if (!Number.isFinite(score) || score < 0 || score > 100) throw new HttpError("Score must be between 0 and 100");
  run("INSERT INTO grades(user_id,subject,score) VALUES(?,?,?) ON CONFLICT(user_id,subject) DO UPDATE SET score=excluded.score", sid, sub, score);
  res.json({ ok: true });
}));

/* ---------------------------------------------------------------- peer learning */
app.put("/api/profile", need("student")((u, req, res) => { run("UPDATE users SET topics=? WHERE id=?", text(req.body || {}, "topics", 200, false), u.id); res.json({ ok: true }); }));
app.post("/api/groups", need("student")((u, req, res) => {
  const d = req.body || {};
  const g = run("INSERT INTO groups(name,subject,topic) VALUES(?,?,?)", text(d, "name", 80), subject(d), text(d, "topic", 80, false) || "General");
  run("INSERT INTO group_members(group_id,user_id) VALUES(?,?)", g.lastInsertRowid, u.id);
  res.json({ ok: true });
}));
app.post("/api/groups/:id/toggle", need("student")((u, req, res) => {
  const id = +req.params.id;
  if (!one("SELECT id FROM groups WHERE id=?", id)) throw new HttpError("Group not found", 404);
  const r = run("DELETE FROM group_members WHERE group_id=? AND user_id=?", id, u.id);
  if (!r.changes) run("INSERT INTO group_members(group_id,user_id) VALUES(?,?)", id, u.id);
  res.json({ ok: true });
}));
app.post("/api/doubts", need()((u, req, res) => { const d = req.body || {}; run("INSERT INTO doubts(user_id,subject,question) VALUES(?,?,?)", u.id, subject(d), text(d, "question", 500)); res.json({ ok: true }); }));
app.post("/api/doubts/:id/replies", need()((u, req, res) => {
  const id = +req.params.id;
  if (!one("SELECT id FROM doubts WHERE id=?", id)) throw new HttpError("Doubt not found", 404);
  run("INSERT INTO replies(doubt_id,user_id,text) VALUES(?,?,?)", id, u.id, text(req.body || {}, "text", 500));
  res.json({ ok: true });
}));
app.post("/api/shared", need("student", "faculty")((u, req, res) => { const d = req.body || {}; run("INSERT INTO shared(user_id,title,subject) VALUES(?,?,?)", u.id, text(d, "title", 150), subject(d)); res.json({ ok: true }); }));

/* ---------------------------------------------------------------- career roadmap */
app.post("/api/career", need("student")((u, req, res) => {
  const key = text(req.body || {}, "key", 200);
  const r = run("DELETE FROM career_ticks WHERE user_id=? AND key=?", u.id, key);
  if (!r.changes) run("INSERT INTO career_ticks(user_id,key) VALUES(?,?)", u.id, key);
  res.json({ ok: true });
}));

const moduleApi = require("../modules")({
  app,
  db,
  q,
  one,
  run,
  need,
  HttpError,
  text,
  parseDate,
  today,
  SUBJECTS,
  stateExtenders,
});

/* ---------------------------------------------------------------- static + seed */
const publicDir = (() => {
  const primary = path.join(__dirname, "public");
  if (fs.existsSync(path.join(primary, "index.html"))) return primary;
  const fallback = path.join(__dirname, "..", "public");
  if (fs.existsSync(path.join(fallback, "index.html"))) return fallback;
  return primary;
})();
app.use(express.static(publicDir));
app.get("/", (req, res) => res.sendFile(path.join(publicDir, "index.html")));
app.use((req, res) => res.status(404).json({ error: "Not found" }));

function seedDemo() {
  if (one("SELECT id FROM users LIMIT 1") || process.env.SEED_DEMO === "0") return;
  const mk = (n, e, p, r, t = "") => run("INSERT INTO users(name,email,password_hash,role,topics) VALUES(?,?,?,?,?)", n, e, bcrypt.hashSync(p, 10), r, t).lastInsertRowid;
  const fac = mk("Prof. Naveen N", "faculty@uei.edu", "faculty123", "faculty");
  mk("Admin", "admin@uei.edu", "admin12345", "admin");
  const stu = mk("Demo Student", "student@uei.edu", "student123", "student", "Graphs, SQL Joins");
  mk("Anita", "anita@uei.edu", "student123", "student", "Graphs, Sorting");
  mk("Karan", "karan@uei.edu", "student123", "student", "Normalization");
  [["Linked List Lab", 0, 1, 2], ["ER Diagram Report", 1, 3, 3], ["Process Scheduling Sheet", 2, 6, 2]]
    .forEach(([t, s, d, e]) => run("INSERT INTO assignments(title,subj,due,est,created_by) VALUES(?,?,?,?,?)", t, SUBJECTS[s], today(d), e, fac));
  run("INSERT INTO exams(subj,date) VALUES(?,?)", SUBJECTS[1], today(5));
  run("INSERT INTO exams(subj,date) VALUES(?,?)", SUBJECTS[0], today(11));
  [["Trees and Graphs Notes", 0, "PDF"], ["Normalization Video", 1, "Video"], ["React Basics", 3, "Video"]]
    .forEach(([t, s, k]) => run("INSERT INTO materials(title,subject,kind) VALUES(?,?,?)", t, SUBJECTS[s], k));
  run("INSERT INTO messages(author_id,text,created) VALUES(?,?,?)", fac, "Mid-term revision session on Friday at 4 PM.", today());
  run("INSERT INTO goals(user_id,text) VALUES(?,?)", stu, "Solve 2 coding problems");
  run("INSERT INTO groups(name,subject,topic) VALUES(?,?,?)", "DSA Warriors", SUBJECTS[0], "Graphs");
  run("INSERT INTO groups(name,subject,topic) VALUES(?,?,?)", "SQL Squad", SUBJECTS[1], "Normalization");
  SUBJECTS.forEach((s, i) => {
    run("INSERT INTO grades VALUES(?,?,?)", stu, s, [82, 68, 75, 90, 71][i]);
    run("INSERT INTO attendance VALUES(?,?,?,?)", stu, s, [18, 15, 17, 12, 9][i], [20, 20, 19, 14, 12][i]);
  });
  console.log("Demo accounts: student@uei.edu/student123, faculty@uei.edu/faculty123, admin@uei.edu/admin12345");
}
seedDemo();
moduleApi.seed();
run("DELETE FROM sessions WHERE expires < ?", Date.now());

if (require.main === module) {
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`Unified Education Interface on http://localhost:${port}`));
}
module.exports = app;
