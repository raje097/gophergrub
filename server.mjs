import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import cookieParser from "cookie-parser";
import { Low } from "lowdb";
import { JSONFile } from "lowdb/node";
import { nanoid } from "nanoid";

const app = express();
const PORT = process.env.PORT || 3000;

// OpenAI
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MODERATION_FAIL_CLOSED = process.env.MODERATION_FAIL_CLOSED === "true";
const SUMMARY_FAIL_CLOSED = process.env.SUMMARY_FAIL_CLOSED === "true"; // optional
const OPENAI_SUMMARY_MODEL = process.env.OPENAI_SUMMARY_MODEL || "gpt-4o-mini";

// __dirname for ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------- DB (lowdb) ----------
const dbFile = path.join(__dirname, "db.json");
const adapter = new JSONFile(dbFile);
const db = new Low(adapter, {
  reviews: [],
  lastResetDate: null,
  votes: {},
  aiSummaries: {}, // { "YYYY-MM-DD": { "Hall Name": { summary, createdAt, reviewCount } } }
});

function chicagoTodayKey(date = new Date()) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return formatter.format(date); // YYYY-MM-DD
}

async function ensureDbShape() {
  await db.read();
  db.data ||= { reviews: [], lastResetDate: null, votes: {}, aiSummaries: {} };

  if (!Array.isArray(db.data.reviews)) db.data.reviews = [];
  if (!("lastResetDate" in db.data)) db.data.lastResetDate = null;
  if (typeof db.data.votes !== "object" || db.data.votes === null) db.data.votes = {};
  if (typeof db.data.aiSummaries !== "object" || db.data.aiSummaries === null) db.data.aiSummaries = {};

  await db.write();
}

async function resetIfNewChicagoDay() {
  await db.read();
  db.data ||= { reviews: [], lastResetDate: null, votes: {}, aiSummaries: {} };

  const today = chicagoTodayKey();
  if (db.data.lastResetDate !== today) {
    db.data.reviews = [];
    db.data.votes = {};
    db.data.lastResetDate = today;

    // Optional: also clear AI summaries daily (they’re keyed by date anyway)
    // db.data.aiSummaries = {};

    await db.write();
    console.log(`[daily-reset] Cleared reviews/votes for new day (CT): ${today}`);
  }
}

// ---------- Middleware ----------
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, "public")));
app.set("trust proxy", 1);

// Anonymous “person id” cookie (no account)
app.use((req, res, next) => {
  let id = req.cookies.ggid;
  if (!id) {
    id = nanoid();
    res.cookie("gggid", id, {
      httpOnly: true,
      sameSite: "lax",
      secure: req.secure,
      maxAge: 1000 * 60 * 60 * 24 * 365,
    });
    // NOTE: keep backward compatibility if you previously used "ggid"
    res.cookie("ggid", id, {
      httpOnly: true,
      sameSite: "lax",
      secure: req.secure,
      maxAge: 1000 * 60 * 60 * 24 * 365,
    });
  }
  req.ggid = id;
  next();
});

// ---------- Helpers ----------
const DINING_HALLS = [
  "17th Avenue Hall",
  "Bailey Hall",
  "Comstock Dining Hall",
  "Pioneer Hall",
  "Sanford Hall",
];

function isValidHall(name) {
  return DINING_HALLS.includes(name);
}

function isIntInRange(n, min, max) {
  return Number.isInteger(n) && n >= min && n <= max;
}

function normalizeVoteCounts(review) {
  review.upvotes = Number.isInteger(review.upvotes) ? review.upvotes : 0;
  review.downvotes = Number.isInteger(review.downvotes) ? review.downvotes : 0;
}

// ---------- Moderation ----------
async function moderateText(text) {
  if (!OPENAI_API_KEY) return { allowed: true, status: "skipped_no_key" };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);

  try {
    const resp = await fetch("https://api.openai.com/v1/moderations", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "omni-moderation-latest",
        input: text,
      }),
    });

    if (!resp.ok) {
      const bodyText = await resp.text().catch(() => "");
      console.error("[moderation] Non-OK response:", resp.status, bodyText);

      if (resp.status === 429) {
        return {
          allowed: !MODERATION_FAIL_CLOSED,
          status: MODERATION_FAIL_CLOSED ? "blocked_rate_limited" : "allowed_rate_limited",
        };
      }

      return {
        allowed: !MODERATION_FAIL_CLOSED,
        status: MODERATION_FAIL_CLOSED ? "blocked_error" : "allowed_error",
      };
    }

    const data = await resp.json();
    const result = data?.results?.[0];
    const flagged = Boolean(result?.flagged);

    return { allowed: !flagged, status: flagged ? "blocked_flagged" : "allowed_ok" };
  } catch (err) {
    const msg = err?.name === "AbortError" ? "timeout" : String(err);
    console.error("[moderation] Request failed:", msg);

    return {
      allowed: !MODERATION_FAIL_CLOSED,
      status: MODERATION_FAIL_CLOSED ? "blocked_unavailable" : "allowed_unavailable",
    };
  } finally {
    clearTimeout(timeout);
  }
}

