/* Extra modules: Exam Seating, Faculty Appointments, Library, Fees & Dues */
module.exports = function mount(h) {
  const { app, db, q, one, run, need, HttpError, text, parseDate, today, SUBJECTS } = h;
  const stateExtenders = Array.isArray(h.stateExtenders) ? h.stateExtenders : ((h.stateExtenders = []), h.stateExtenders);
  const LOAN_DAYS = 14, FINE_PER_DAY = 2, MAX_LOANS = 3;
  const PURPOSES = ["Academic doubt", "Project review", "Mentoring"];
  const CATEGORIES = ["Tuition", "Lab charges", "Library fine", "Other"];
  const METHODS = ["Cash", "UPI", "Card", "Bank transfer"];

  db.exec(`
CREATE TABLE IF NOT EXISTS rooms(id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL, capacity INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS exam_sessions(id INTEGER PRIMARY KEY, subject TEXT NOT NULL, date TEXT NOT NULL, time TEXT NOT NULL, UNIQUE(subject,date,time));
CREATE TABLE IF NOT EXISTS seats(id INTEGER PRIMARY KEY, session_id INTEGER NOT NULL REFERENCES exam_sessions(id) ON DELETE CASCADE,
  room_id INTEGER NOT NULL REFERENCES rooms(id), seat_no INTEGER NOT NULL, user_id INTEGER NOT NULL REFERENCES users(id),
  UNIQUE(session_id,room_id,seat_no), UNIQUE(session_id,user_id));
CREATE TABLE IF NOT EXISTS slots(id INTEGER PRIMARY KEY, faculty_id INTEGER NOT NULL, date TEXT NOT NULL, time TEXT NOT NULL, student_id INTEGER,
  purpose TEXT, status TEXT NOT NULL DEFAULT 'available', notes TEXT DEFAULT '', followup TEXT DEFAULT '', UNIQUE(faculty_id,date,time));
CREATE TABLE IF NOT EXISTS books(id INTEGER PRIMARY KEY, title TEXT NOT NULL, author TEXT NOT NULL, subject TEXT NOT NULL, copies INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS loans(id INTEGER PRIMARY KEY, book_id INTEGER NOT NULL, user_id INTEGER NOT NULL, status TEXT NOT NULL,
  reserved_on TEXT, due TEXT, returned_on TEXT, fine INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS waitlist(id INTEGER PRIMARY KEY, book_id INTEGER NOT NULL, user_id INTEGER NOT NULL, UNIQUE(book_id,user_id));
CREATE TABLE IF NOT EXISTS fees(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, category TEXT NOT NULL, description TEXT NOT NULL, amount INTEGER NOT NULL, due TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS payments(id INTEGER PRIMARY KEY, fee_id INTEGER NOT NULL, user_id INTEGER NOT NULL, amount INTEGER NOT NULL, method TEXT NOT NULL,
  reference TEXT DEFAULT '', paid_on TEXT NOT NULL, recorded_by INTEGER NOT NULL, verified INTEGER NOT NULL DEFAULT 0, verified_by INTEGER, receipt_no TEXT);
`);

  /* ---------- helpers ---------- */
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const uniq = (fn, msg) => { try { return fn(); } catch (e) { if (String(e.code).startsWith("SQLITE_CONSTRAINT")) throw new HttpError(msg, 409); throw e; } };
  const int = (v, min, max, label) => { const n = Number(v); if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(`${label} must be a whole number between ${min} and ${max}`); return n; };
  const timeStr = v => { if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(v))) throw new HttpError("Invalid time"); return String(v); };
  const oneOf = (v, arr, label) => { if (!arr.includes(v)) throw new HttpError(`Invalid ${label}`); return v; };
  const dayDiff = (a, b) => Math.round((new Date(a) - new Date(b)) / 864e5);
  const addDays = n => today(n);
  const nf = n => Number(n).toLocaleString("en-IN");
  const page = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>
