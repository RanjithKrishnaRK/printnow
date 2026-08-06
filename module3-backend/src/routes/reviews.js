// src/routes/reviews.js
//
// The platform-wide review feed shown on the student app's front page
// ("What students are saying"), below My Orders - distinct from a single
// shop's own reviews (see routes/shops.js GET/POST /:shopId/reviews),
// which power that shop's star rating in the browse list. This just
// aggregates every visible review across every shop, newest first, so a
// student sees social proof before they've even picked a shop.
const express = require('express');
const { pool } = require('../db');

const router = express.Router();

// GET /api/reviews
// Public. -> { reviews: [{ id, rating, comment, authorName, shopName, createdAt }] }
// Same `visible` flag as a shop's own review list controls this - hiding a
// review from its shop page also pulls it from this feed, and vice versa;
// there's only one moderation switch to keep track of (see admin.js).
router.get('/', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT r.id, r.rating, r.comment, r.author_name AS "authorName",
              s.name AS "shopName", r.created_at AS "createdAt"
       FROM reviews r
       JOIN shops s ON s.id = r.shop_id
       WHERE r.visible = TRUE
       ORDER BY r.created_at DESC
       LIMIT 30`
    );
    return res.status(200).json({ reviews: rows });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
