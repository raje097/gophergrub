import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { Low } from "lowdb";
import { JSONFile } from "lowdb/node";
import { nanoid } from "nanoid";

const app = express();
const PORT = process.env.PORT || 3000;

// __dirname for ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------- DB (lowdb) ----------
const dbFile = path.join(__dirname, "db.json");
const adapter = new JSONFile(dbFile);
const db = new Low(adapter, { reviews: [], lastResetDate: null });

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
  // en-CA outputs YYYY-MM-DD
  return formatter.format(date);
}

async function ensureDbShape() {
  await db.read();
  db.data ||= { reviews: [], lastResetDate: null };

  // In case an old db.json only had reviews
  if (!Array.isArray(db.data.reviews)) db.data.reviews = [];
  if (!("lastResetDate" in db.data)) db.data.lastResetDate = null;

  await db.write();
}

/**
 * Resets reviews once per day based on America/Chicago date.
 * Runs on startup + periodically while server is running.
 */
async function resetIfNewChicagoDay() {
  await db.read();
  db.data ||= { reviews: [], lastResetDate: null };

  const today = chicagoTodayKey();
  if (db.data.lastResetDate !== today) {
    db.data.reviews = [];
    db.data.lastResetDate = today;
    await db.write();
    console.log(`[daily-reset] Cleared reviews for new day (CT): ${today}`);
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
app.use(express.static(path.join(__dirname, "public")));

// ---------- Helpers ----------
const DINING_HALLS = [
  "Comstock Dining Hall",
  "Pioneer Hall",
  "17th Avenue Dining Center",
  "Centennial Hall",
];

function isValidHall(name) {
  return DINING_HALLS.includes(name);
}

function isIntInRange(n, min, max) {
  return Number.isInteger(n) && n >= min && n <= max;
}

// ---------- API ----------
app.get("/api/halls", (req, res) => {
  res.json({ halls: DINING_HALLS });
});

app.get("/api/reviews", async (req, res) => {
  await db.read();
  const reviews = db.data.reviews ?? [];

  // optional filter: ?hall=Comstock%20Dining%20Hall
  const hall = req.query.hall;
  const filtered = hall ? reviews.filter((r) => r.hall === hall) : reviews;

  // newest first
  filtered.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  res.json({ reviews: filtered });
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

  const review = {
    id: nanoid(),
    hall,
    rating,
    comment: comment.trim(),
    createdAt: new Date().toISOString(),
  };

  await db.read();
  db.data.reviews.push(review);
  await db.write();

  res.status(201).json({ review });
});

app.delete("/api/reviews/:id", async (req, res) => {
  const { id } = req.params;

  await db.read();
  const before = db.data.reviews.length;
  db.data.reviews = db.data.reviews.filter((r) => r.id !== id);

  if (db.data.reviews.length === before) {
    return res.status(404).json({ error: "Review not found." });
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

app.get("/api/reset-info", async (req, res) => {
  await db.read();
  const lastResetDate = db.data?.lastResetDate ?? null;

  res.json({
    timeZone: "America/Chicago",
    resetsAt: "00:00", // midnight
    lastResetDate,
    today: chicagoTodayKey(),
  });
});

// fallback: serve index.html (optional)
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`GopherGrub running at http://localhost:${PORT}`);
});