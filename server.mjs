import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import cookieParser from "cookie-parser";
import { Low } from "lowdb";
import { JSONFile } from "lowdb/node";
import { nanoid } from "nanoid";

const app = express();
const PORT = process.env.PORT || 3000;

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

async function moderateText(text) {
  // If no key is configured (local dev), allow everything
  if (!OPENAI_API_KEY) return { allowed: true };

  const resp = await fetch("https://api.openai.com/v1/moderations", {
    method: "POST",
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
    // Fail open (allow) or fail closed (block). I'd fail open to avoid breaking submissions.
    // You can change this depending on your preference.
    return { allowed: true, reason: "moderation_unavailable" };
  }

  const data = await resp.json();
  const result = data?.results?.[0];

  // OpenAI moderation returns a "flagged" boolean at the top-level result
  const flagged = Boolean(result?.flagged);

  return { allowed: !flagged, flagged, result };
}

// __dirname for ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------- DB (lowdb) ----------
const dbFile = path.join(__dirname, "db.json");
const adapter = new JSONFile(dbFile);
const db = new Low(adapter, { reviews: [], lastResetDate: null, votes: {} });

/**
 * Returns YYYY-MM-DD for America/Chicago (Central Time),
 * regardless of the server's machine timezone.
 */
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
  db.data ||= { reviews: [], lastResetDate: null, votes: {} };

  if (!Array.isArray(db.data.reviews)) db.data.reviews = [];
  if (!("lastResetDate" in db.data)) db.data.lastResetDate = null;
  if (typeof db.data.votes !== "object" || db.data.votes === null) db.data.votes = {};

  await db.write();
}

/**
 * Resets reviews once per day based on America/Chicago date.
 * Clears votes too (since reviews reset anyway).
 */
async function resetIfNewChicagoDay() {
  await db.read();
  db.data ||= { reviews: [], lastResetDate: null, votes: {} };

  const today = chicagoTodayKey();
  if (db.data.lastResetDate !== today) {
    db.data.reviews = [];
    db.data.votes = {};
    db.data.lastResetDate = today;
    await db.write();
    console.log(`[daily-reset] Cleared reviews/votes for new day (CT): ${today}`);
  }
}

// Initialize DB and run reset check immediately
await ensureDbShape();
await resetIfNewChicagoDay();

// Check every 5 minutes so it resets shortly after midnight CT
setInterval(() => {
  resetIfNewChicagoDay().catch((e) =>
    console.error("[daily-reset] Reset check failed:", e)
  );
}, 5 * 60 * 1000);

// ---------- Middleware ----------
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, "public")));

// Anonymous “person id” cookie (no account)
app.use((req, res, next) => {
  let id = req.cookies.ggid;
  if (!id) {
    id = nanoid();
    res.cookie("ggid", id, {
      httpOnly: true,
      sameSite: "lax",
      secure: false, // set true when using HTTPS in production
      maxAge: 1000 * 60 * 60 * 24 * 365, // 1 year
    });
  }
  req.ggid = id;
  next();
});

// ---------- Helpers ----------
const DINING_HALLS = [
  "Comstock Dining Hall",
  "Pioneer Dining Hall",
  "17th Avenue Dining Hall",
  "Middlebrook Hall",
  "Sanford Hall"
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

// ---------- API ----------
app.get("/api/halls", (req, res) => {
  res.json({ halls: DINING_HALLS });
});

app.get("/api/reviews", async (req, res) => {
  await db.read();
  const reviews = db.data.reviews ?? [];
  const votes = db.data.votes ?? {};
  const viewerVotes = votes[req.ggid] ?? {};

  // optional filter: ?hall=Comstock%20Dining%20Hall
  const hall = req.query.hall;
  const filtered = hall ? reviews.filter((r) => r.hall === hall) : reviews;

  // newest first
  filtered.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  // attach viewerVote so UI can disable buttons
  const withViewerVote = filtered.map((r) => ({
    ...r,
    viewerVote: viewerVotes[r.id] ?? null, // "up" | "down" | null
  }));

  res.json({ reviews: withViewerVote });
});

app.post("/api/reviews", async (req, res) => {
  const { hall, rating, comment } = req.body ?? {};

  if (!isValidHall(hall)) {
    return res.status(400).json({ error: "Invalid dining hall." });
  }
  if (!isIntInRange(rating, 1, 5)) {
    return res.status(400).json({ error: "Rating must be an integer 1–5." });
  }
  if (typeof comment !== "string" || comment.trim().length < 3) {
    return res
      .status(400)
      .json({ error: "Comment must be at least 3 characters." });
  }
  if (comment.length > 500) {
    return res.status(400).json({ error: "Comment must be <= 500 characters." });
  }

  const mod = await moderateText(comment);
  if (!mod.allowed) {
    return res.status(400).json({
      error: "Your comment was flagged for inappropriate language. Please revise and try again.",
    });
  }

  const review = {
    id: nanoid(),
    hall,
    rating,
    comment: comment.trim(),
    createdAt: new Date().toISOString(),
    upvotes: 0,
    downvotes: 0,
  };

  await db.read();
  db.data.reviews.push(review);
  await db.write();

  res.status(201).json({ review: { ...review, viewerVote: null } });
});

/**
 * One-vote-per-person endpoint (anonymous cookie ID).
 * Body: { direction: "up" | "down" }
 *
 * Rules:
 * - First vote applies
 * - Voting same direction again does nothing
 * - Voting opposite direction switches vote (adjusts counts)
 */
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
  const prev = db.data.votes[ggid][id] ?? null; // "up" | "down" | null

  // no-op if same direction
  if (prev === direction) {
    await db.write();
    return res.json({ review: { ...review, viewerVote: prev } });
  }

  // remove previous vote if it existed
  if (prev === "up") review.upvotes = Math.max(0, review.upvotes - 1);
  if (prev === "down") review.downvotes = Math.max(0, review.downvotes - 1);

  // apply new vote
  if (direction === "up") review.upvotes += 1;
  if (direction === "down") review.downvotes += 1;

  db.data.votes[ggid][id] = direction;

  await db.write();
  res.json({ review: { ...review, viewerVote: direction } });
});

app.delete("/api/reviews/:id", async (req, res) => {
  const { id } = req.params;

  await db.read();
  const before = db.data.reviews.length;
  db.data.reviews = db.data.reviews.filter((r) => r.id !== id);

  if (db.data.reviews.length === before) {
    return res.status(404).json({ error: "Review not found." });
  }

  // also clean votes referencing this review (optional but nice)
  if (db.data.votes) {
    for (const ggid of Object.keys(db.data.votes)) {
      if (db.data.votes[ggid] && db.data.votes[ggid][id]) {
        delete db.data.votes[ggid][id];
      }
    }
  }

  await db.write();
  res.json({ ok: true });
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

// fallback: serve index.html (optional)
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`GopherGrub running at http://localhost:${PORT}`);
});