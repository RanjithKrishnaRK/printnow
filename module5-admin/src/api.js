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

export async function getPaymentFees(token) {
  const res = await fetch(`${BASE_URL}/api/admin/settings/payment-fees`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return handle(res); // { serviceFeePercent, serviceFeeEnabled, serviceFeeTier1Flat, serviceFeeTier2Flat, gatewayFeePercent, gatewayFeeEnabled, gatewayFeeTier1Flat, gatewayFeeTier2Flat }
}

export async function updatePaymentFees(token, fees) {
  const res = await fetch(`${BASE_URL}/api/admin/settings/payment-fees`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(fees),
  });
  return handle(res);
}

export async function getUploadFlags(token) {
  const res = await fetch(`${BASE_URL}/api/admin/settings/upload-flags`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return handle(res); // { docxConversionEnabled, imageConversionEnabled }
}

export async function updateUploadFlags(token, flags) {
  const res = await fetch(`${BASE_URL}/api/admin/settings/upload-flags`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(flags),
  });
  return handle(res);
}

export async function getActiveGateway(token) {
  const res = await fetch(`${BASE_URL}/api/admin/settings/payment-gateway`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return handle(res); // { activeGateway: 'razorpay' | 'cashfree' }
}

export async function setActiveGateway(token, activeGateway) {
  const res = await fetch(`${BASE_URL}/api/admin/settings/payment-gateway`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ activeGateway }),
  });
  return handle(res);
}

export async function getShopCommissionPayments(token, shopId) {
  const res = await fetch(`${BASE_URL}/api/admin/shops/${shopId}/commission-payments`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return handle(res); // [{ id, shopId, amount, paidDate, mode, note, createdAt }]
}

export async function createCommissionPayment(token, shopId, payment) {
  const res = await fetch(`${BASE_URL}/api/admin/shops/${shopId}/commission-payments`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payment),
  });
  return handle(res);
}

export async function updateCommissionPayment(token, id, payment) {
  const res = await fetch(`${BASE_URL}/api/admin/commission-payments/${id}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payment),
  });
  return handle(res);
}

export async function deleteCommissionPayment(token, id) {
  const res = await fetch(`${BASE_URL}/api/admin/commission-payments/${id}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
  return handle(res);
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

export async function getAllReviews(token) {
  const res = await fetch(`${BASE_URL}/api/admin/reviews`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return handle(res); // [{ id, shopId, shopName, rating, comment, authorName, source, visible, createdAt }]
}

export async function createReviewForShop(token, { shopId, rating, comment, authorName }) {
  const res = await fetch(`${BASE_URL}/api/admin/reviews`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ shopId, rating, comment, authorName }),
  });
  return handle(res);
}

export async function getShopStats(token, shopId) {
  const res = await fetch(`${BASE_URL}/api/admin/shops/${shopId}/stats`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return handle(res); // { totalEarnings, todayEarnings, totalByMethod: {cash, online}, todayByMethod, settledTotal, unsettledOnline, ... }
}

export async function generateShopTempPassword(token, shopId) {
  const res = await fetch(`${BASE_URL}/api/admin/shops/${shopId}/temp-password`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  return handle(res); // { tempPassword, expiresAt }
}

export async function getShopSettlements(token, shopId) {
  const res = await fetch(`${BASE_URL}/api/admin/shops/${shopId}/settlements`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return handle(res); // [{ id, shopId, amount, settledDate, mode, note, createdAt, updatedAt }]
}

export async function createSettlement(token, shopId, { amount, settledDate, mode, note }) {
  const res = await fetch(`${BASE_URL}/api/admin/shops/${shopId}/settlements`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ amount, settledDate, mode, note }),
  });
  return handle(res);
}

export async function updateSettlement(token, settlementId, patch) {
  const res = await fetch(`${BASE_URL}/api/admin/settlements/${settlementId}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(patch),
  });
  return handle(res);
}

export async function deleteSettlement(token, settlementId) {
  const res = await fetch(`${BASE_URL}/api/admin/settlements/${settlementId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
  return handle(res); // { ok: true }
}

export async function getUsers(token, query = "") {
  const qs = query ? `?q=${encodeURIComponent(query)}` : "";
  const res = await fetch(`${BASE_URL}/api/admin/users${qs}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return handle(res); // [{ phone, name, totalJobs, totalSpent, shopsUsed, lastOrderAt }]
}

export async function getUserDetail(token, phone) {
  const res = await fetch(`${BASE_URL}/api/admin/users/${encodeURIComponent(phone)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return handle(res); // { phone, name, totalJobs, totalSpent, byShop: [...], orders: [...] }
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

export async function moveReview(token, reviewId, direction) {
  const res = await fetch(`${BASE_URL}/api/admin/reviews/${reviewId}/move`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ direction }),
  });
  return handle(res); // { ok: true, moved: boolean }
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
