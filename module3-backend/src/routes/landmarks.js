// src/routes/landmarks.js
//
// Beta "location-based" discovery: not GPS. A landmark (e.g. a college) is
// created by an admin (simulated for now - see db.js, which seeds "Anurag
// University" at boot). A shop registers under one landmark. Students pick a
// landmark on Module 1's home page and see only shops under it.

const express = require('express');
const { pool } = require('../db');

const router = express.Router();

// GET /api/landmarks
// Public. -> [{ id, name }]
router.get('/', async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT id, name FROM landmarks ORDER BY name ASC');
    return res.status(200).json(rows);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