// ---------- AI Summary (Responses API) ----------
function buildSummaryPrompt({ hall, reviews }) {
  // We only pass in the content we need. Keep it short to reduce tokens/cost.
  const lines = reviews
    .slice(0, 25) // cap for cost
    .map((r) => `- Rating ${r.rating}/5: ${r.comment}`)
    .join("\n");

  return [
    `You are writing a short daily summary for a dining hall review website for University of Minnesota students.`,
    `Summarize today's feedback for: ${hall}.`,
    ``,
    `Rules:`,
    `- Output 2–3 sentences max.`,
    `- Be neutral and helpful.`,
    `- Do NOT include names, personal info, or quotes. Paraphrase.`,
    `- If feedback is mixed, say so.`,
    `- If there isn't enough info, say "Not enough reviews yet to summarize."`,
    ``,
    `Today's reviews:`,
    lines || "(none)",
  ].join("\n");
}

async function generateHallSummary(hall, reviews) {
  if (!OPENAI_API_KEY) {
    return { ok: false, code: "no_api_key", summary: null };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6000);

  try {
    const prompt = buildSummaryPrompt({ hall, reviews });

    // Responses API (text generation) :contentReference[oaicite:2]{index=2}
    const resp = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: OPENAI_SUMMARY_MODEL,
        input: prompt,
        max_output_tokens: 120,
      }),
    });

    if (!resp.ok) {
      const bodyText = await resp.text().catch(() => "");
      console.error("[ai-summary] Non-OK response:", resp.status, bodyText);

      if (resp.status === 429) {
        return { ok: false, code: "rate_limited", summary: null };
      }
      return { ok: false, code: "openai_error", summary: null };
    }

    const data = await resp.json();

    // The Responses API returns output in an array; safest is to extract all text parts.
    // We'll attempt common shapes; if it changes, fallback gracefully.
    let text = "";
    const output = data?.output ?? [];
    for (const item of output) {
      const content = item?.content ?? [];
      for (const c of content) {
        if (c?.type === "output_text" && typeof c?.text === "string") {
          text += c.text;
        }
      }
    }

    text = (text || "").trim();

    if (!text) return { ok: false, code: "empty_output", summary: null };

    // Hard cap
    if (text.length > 500) text = text.slice(0, 500).trim();

    return { ok: true, code: "ok", summary: text };
  } catch (err) {
    const msg = err?.name === "AbortError" ? "timeout" : String(err);
    console.error("[ai-summary] Request failed:", msg);
    return { ok: false, code: err?.name === "AbortError" ? "timeout" : "network_error", summary: null };
  } finally {
    clearTimeout(timeout);
  }
}

function shouldRegenerateSummary({ existing, reviewCount }) {
  // Don’t churn cost: only regenerate if review count increased by 3+
  if (!existing) return true;
  const prevCount = existing.reviewCount ?? 0;
  return reviewCount >= prevCount + 3;
}

// ---------- API ----------
app.get("/api/halls", (req, res) => {
  res.json({ halls: DINING_HALLS });
});

app.get("/api/reviews", async (req, res) => {
  await db.read();
  const reviews = db.data.reviews ?? [];
  const votes = db.data.votes ?? {};
  const viewerVotes = votes[req.ggid] ?? {};

  const hall = req.query.hall;
  const filtered = hall ? reviews.filter((r) => r.hall === hall) : reviews;

  filtered.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  const withViewerVote = filtered.map((r) => ({
    ...r,
    viewerVote: viewerVotes[r.id] ?? null,
  }));

  res.json({ reviews: withViewerVote });
});

app.post("/api/reviews", async (req, res) => {
  const { hall, rating, comment } = req.body ?? {};

  if (!isValidHall(hall)) {
    return res.status(400).json({ error: "Invalid dining hall.", code: "invalid_hall" });
  }
  if (!isIntInRange(rating, 1, 5)) {
    return res.status(400).json({ error: "Rating must be an integer 1–5.", code: "invalid_rating" });
  }
  if (typeof comment !== "string" || comment.trim().length < 3) {
    return res.status(400).json({ error: "Comment must be at least 3 characters.", code: "invalid_comment" });
  }
  if (comment.length > 500) {
    return res.status(400).json({ error: "Comment must be <= 500 characters.", code: "invalid_comment" });
  }

  const trimmed = comment.trim();
  const mod = await moderateText(trimmed);

  if (!mod.allowed) {
    if (
      mod.status === "blocked_rate_limited" ||
      mod.status === "blocked_unavailable" ||
      mod.status === "blocked_error"
    ) {
      return res.status(503).json({
        error: "Moderation is busy right now. Please wait a moment and try again.",
        code: "moderation_busy",
      });
    }

    return res.status(400).json({
      error: "Your comment was flagged for inappropriate language. Please revise and try again.",
      code: "moderation_flagged",
    });
  }

  const review = {
    id: nanoid(),
    hall,
    rating,
    comment: trimmed,
    createdAt: new Date().toISOString(),
    upvotes: 0,
    downvotes: 0,
  };

  await db.read();
  db.data.reviews.push(review);
  await db.write();

  res.status(201).json({ review: { ...review, viewerVote: null } });
});

