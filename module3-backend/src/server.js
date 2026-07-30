// src/server.js
const app = require('./app');
const { PORT } = require('./config');
const { migrate, pool } = require('./db');

async function start() {
  try {
    await pool.query('SELECT 1'); // fail fast with a clear error if Postgres isn't reachable
  } catch (err) {
    console.error('Could not connect to Postgres. Is it running, and is DATABASE_URL correct in .env?');
    console.error(err.message);
    process.exit(1);
  }

  await migrate();

  app.listen(PORT, () => {
    console.log(`Module 3 backend listening on http://localhost:${PORT}`);
  });
}

start();
