const summaryEl = document.querySelector("#summary");
const topHallEl = document.querySelector("#topHall");
const reviewsEl = document.querySelector("#reviews");
const hallFilterEl = document.querySelector("#hallFilter");
const sortSelectEl = document.querySelector("#sortSelect");

function stars(n) {
  return "★★★★★☆☆☆☆☆".slice(5 - n, 10 - n);
}

function fmtDate(iso) {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

async function fetchJSON(url, opts) {
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed: ${res.status}`);
  return data;
}

// basic HTML escaping for safety
function escapeHTML(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function loadHalls() {
  const { halls } = await fetchJSON("/api/halls");

  hallFilterEl.innerHTML = "";
  const allOpt = document.createElement("option");
  allOpt.value = "";
  allOpt.textContent = "All halls";
  hallFilterEl.appendChild(allOpt);

  for (const hall of halls) {
    const opt = document.createElement("option");
    opt.value = hall;
    opt.textContent = hall;
    hallFilterEl.appendChild(opt);
  }

  return halls;
}

async function loadSummary() {
  const { byHall, totalReviews } = await fetchJSON("/api/summary");

  // Top dining hall of the day: highest avgRating, tie-break by most reviews
  const hallEntries = Object.entries(byHall).map(([hall, s]) => ({
    hall,
    count: s.count,
    avg: s.avgRating,
  }));

  const candidates = hallEntries.filter((h) => h.count > 0 && typeof h.avg === "number");

  if (candidates.length === 0) {
    topHallEl.innerHTML = `<div class="muted">No top hall yet — be the first to review today.</div>`;
  } else {
    candidates.sort((a, b) => {
      if (b.avg !== a.avg) return b.avg - a.avg;
      return b.count - a.count;
    });

    const top = candidates[0];
    topHallEl.innerHTML = `
      <div class="topHallBadge">
        <span class="topHallLabel">Top dining hall today</span>
        <span class="topHallName">${escapeHTML(top.hall)}</span>
        <span class="topHallMeta">${top.avg.toFixed(2)} / 5 • ${top.count} review${top.count === 1 ? "" : "s"}</span>
      </div>
    `;
  }

  // Render the hall list with placeholders for AI summary
  const rows = hallEntries.map((h) => {
    const avgText = h.avg == null ? "—" : `${h.avg} / 5`;
    const safeHall = escapeHTML(h.hall);

    return `<div class="review">
      <div class="reviewTop">
        <strong>${safeHall}</strong>
        <span class="badge">${h.count} review${h.count === 1 ? "" : "s"}</span>
      </div>
      <div class="muted">Average: ${avgText}</div>

      <div class="aiLine">
        <span class="aiChip">AI</span>
        <span class="aiSummary" data-hall="${escapeHTML(h.hall)}">Loading summary…</span>
      </div>
    </div>`;
  });

  summaryEl.innerHTML = `
    <div class="muted small">Total reviews today: ${totalReviews}</div>
    <div class="reviews" style="margin-top:10px">${rows.join("")}</div>
  `;

  // Fill AI summaries AFTER the HTML is on the page
  await fillAiSummaries(hallEntries.map((h) => h.hall));
}

async function fillAiSummaries(halls) {
  // For each hall, fetch /api/ai-summary and place text into matching element
  // Do them in parallel to keep it fast.
  const tasks = halls.map(async (hall) => {
    const el = summaryEl.querySelector(`.aiSummary[data-hall="${CSS.escape(hall)}"]`);
    if (!el) return;

    try {
      const data = await fetchJSON(`/api/ai-summary?hall=${encodeURIComponent(hall)}`);
      el.textContent = data.summary || "No summary available.";
    } catch (err) {
      // Don't crash the page if AI summary fails
      el.textContent = "AI summary unavailable.";
    }
  });

  await Promise.all(tasks);
}

async function vote(id, direction) {
  await fetchJSON(`/api/reviews/${id}/vote`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ direction }),
  });

  await loadSummary();
  await loadReviews();
}

function sortReviews(reviews) {
  const mode = sortSelectEl.value;

  if (mode === "newest") {
    return [...reviews].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  }

  // "top" = vote score first (up - down), then upvotes, then rating, then newest
  return [...reviews].sort((a, b) => {
    const aUp = Number.isInteger(a.upvotes) ? a.upvotes : 0;
    const aDown = Number.isInteger(a.downvotes) ? a.downvotes : 0;
    const bUp = Number.isInteger(b.upvotes) ? b.upvotes : 0;
    const bDown = Number.isInteger(b.downvotes) ? b.downvotes : 0;

    const aScore = aUp - aDown;
    const bScore = bUp - bDown;

    if (bScore !== aScore) return bScore - aScore;
    if (bUp !== aUp) return bUp - aUp;

    const ar = a.rating ?? 0;
    const br = b.rating ?? 0;
    if (br !== ar) return br - ar;

    return new Date(b.createdAt) - new Date(a.createdAt);
  });
}

async function loadReviews() {
  const hall = hallFilterEl.value;
  const url = hall ? `/api/reviews?hall=${encodeURIComponent(hall)}` : "/api/reviews";
  const { reviews } = await fetchJSON(url);

  const sorted = sortReviews(reviews).slice(0, 5);

  if (sorted.length === 0) {
    reviewsEl.innerHTML = `<div class="muted">No reviews yet today. Be the first!</div>`;
    return;
  }

  reviewsEl.innerHTML = sorted
    .map((r) => {
      const up = Number.isInteger(r.upvotes) ? r.upvotes : 0;
      const down = Number.isInteger(r.downvotes) ? r.downvotes : 0;
      const score = up - down;

      const viewerVote = r.viewerVote; // "up" | "down" | null
      const votedText =
        viewerVote === "up" ? "You voted 👍" :
        viewerVote === "down" ? "You voted 👎" :
        "";

      const disabled = viewerVote !== null;

      return `<div class="review">
        <div class="reviewTop">
          <strong>${escapeHTML(r.hall)}</strong>
          <span class="badge">${stars(r.rating)} (${r.rating})</span>
        </div>
        <div class="muted small">${fmtDate(r.createdAt)}</div>
        <p style="margin:10px 0 0">${escapeHTML(r.comment)}</p>

        <div class="voteRow">
          <button class="voteBtn" data-vote="up" data-id="${r.id}" ${disabled ? "disabled" : ""} aria-label="Upvote">▲</button>
          <button class="voteBtn" data-vote="down" data-id="${r.id}" ${disabled ? "disabled" : ""} aria-label="Downvote">▼</button>
          <span class="voteScore">Score: ${score} (↑${up} / ↓${down})</span>
          ${votedText ? `<span class="voteYou">${votedText}</span>` : ""}
        </div>
      </div>`;
    })
    .join("");
}

hallFilterEl.addEventListener("change", loadReviews);
sortSelectEl.addEventListener("change", loadReviews);

reviewsEl.addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-vote]");
  if (!btn) return;
  if (btn.disabled) return;

  const id = btn.dataset.id;
  const dir = btn.dataset.vote;

  try {
    await vote(id, dir);
  } catch (err) {
    alert(err.message);
  }
});

// Boot
await loadHalls();
await loadSummary();
await loadReviews();