app.post("/api/reviews/:id/vote", async (req, res) => {
  const { id } = req.params;
  const { direction } = req.body ?? {};

  if (direction !== "up" && direction !== "down") {
    return res.status(400).json({ error: 'direction must be "up" or "down".' });
  }

  await db.read();
  db.data.votes ||= {};

  const review = db.data.reviews.find((r) => r.id === id);
  if (!review) return res.status(404).json({ error: "Review not found." });

  normalizeVoteCounts(review);

  const ggid = req.ggid;
  db.data.votes[ggid] ||= {};
  const prev = db.data.votes[ggid][id] ?? null;

  if (prev === direction) {
    await db.write();
    return res.json({ review: { ...review, viewerVote: prev } });
  }

  if (prev === "up") review.upvotes = Math.max(0, review.upvotes - 1);
  if (prev === "down") review.downvotes = Math.max(0, review.downvotes - 1);

  if (direction === "up") review.upvotes += 1;
  if (direction === "down") review.downvotes += 1;

  db.data.votes[ggid][id] = direction;

  await db.write();
  res.json({ review: { ...review, viewerVote: direction } });
});

app.get("/api/summary", async (req, res) => {
  await db.read();
  const reviews = db.data.reviews ?? [];

  const byHall = {};
  for (const hall of DINING_HALLS) byHall[hall] = { count: 0, avgRating: null };

  for (const hall of DINING_HALLS) {
    const hallReviews = reviews.filter((r) => r.hall === hall);
    const count = hallReviews.length;
    if (count === 0) continue;

    const sum = hallReviews.reduce((acc, r) => acc + r.rating, 0);
    byHall[hall] = { count, avgRating: Number((sum / count).toFixed(2)) };
  }

  res.json({ byHall, totalReviews: reviews.length });
});

// ✅ NEW: AI summary endpoint (cached per hall per day)
app.get("/api/ai-summary", async (req, res) => {
  const hall = req.query.hall;
  if (typeof hall !== "string" || !isValidHall(hall)) {
    return res.status(400).json({ error: "Invalid dining hall.", code: "invalid_hall" });
  }

  await db.read();
  db.data.aiSummaries ||= {};
  const today = chicagoTodayKey();
  db.data.aiSummaries[today] ||= {};
  const existing = db.data.aiSummaries[today][hall] || null;

  const hallReviews = (db.data.reviews ?? []).filter((r) => r.hall === hall);

  // Require a minimum number of reviews to summarize (keeps it meaningful + cheaper)
  const MIN_REVIEWS = 3;
  if (hallReviews.length < MIN_REVIEWS) {
    return res.json({
      hall,
      date: today,
      summary: "Not enough reviews yet to summarize.",
      cached: true,
      code: "not_enough_reviews",
      reviewCount: hallReviews.length,
    });
  }

  // Use cached summary unless enough new reviews came in
  if (existing && !shouldRegenerateSummary({ existing, reviewCount: hallReviews.length })) {
    return res.json({
      hall,
      date: today,
      summary: existing.summary,
      cached: true,
      code: "cached",
      reviewCount: existing.reviewCount ?? hallReviews.length,
    });
  }

  const result = await generateHallSummary(hall, hallReviews);

  if (!result.ok) {
    // If summary generation fails and we have an existing cached one, serve it.
    if (existing?.summary) {
      return res.json({
        hall,
        date: today,
        summary: existing.summary,
        cached: true,
        code: "cached_fallback",
        reviewCount: existing.reviewCount ?? hallReviews.length,
      });
    }

    if (SUMMARY_FAIL_CLOSED) {
      return res.status(503).json({
        error: "AI summary is unavailable right now. Please try again later.",
        code: "ai_summary_unavailable",
      });
    }

    return res.json({
      hall,
      date: today,
      summary: "AI summary is unavailable right now.",
      cached: false,
      code: "ai_summary_unavailable",
      reviewCount: hallReviews.length,
    });
  }

  // Save to cache
  db.data.aiSummaries[today][hall] = {
    summary: result.summary,
    createdAt: new Date().toISOString(),
    reviewCount: hallReviews.length,
    model: OPENAI_SUMMARY_MODEL,
  };
  await db.write();

  return res.json({
    hall,
    date: today,
    summary: result.summary,
    cached: false,
    code: "generated",
    reviewCount: hallReviews.length,
  });
});

// fallback
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Boot
await ensureDbShape();
await resetIfNewChicagoDay();
setInterval(() => resetIfNewChicagoDay().catch(console.error), 5 * 60 * 1000);

app.listen(PORT, () => {
  console.log(`GopherGrub running at http://localhost:${PORT}`);
  console.log(`[moderation] enabled=${Boolean(OPENAI_API_KEY)} failClosed=${MODERATION_FAIL_CLOSED}`);
  console.log(`[ai-summary] model=${OPENAI_SUMMARY_MODEL} enabled=${Boolean(OPENAI_API_KEY)} failClosed=${SUMMARY_FAIL_CLOSED}`);
});