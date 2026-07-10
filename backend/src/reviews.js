// Post-trip reviews + supplier scoring loop.
//
// The brief: "Collect reviews and score suppliers after the trip" and "Use data
// to improve future recommendations". Reviews feed supplier average scores; the
// recommender blends those live scores back into the supplier reliabilityScore
// so good suppliers surface more often over time.

import { addReview, supplierScores, reviewsForSupplier } from './store.js';

// Blend a supplier's catalogue reliability with its live review average.
// Returns an adjusted reliability 0-100.
export function adjustedReliability(baseReliability, supplier) {
  const scores = supplierScores().find((s) => s.supplier === supplier);
  if (!scores || !scores.count) return baseReliability;
  // Review avg is 1-5 -> map to 0-100, weight by review volume (caps at 0.5).
  const reviewScore = (scores.avg / 5) * 100;
  const weight = Math.min(0.5, scores.count * 0.1);
  return Math.round(baseReliability * (1 - weight) + reviewScore * weight);
}

export function submitReview(payload) {
  if (!payload.supplier) return { ok: false, error: 'supplier-required' };
  // Rating must be a real 1..5 value — REJECT anything else instead of coercing
  // it up to 1 star (a missing/NaN rating used to become a genuine 1-star review
  // that dragged the supplier's score down).
  const n = Number(payload.rating);
  if (!Number.isFinite(n) || n < 1 || n > 5) return { ok: false, error: 'invalid-rating', message: 'Rating must be between 1 and 5.' };
  const rating = Math.round(n);
  const review = addReview({ ...payload, rating });
  return { ok: true, review, supplierAvg: supplierScores().find((s) => s.supplier === payload.supplier)?.avg };
}

export function leaderboard() {
  return supplierScores().map((s) => ({
    supplier: s.supplier,
    avgRating: s.avg,
    reviews: s.count,
  }));
}

export { reviewsForSupplier };
