// src/studentName.js
//
// A phone number's name is captured once, the first time that number places
// any order at any shop, and reused after that - see the `students` table
// migration in db.js. This is the single place that logic lives, called by
// both the single-document and batch job-creation routes in shops.js.
const { pool } = require('./db');

class StudentNameRequiredError extends Error {
  constructor() {
    super('This is your first order — please provide your name');
    this.code = 'STUDENT_NAME_REQUIRED';
  }
}

// Returns the name to store on the new job/batch row. Throws
// StudentNameRequiredError if this phone number has never ordered before and
// no name was provided - the student app should never actually hit this in
// practice (it checks GET /api/students/:phone first and shows the name
// field proactively), but the backend enforces it regardless of what the
// client sends.
async function resolveStudentName(phone, providedName) {
  const { rows } = await pool.query('SELECT name FROM students WHERE phone = $1', [phone]);
  if (rows.length > 0) {
    // Known number - the name already on file wins, regardless of what
    // (if anything) was sent this time. Keeps a single source of truth
    // rather than letting every order silently rename someone.
    return rows[0].name;
  }

  const trimmed = typeof providedName === 'string' ? providedName.trim() : '';
  if (!trimmed) {
    throw new StudentNameRequiredError();
  }

  await pool.query(
    // ON CONFLICT DO NOTHING guards a race where the same brand-new phone
    // number submits two orders back-to-back before either INSERT commits -
    // whichever wins becomes the name of record; harmless either way since
    // it's the same person.
    'INSERT INTO students (phone, name) VALUES ($1, $2) ON CONFLICT (phone) DO NOTHING',
    [phone, trimmed]
  );
  return trimmed;
}

module.exports = { resolveStudentName, StudentNameRequiredError };
