# Unified Education Interface (Node.js + Express + SQLite)

## Run
```bash
npm install
export SECRET_KEY=any-long-random-string FACULTY_CODE=faculty-invite-2026 ADMIN_CODE=admin-invite-2026
npm start            # http://localhost:3000
```
Needs Node 18+. The database file (`uei.db`) and all tables are created on first run.
With `SEED_DEMO=1` (default) these accounts are created: student@uei.edu / student123, faculty@uei.edu / faculty123, admin@uei.edu / admin12345. Set `SEED_DEMO=0` in production.

## Security
bcrypt password hashes, revocable database-backed sessions in HttpOnly SameSite cookies, role checks on every route, custom-header CSRF guard, validated input, parameterised SQL, login throttling (in memory, use Redis for multiple instances).
Faculty/admin registration requires the invite codes above.

## Production
Run behind HTTPS with `COOKIE_SECURE=1` (and `app.set("trust proxy", 1)` if behind a proxy, so throttling sees real IPs).

## Moving to PostgreSQL / MySQL
All SQL is in `server.js` in simple prepared statements. Swap `better-sqlite3` for `pg` or `mysql2` (queries become async) or adopt an ORM such as Prisma or Sequelize.

## API
`POST /api/register|login|logout` · `GET /api/state` · goals, exams, assignments (+`/submit`), materials, messages, attendance, grades · groups (+`/toggle`), doubts (+`/replies`), shared, profile · `POST /api/career`. The UI is in `public/index.html`.