body{font:15px/1.5 system-ui,Arial,sans-serif;color:#111;margin:0;padding:16px}.t{border:2px solid #111;padding:22px;max-width:660px;margin:18px auto;page-break-after:always}
h1,h2{margin:0;text-align:center}h2{font-size:15px;font-weight:400;margin-bottom:14px}table{width:100%;border-collapse:collapse;margin:12px 0}
td,th{border:1px solid #999;padding:7px 9px;text-align:left}th{width:38%;background:#f2f2f2}ol{font-size:13px;color:#333}.np{text-align:center}@media print{.np{display:none}}</style></head>
<body>${body}<p class="np"><button onclick="print()">Print / Save as PDF</button></p></body></html>`;
  const sendHtml = (res, html, filename) => {
    res.set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'");
    if (filename) res.set("Content-Disposition", `attachment; filename="${filename}"`);
    res.type("html").send(html);
  };
  const studentRow = id => { const s = one("SELECT id,name FROM users WHERE id=? AND role='student'", +id || 0); if (!s) throw new HttpError("Student not found"); return s; };

  /* =====================================================  1. EXAM HALL & SEAT ALLOCATION */
  const examOf = id => one("SELECT * FROM exam_sessions WHERE id=?", id) || (() => { throw new HttpError("Exam not found", 404); })();
  const takenSeats = (e, roomId) => new Set(q("SELECT st.seat_no n FROM seats st JOIN exam_sessions x ON x.id=st.session_id WHERE st.room_id=? AND x.date=? AND x.time=?", roomId, e.date, e.time).map(r => r.n));
  const seatedAtSlot = (e, uid) => one("SELECT 1 x FROM seats st JOIN exam_sessions x ON x.id=st.session_id WHERE st.user_id=? AND x.date=? AND x.time=?", uid, e.date, e.time);

  function allocateExam(e) {
    const rooms = q("SELECT * FROM rooms ORDER BY id");
    if (!rooms.length) throw new HttpError("Add at least one room first");
    const students = q("SELECT id FROM users WHERE role='student' ORDER BY id").filter(s => !seatedAtSlot(e, s.id));
    let i = 0;
    db.transaction(() => {
      for (const r of rooms) {
        const used = takenSeats(e, r.id);
        for (let seat = 1; seat <= r.capacity && i < students.length; seat++) {
          if (used.has(seat)) continue;
          run("INSERT INTO seats(session_id,room_id,seat_no,user_id) VALUES(?,?,?,?)", e.id, r.id, seat, students[i++].id);
        }
      }
    })();
    return { allocated: i, unallocated: students.length - i };
  }

  app.post("/api/rooms", need("admin")((u, req, res) => {
    const d = req.body || {};
    uniq(() => run("INSERT INTO rooms(name,capacity) VALUES(?,?)", text(d, "name", 40), int(d.capacity, 1, 500, "Capacity")), "A room with this name already exists");
    res.json({ ok: true });
  }));

  app.post("/api/exam-sessions", need("admin")((u, req, res) => {
    const d = req.body || {};
    const subj = oneOf(d.subject, SUBJECTS, "subject"), date = parseDate(d.date), time = timeStr(d.time || "10:00");
    uniq(() => run("INSERT INTO exam_sessions(subject,date,time) VALUES(?,?,?)", subj, date, time), "This exam is already scheduled");
    // also publish it as an official exam date so every student's planner picks it up
    run("INSERT INTO exams(user_id,subj,date) SELECT NULL,?,? WHERE NOT EXISTS(SELECT 1 FROM exams WHERE user_id IS NULL AND subj=? AND date=?)", subj, date, subj, date);
    res.json({ ok: true });
  }));

  app.post("/api/exam-sessions/:id/allocate", need("admin")((u, req, res) => {
    const r = allocateExam(examOf(+req.params.id));
    res.json({ ok: true, message: r.unallocated ? `Allocated ${r.allocated} students. ${r.unallocated} could not be seated: add more rooms or capacity.` : `Allocated ${r.allocated} students. No duplicate seats were created.` });
  }));

  app.delete("/api/exam-sessions/:id/seats", need("admin")((u, req, res) => { run("DELETE FROM seats WHERE session_id=?", examOf(+req.params.id).id); res.json({ ok: true }); }));

  app.post("/api/seats", need("admin")((u, req, res) => {
    const d = req.body || {};
    const e = examOf(+d.session_id), stu = studentRow(d.student_id);
    const room = one("SELECT * FROM rooms WHERE id=?", +d.room_id || 0);
    if (!room) throw new HttpError("Room not found", 404);
    const seat = int(d.seat_no, 1, room.capacity, `Seat number (room ${room.name} has ${room.capacity} seats)`);
    if (takenSeats(e, room.id).has(seat)) throw new HttpError(`Seat ${seat} in ${room.name} is already taken for this exam slot`, 409);
    if (seatedAtSlot(e, stu.id)) throw new HttpError(`${stu.name} already has a seat for an exam at this date and time`, 409);
    uniq(() => run("INSERT INTO seats(session_id,room_id,seat_no,user_id) VALUES(?,?,?,?)", e.id, room.id, seat, stu.id), "Duplicate seat assignment blocked");
    res.json({ ok: true });
  }));

  app.get("/api/seating", need()((u, req, res) => {
    const term = "%" + String(req.query.q || "").trim().slice(0, 60).replace(/[\\%_]/g, "\\$&") + "%";
    const own = u.role === "student";
    const rows = q(`SELECT e.id session_id,e.subject,e.date,e.time,r.name room,st.seat_no seat,x.id student_id,x.name student
      FROM seats st JOIN exam_sessions e ON e.id=st.session_id JOIN rooms r ON r.id=st.room_id JOIN users x ON x.id=st.user_id
      WHERE (x.name LIKE ? ESCAPE '\\' OR e.subject LIKE ? ESCAPE '\\' OR r.name LIKE ? ESCAPE '\\')${own ? " AND x.id=?" : ""}
      ORDER BY e.date,e.time,r.name,st.seat_no LIMIT 200`, term, term, term, ...(own ? [u.id] : []));
    res.json({ rows });
  }));

  app.get("/api/hall-ticket/:sid", need("student", "admin")((u, req, res) => {
    const e = examOf(+req.params.sid);
    const ids = u.role === "student" ? [u.id]
      : req.query.student === "all" ? q("SELECT user_id FROM seats WHERE session_id=? ORDER BY room_id,seat_no", e.id).map(r => r.user_id)
      : [+req.query.student || 0];
    const tickets = ids.map(id => one(`SELECT x.id,x.name,x.email,r.name room,st.seat_no seat FROM seats st JOIN users x ON x.id=st.user_id
      JOIN rooms r ON r.id=st.room_id WHERE st.session_id=? AND st.user_id=?`, e.id, id)).filter(Boolean);
    if (!tickets.length) throw new HttpError("No seat has been allocated yet for this exam", 404);
    const html = tickets.map(t => `<section class="t"><h1>HALL TICKET</h1><h2>Unified Education Interface &middot; Examination Cell</h2>
<table><tr><th>Candidate</th><td>${esc(t.name)}</td></tr><tr><th>Candidate ID</th><td>UEI${String(t.id).padStart(4, "0")}</td></tr>
<tr><th>Email</th><td>${esc(t.email)}</td></tr><tr><th>Subject</th><td>${esc(e.subject)}</td></tr>
<tr><th>Date</th><td>${esc(e.date)}</td></tr><tr><th>Reporting time</th><td>${esc(e.time)} (arrive 20 minutes early)</td></tr>
<tr><th>Examination hall</th><td>${esc(t.room)}</td></tr><tr><th>Seat number</th><td><b>${t.seat}</b></td></tr></table>
<ol><li>Carry this hall ticket and your college ID card.</li><li>Mobile phones and smart watches are not allowed in the hall.</li><li>Sit only at the seat shown above.</li></ol></section>`).join("");
    sendHtml(res, page(`Hall ticket - ${e.subject}`, html));
  }));

  /* =====================================================  2. FACULTY APPOINTMENT BOOKING */
  const mySlot = (u, id) => one("SELECT * FROM slots WHERE id=? AND faculty_id=?", id, u.id) || (() => { throw new HttpError("Slot not found", 404); })();

  app.post("/api/slots", need("faculty")((u, req, res) => {
    const d = req.body || {};
    const date = parseDate(d.date), time = timeStr(d.time);
    if (date < today()) throw new HttpError("Slots must be in the future");
    uniq(() => run("INSERT INTO slots(faculty_id,date,time) VALUES(?,?,?)", u.id, date, time), "You already published a slot at this date and time");
    res.json({ ok: true });
  }));

  app.delete("/api/slots/:id", need("faculty")((u, req, res) => {
    const s = mySlot(u, +req.params.id);
    if (s.status !== "available") throw new HttpError("Cancel or complete the booking first", 409);
    run("DELETE FROM slots WHERE id=?", s.id);
    res.json({ ok: true });
  }));

  app.post("/api/slots/:id/book", need("student")((u, req, res) => {
    const s = one("SELECT * FROM slots WHERE id=?", +req.params.id);
    if (!s) throw new HttpError("Slot not found", 404);
    const purpose = oneOf((req.body || {}).purpose, PURPOSES, "purpose");
    if (s.date < today()) throw new HttpError("This slot is in the past", 409);
    if (one("SELECT 1 x FROM slots WHERE student_id=? AND date=? AND time=? AND status='booked'", u.id, s.date, s.time))
      throw new HttpError("You already have an appointment at this date and time", 409);
    // atomic claim: only one student can win this UPDATE
    const r = run("UPDATE slots SET student_id=?, purpose=?, status='booked' WHERE id=? AND status='available' AND student_id IS NULL", u.id, purpose, s.id);
    if (!r.changes) throw new HttpError("Sorry, this slot was just booked by someone else", 409);
    res.json({ ok: true, message: "Appointment booked." });
  }));

  app.post("/api/slots/:id/cancel", need("student", "faculty")((u, req, res) => {
    const s = one("SELECT * FROM slots WHERE id=?", +req.params.id);
    if (!s || (u.role === "student" ? s.student_id !== u.id : s.faculty_id !== u.id)) throw new HttpError("Appointment not found", 404);
    if (s.status !== "booked") throw new HttpError("Only a booked appointment can be cancelled", 409);
    run("UPDATE slots SET student_id=NULL, purpose=NULL, status='available', notes='', followup='' WHERE id=?", s.id);
    res.json({ ok: true, message: "Appointment cancelled. The slot is open again." });
  }));

  app.put("/api/slots/:id/outcome", need("faculty")((u, req, res) => {
    const s = mySlot(u, +req.params.id), d = req.body || {};
    if (!s.student_id) throw new HttpError("This slot has no booking", 409);
    run("UPDATE slots SET status=?, notes=?, followup=? WHERE id=?", oneOf(d.status, ["booked", "completed", "no_show"], "status"), text(d, "notes", 500, false), text(d, "followup", 300, false), s.id);
    res.json({ ok: true });
  }));

  /* =====================================================  3. LIBRARY */
  const bookOf = id => one("SELECT * FROM books WHERE id=?", id) || (() => { throw new HttpError("Book not found", 404); })();
  const activeCount = id => one("SELECT COUNT(*) c FROM loans WHERE book_id=? AND status IN ('reserved','borrowed')", id).c;
  const available = b => b.copies - activeCount(b.id);
  const activeLoan = (bid, uid) => one("SELECT * FROM loans WHERE book_id=? AND user_id=? AND status IN ('reserved','borrowed')", bid, uid);
  function promoteWaitlist(bookId) {  // give freed copies to the people who waited longest
    const b = bookOf(bookId);
    while (available(b) > 0) {
      const w = one("SELECT * FROM waitlist WHERE book_id=? ORDER BY id LIMIT 1", bookId);
      if (!w) break;
      run("DELETE FROM waitlist WHERE id=?", w.id);
      run("INSERT INTO loans(book_id,user_id,status,reserved_on) VALUES(?,?,'reserved',?)", bookId, w.user_id, today());
    }
  }

  app.post("/api/books", need("admin")((u, req, res) => {
    const d = req.body || {};
    run("INSERT INTO books(title,author,subject,copies) VALUES(?,?,?,?)", text(d, "title", 150), text(d, "author", 100), text(d, "subject", 60), int(d.copies || 1, 1, 100, "Copies"));
    res.json({ ok: true });
  }));

  app.post("/api/books/:id/reserve", need("student")((u, req, res) => {
    const id = +req.params.id;
    db.transaction(() => {
      const b = bookOf(id);
      if (activeLoan(id, u.id)) throw new HttpError("You already have this book reserved or borrowed", 409);
      if (one("SELECT 1 x FROM waitlist WHERE book_id=? AND user_id=?", id, u.id)) throw new HttpError("You are already on the waiting list for this book", 409);
      if (one("SELECT COUNT(*) c FROM loans WHERE user_id=? AND status IN ('reserved','borrowed')", u.id).c >= MAX_LOANS) throw new HttpError(`You can hold at most ${MAX_LOANS} books at a time`, 409);
      if (available(b) <= 0) throw new HttpError("No copies are available. Join the waiting list instead.", 409);
      run("INSERT INTO loans(book_id,user_id,status,reserved_on) VALUES(?,?,'reserved',?)", id, u.id, today());
    })();
    res.json({ ok: true, message: "Reserved. Collect it from the library desk." });
  }));

  app.post("/api/books/:id/waitlist", need("student")((u, req, res) => {
    const id = +req.params.id, b = bookOf(id);
    if (activeLoan(id, u.id)) throw new HttpError("You already have this book", 409);
    if (available(b) > 0) throw new HttpError("A copy is available. Reserve it instead.", 409);
    uniq(() => run("INSERT INTO waitlist(book_id,user_id) VALUES(?,?)", id, u.id), "You are already on the waiting list");
    res.json({ ok: true, message: "You joined the waiting list. A copy will be reserved for you when one is returned." });
  }));

  app.delete("/api/books/:id/waitlist", need("student")((u, req, res) => { run("DELETE FROM waitlist WHERE book_id=? AND user_id=?", +req.params.id, u.id); res.json({ ok: true }); }));

  app.post("/api/loans/:id/cancel", need("student", "admin")((u, req, res) => {
    const l = one("SELECT * FROM loans WHERE id=? AND status='reserved'", +req.params.id);
    if (!l || (u.role === "student" && l.user_id !== u.id)) throw new HttpError("Reservation not found", 404);
    db.transaction(() => { run("UPDATE loans SET status='cancelled' WHERE id=?", l.id); promoteWaitlist(l.book_id); })();
    res.json({ ok: true });
  }));

  app.post("/api/loans/:id/issue", need("admin")((u, req, res) => {
    const r = run("UPDATE loans SET status='borrowed', due=? WHERE id=? AND status='reserved'", addDays(LOAN_DAYS), +req.params.id);
    if (!r.changes) throw new HttpError("Reservation not found", 404);
    res.json({ ok: true, message: `Issued. Due in ${LOAN_DAYS} days.` });
  }));

  app.post("/api/loans/:id/return", need("admin")((u, req, res) => {
    let msg = "Returned.";
    db.transaction(() => {
      const l = one("SELECT * FROM loans WHERE id=? AND status='borrowed'", +req.params.id);
      if (!l) throw new HttpError("Borrowed loan not found", 404);
      const late = Math.max(0, dayDiff(today(), l.due)), fine = late * FINE_PER_DAY;
      run("UPDATE loans SET status='returned', returned_on=?, fine=? WHERE id=?", today(), fine, l.id);
      if (fine > 0) {
        run("INSERT INTO fees(user_id,category,description,amount,due) VALUES(?,?,?,?,?)", l.user_id, "Library fine", `Overdue ${late} day(s): ${bookOf(l.book_id).title}`, fine, addDays(7));
        msg = `Returned ${late} day(s) late. A fine of \u20B9${fine} was added to the student's fees.`;
      }
      promoteWaitlist(l.book_id);
    })();
    res.json({ ok: true, message: msg });
  }));

  /* =====================================================  4. FEES & DUES */
  const feeRows = (where, params = []) => q(`SELECT f.*, u.name student,
      COALESCE((SELECT SUM(amount) FROM payments p WHERE p.fee_id=f.id AND p.verified=1),0) paid,
      COALESCE((SELECT SUM(amount) FROM payments p WHERE p.fee_id=f.id AND p.verified=0),0) pending
      FROM fees f JOIN users u ON u.id=f.user_id ${where} ORDER BY f.due DESC, f.id DESC LIMIT 300`, ...params).map(f => {
    const outstanding = f.amount - f.paid, payable = outstanding - f.pending;
    const status = outstanding <= 0 ? "Paid" : payable <= 0 ? "Pending verification" : f.due < today() ? "Overdue" : f.paid > 0 ? "Partial" : "Due";
    return { id: f.id, user_id: f.user_id, student: f.student, category: f.category, description: f.description, amount: f.amount, due: f.due, paid: f.paid, pending: f.pending, outstanding, payable, status };
  });
  const totals = rows => rows.reduce((t, f) => ({ billed: t.billed + f.amount, paid: t.paid + f.paid, pending: t.pending + f.pending, outstanding: t.outstanding + f.outstanding }), { billed: 0, paid: 0, pending: 0, outstanding: 0 });
  const receiptNo = id => `RCT-${new Date().getFullYear()}-${String(id).padStart(6, "0")}`;

  app.post("/api/fees", need("admin")((u, req, res) => {
    const d = req.body || {};
    const category = oneOf(d.category, CATEGORIES, "category"), desc = text(d, "description", 150), amount = int(d.amount, 1, 1000000, "Amount"), due = parseDate(d.due);
    const ids = d.student_id === "all" ? q("SELECT id FROM users WHERE role='student'").map(r => r.id) : [studentRow(d.student_id).id];
    db.transaction(() => ids.forEach(id => run("INSERT INTO fees(user_id,category,description,amount,due) VALUES(?,?,?,?,?)", id, category, desc, amount, due)))();
    res.json({ ok: true, message: `Charge added for ${ids.length} student(s).` });
  }));

  app.post("/api/payments", need("admin")((u, req, res) => {
    const d = req.body || {};
    const f = feeRows("WHERE f.id=?", [+d.fee_id || 0])[0];
    if (!f) throw new HttpError("Charge not found", 404);
    const amount = int(d.amount, 1, 1000000, "Amount");
    if (amount > f.payable) throw new HttpError(`Amount exceeds the payable balance of \u20B9${nf(f.payable)}`);
    run("INSERT INTO payments(fee_id,user_id,amount,method,reference,paid_on,recorded_by) VALUES(?,?,?,?,?,?,?)",
      f.id, f.user_id, amount, oneOf(d.method, METHODS, "payment method"), text(d, "reference", 60, false), today(), u.id);
    res.json({ ok: true, message: "Payment recorded. Verify it to issue the receipt." });
  }));

  app.post("/api/payments/:id/verify", need("admin")((u, req, res) => {
    const id = +req.params.id;
    const r = run("UPDATE payments SET verified=1, verified_by=?, receipt_no=? WHERE id=? AND verified=0", u.id, receiptNo(id), id);
    if (!r.changes) throw new HttpError("Pending payment not found", 404);
    res.json({ ok: true, message: `Verified. Receipt ${receiptNo(id)} is now available.` });
  }));

  app.delete("/api/payments/:id", need("admin")((u, req, res) => {
    const r = run("DELETE FROM payments WHERE id=? AND verified=0", +req.params.id);
    if (!r.changes) throw new HttpError("Only unverified payments can be removed", 409);
    res.json({ ok: true });
  }));

  app.get("/api/receipts/:id", need("student", "admin")((u, req, res) => {
    const p = one(`SELECT p.*, f.category, f.description, f.amount fee_amount, s.name student, s.email, v.name verifier
      FROM payments p JOIN fees f ON f.id=p.fee_id JOIN users s ON s.id=p.user_id LEFT JOIN users v ON v.id=p.verified_by WHERE p.id=? AND p.verified=1`, +req.params.id);
    if (!p || (u.role === "student" && p.user_id !== u.id)) throw new HttpError("Receipt not found", 404);
    const fee = feeRows("WHERE f.id=?", [p.fee_id])[0];
    const html = `<section class="t"><h1>PAYMENT RECEIPT</h1><h2>Unified Education Interface &middot; Accounts Office</h2>
<table><tr><th>Receipt no.</th><td>${esc(p.receipt_no)}</td></tr><tr><th>Date paid</th><td>${esc(p.paid_on)}</td></tr>
<tr><th>Student</th><td>${esc(p.student)} (${esc(p.email)})</td></tr><tr><th>Charge</th><td>${esc(p.category)} &ndash; ${esc(p.description)}</td></tr>
<tr><th>Charge total</th><td>&#8377;${nf(p.fee_amount)}</td></tr><tr><th>Amount received</th><td><b>&#8377;${nf(p.amount)}</b></td></tr>
<tr><th>Method / reference</th><td>${esc(p.method)}${p.reference ? " / " + esc(p.reference) : ""}</td></tr>
<tr><th>Balance on this charge</th><td>&#8377;${nf(fee.outstanding)}</td></tr><tr><th>Verified by</th><td>${esc(p.verifier || "-")}</td></tr></table>
<p style="font-size:12px;color:#444">Computer-generated receipt for a verified payment.</p></section>`;
    sendHtml(res, page(`Receipt ${p.receipt_no}`, html), req.query.dl ? `${p.receipt_no}.html` : null);
  }));

  /* =====================================================  state for the UI */
  stateExtenders.push((S, u) => {
    const admin = u.role === "admin", student = u.role === "student";
    // exam seating
    S.sessions = q("SELECT e.id,e.subject,e.date,e.time,(SELECT COUNT(*) FROM seats s WHERE s.session_id=e.id) allocated FROM exam_sessions e ORDER BY e.date,e.time");
    S.rooms = admin ? q("SELECT id,name,capacity FROM rooms ORDER BY id") : [];
    if (student) S.myseats = q("SELECT st.session_id, r.name room, st.seat_no seat FROM seats st JOIN rooms r ON r.id=st.room_id WHERE st.user_id=?", u.id);
    // appointments
    const sl = `SELECT s.id,s.date,s.time,s.status,s.purpose,s.notes,s.followup,s.student_id,s.faculty_id,f.name faculty,st.name student FROM slots s JOIN users f ON f.id=s.faculty_id LEFT JOIN users st ON st.id=s.student_id`;
    if (student) S.slots = q(`${sl} WHERE (s.status='available' AND s.date>=?) OR s.student_id=? ORDER BY s.date,s.time`, today(), u.id).map(s => ({ ...s, mine: s.student_id === u.id, student: undefined }));
    else if (u.role === "faculty") S.slots = q(`${sl} WHERE s.faculty_id=? ORDER BY s.date,s.time`, u.id);
    else S.slots = [];
    // library
    S.finePerDay = FINE_PER_DAY; S.loanDays = LOAN_DAYS;
    S.books = q("SELECT * FROM books ORDER BY title").map(b => {
      const mine = student ? activeLoan(b.id, u.id) : null;
      const wl = student ? one("SELECT id FROM waitlist WHERE book_id=? AND user_id=?", b.id, u.id) : null;
      return { id: b.id, title: b.title, author: b.author, subject: b.subject, copies: b.copies, available: available(b),
        waiting: one("SELECT COUNT(*) c FROM waitlist WHERE book_id=?", b.id).c,
        my: mine ? { id: mine.id, status: mine.status, due: mine.due } : null,
        onWaitlist: !!wl, position: wl ? one("SELECT COUNT(*) c FROM waitlist WHERE book_id=? AND id<=?", b.id, wl.id).c : 0 };
    });
    const loanMap = l => {
      const late = l.status === "borrowed" ? Math.max(0, dayDiff(today(), l.due)) : 0;
      return { id: l.id, title: l.title, student: l.student, status: l.status, reserved_on: l.reserved_on, due: l.due, returned_on: l.returned_on, overdue: late, fine: l.status === "borrowed" ? late * FINE_PER_DAY : l.fine };
    };
    const ln = "SELECT l.*, b.title, x.name student FROM loans l JOIN books b ON b.id=l.book_id JOIN users x ON x.id=l.user_id";
    if (student) S.myloans = q(`${ln} WHERE l.user_id=? AND l.status<>'cancelled' ORDER BY l.id DESC LIMIT 50`, u.id).map(loanMap);
    if (admin) S.loans = q(`${ln} WHERE l.status IN ('reserved','borrowed') ORDER BY l.id`).map(loanMap);
    // fees
    S.fees = feeRows(admin ? "" : "WHERE f.user_id=?", admin ? [] : [u.id]);
    S.feeTotals = totals(S.fees);
    if (student || admin) {
      S.payments = q(`SELECT p.id,p.fee_id,p.amount,p.method,p.reference,p.paid_on,p.verified,p.receipt_no,f.category,f.description,x.name student
        FROM payments p JOIN fees f ON f.id=p.fee_id JOIN users x ON x.id=p.user_id ${admin ? "" : "WHERE p.user_id=?"} ORDER BY p.id DESC LIMIT 200`, ...(admin ? [] : [u.id]))
        .map(p => ({ ...p, verified: !!p.verified }));
    }
  });

  /* =====================================================  demo data */
  function seed() {
    if (process.env.SEED_DEMO === "0" || one("SELECT id FROM rooms LIMIT 1")) return;
    const id = e => (one("SELECT id FROM users WHERE email=?", e) || {}).id;
    const fac = id("faculty@uei.edu"), stu = id("student@uei.edu"), admin = id("admin@uei.edu"), ani = id("anita@uei.edu"), kar = id("karan@uei.edu");
    if (!fac || !stu || !admin) return;
    run("INSERT INTO rooms(name,capacity) VALUES('Hall A-101',2)"); run("INSERT INTO rooms(name,capacity) VALUES('Hall B-202',30)");
    run("INSERT INTO exam_sessions(subject,date,time) VALUES(?,?,?)", SUBJECTS[1], addDays(5), "10:00");
    run("INSERT INTO exam_sessions(subject,date,time) VALUES(?,?,?)", SUBJECTS[0], addDays(11), "14:00");
    allocateExam(one("SELECT * FROM exam_sessions ORDER BY id LIMIT 1"));
    [[1, "15:00"], [1, "15:30"], [2, "11:00"], [3, "16:00"]].forEach(([d, t]) => run("INSERT INTO slots(faculty_id,date,time) VALUES(?,?,?)", fac, addDays(d), t));
    run("INSERT INTO slots(faculty_id,date,time,student_id,purpose,status) VALUES(?,?,?,?,?,'booked')", fac, addDays(1), "16:00", stu, "Project review");
    [["Introduction to Algorithms", "Cormen, Leiserson, Rivest, Stein", SUBJECTS[0], 3], ["Database System Concepts", "Silberschatz, Korth, Sudarshan", SUBJECTS[1], 2],
     ["Operating System Concepts", "Silberschatz, Galvin, Gagne", SUBJECTS[2], 1], ["Eloquent JavaScript", "Marijn Haverbeke", SUBJECTS[3], 2],
     ["Pattern Recognition and Machine Learning", "Christopher Bishop", SUBJECTS[4], 1], ["Clean Code", "Robert C. Martin", SUBJECTS[3], 2]]
      .forEach(b => run("INSERT INTO books(title,author,subject,copies) VALUES(?,?,?,?)", ...b));
    const osId = one("SELECT id FROM books WHERE title LIKE 'Operating%'").id, mlId = one("SELECT id FROM books WHERE title LIKE 'Pattern%'").id;
    if (kar) run("INSERT INTO loans(book_id,user_id,status,reserved_on,due) VALUES(?,?,'borrowed',?,?)", osId, kar, addDays(-17), addDays(-3));
    if (ani) run("INSERT INTO loans(book_id,user_id,status,reserved_on,due) VALUES(?,?,'borrowed',?,?)", mlId, ani, addDays(-11), addDays(3));
    run("INSERT INTO waitlist(book_id,user_id) VALUES(?,?)", osId, stu);
    const fee = (uid, c, d, a, due) => run("INSERT INTO fees(user_id,category,description,amount,due) VALUES(?,?,?,?,?)", uid, c, d, a, addDays(due)).lastInsertRowid;
    const pay = (fid, uid, amt, m, ref, ver) => {
      const pid = run("INSERT INTO payments(fee_id,user_id,amount,method,reference,paid_on,recorded_by,verified,verified_by,receipt_no) VALUES(?,?,?,?,?,?,?,?,?,?)",
        fid, uid, amt, m, ref, today(), admin, ver ? 1 : 0, ver ? admin : null, null).lastInsertRowid;
      if (ver) run("UPDATE payments SET receipt_no=? WHERE id=?", receiptNo(pid), pid);
    };
    const t1 = fee(stu, "Tuition", "Semester tuition fee", 45000, 10); pay(t1, stu, 20000, "UPI", "UPI-882140", true);
    const l1 = fee(stu, "Lab charges", "Computer lab charges", 1500, -2); pay(l1, stu, 1500, "Cash", "Desk receipt 41", false);
    fee(stu, "Library fine", "Overdue 30 day(s): Computer Networks", 60, 7);
    [ani, kar].filter(Boolean).forEach(uid => fee(uid, "Tuition", "Semester tuition fee", 45000, 10));
  }

  return { seed };
};
