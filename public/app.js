const summaryEl = document.querySelector("#summary");
const reviewsEl = document.querySelector("#reviews");
const hallFilterEl = document.querySelector("#hallFilter");

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
}

async function loadSummary() {
  const { byHall, totalReviews } = await fetchJSON("/api/summary");

  const rows = Object.entries(byHall).map(([hall, s]) => {
    const avg = s.avgRating == null ? "—" : `${s.avgRating} / 5`;
    const count = s.count;
    return `<div class="review">
      <div class="reviewTop">
        <strong>${hall}</strong>
        <span class="badge">${count} review${count === 1 ? "" : "s"}</span>
      </div>
      <div class="muted">Average: ${avg}</div>
    </div>`;
  });

  summaryEl.innerHTML = `
    <div class="muted small">Total reviews today: ${totalReviews}</div>
    <div class="reviews" style="margin-top:10px">${rows.join("")}</div>
  `;
}

async function vote(id, direction) {
  await fetchJSON(`/api/reviews/${id}/vote`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ direction })
  });

  await loadSummary();
  await loadReviews();
}

async function loadReviews() {
  const hall = hallFilterEl.value;
  const url = hall ? `/api/reviews?hall=${encodeURIComponent(hall)}` : "/api/reviews";
  const { reviews } = await fetchJSON(url);

  if (reviews.length === 0) {
    reviewsEl.innerHTML = `<div class="muted">No reviews yet today. Be the first!</div>`;
    return;
  }

  reviewsEl.innerHTML = reviews
    .map((r) => {
      const up = Number.isInteger(r.upvotes) ? r.upvotes : 0;
      const down = Number.isInteger(r.downvotes) ? r.downvotes : 0;
      const score = up - down;

      const viewerVote = r.viewerVote; // "up" | "down" | null
      const votedText =
        viewerVote === "up" ? "You voted 👍" :
        viewerVote === "down" ? "You voted 👎" :
        "";

      const upDisabled = viewerVote !== null;   // one vote total
      const downDisabled = viewerVote !== null; // one vote total

      return `<div class="review">
        <div class="reviewTop">
          <strong>${r.hall}</strong>
          <span class="badge">${stars(r.rating)} (${r.rating})</span>
        </div>
        <div class="muted small">${fmtDate(r.createdAt)}</div>
        <p style="margin:10px 0 0">${escapeHTML(r.comment)}</p>

        <div class="voteRow">
          <button class="voteBtn" data-vote="up" data-id="${r.id}" ${upDisabled ? "disabled" : ""} aria-label="Upvote">▲</button>
          <button class="voteBtn" data-vote="down" data-id="${r.id}" ${downDisabled ? "disabled" : ""} aria-label="Downvote">▼</button>
          <span class="voteScore">Score: ${score} (↑${up} / ↓${down})</span>
          ${votedText ? `<span class="voteYou">${votedText}</span>` : ""}
        </div>
      </div>`;
    })
    .join("");
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

hallFilterEl.addEventListener("change", loadReviews);

// One click handler for all vote buttons (event delegation)
reviewsEl.addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-vote]");
  if (!btn) return;

  if (btn.disabled) return;

  const id = btn.dataset.id;
  const dir = btn.dataset.vote; // "up" or "down"

  try {
    await vote(id, dir);
  } catch (err) {
    alert(err.message);
  }
});

await loadHalls();
await loadSummary();
await loadReviews();