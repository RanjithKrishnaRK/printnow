// API layer for Module 5 (Admin panel). Unlike Modules 1 & 2, there's no
// mock mode here - an admin panel with fake data isn't useful even for a
// demo, so this always talks to the real Module 3 backend.

const BASE_URL = import.meta.env.VITE_API_BASE_URL || "http://localhost:4000";

async function handle(res) {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed (${res.status})`);
  }
  return res.json();
}

export async function login(email, password) {
  const res = await fetch(`${BASE_URL}/api/admin/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  return handle(res); // { token, email }
}

export async function changePassword(token, currentPassword, newPassword) {
  const res = await fetch(`${BASE_URL}/api/admin/change-password`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ currentPassword, newPassword }),
  });
  return handle(res); // { ok: true }
}

export async function getStats(token) {
  const res = await fetch(`${BASE_URL}/api/admin/stats`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return handle(res);
}

export async function getShops(token) {
  const res = await fetch(`${BASE_URL}/api/admin/shops`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return handle(res);
}

export async function deleteShop(token, shopId) {
  const res = await fetch(`${BASE_URL}/api/admin/shops/${shopId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
  return handle(res); // { ok: true, shopId }
}

export async function getLandmarks(token) {
  const res = await fetch(`${BASE_URL}/api/admin/landmarks`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return handle(res);
}

export async function createLandmark(token, name) {
  const res = await fetch(`${BASE_URL}/api/admin/landmarks`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ name }),
  });
  return handle(res);
}

export async function deleteLandmark(token, landmarkId) {
  const res = await fetch(`${BASE_URL}/api/admin/landmarks/${landmarkId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
  return handle(res); // { ok: true, shopsUnassigned }
}

export async function getShopStats(token, shopId) {
  const res = await fetch(`${BASE_URL}/api/admin/shops/${shopId}/stats`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return handle(res); // { totalEarnings, todayEarnings, totalByMethod: {cash, upi}, todayByMethod: {cash, upi}, ... }
}

export async function getShopReviews(token, shopId) {
  const res = await fetch(`${BASE_URL}/api/admin/shops/${shopId}/reviews`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return handle(res); // [{ id, rating, comment, authorName, source, visible, createdAt }]
}

export async function createFakeReview(token, shopId, { rating, comment, authorName }) {
  const res = await fetch(`${BASE_URL}/api/admin/shops/${shopId}/reviews`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ rating, comment, authorName }),
  });
  return handle(res);
}

export async function setReviewVisibility(token, reviewId, visible) {
  const res = await fetch(`${BASE_URL}/api/admin/reviews/${reviewId}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ visible }),
  });
  return handle(res);
}

export async function deleteReview(token, reviewId) {
  const res = await fetch(`${BASE_URL}/api/admin/reviews/${reviewId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
  return handle(res); // { ok: true }
}
