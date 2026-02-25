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
    <div class="muted small">Todays Reviews: ${totalReviews}</div>
    <div class="reviews" style="margin-top:10px">${rows.join("")}</div>
  `;
}

async function loadReviews() {
  const hall = hallFilterEl.value;
  const url = hall ? `/api/reviews?hall=${encodeURIComponent(hall)}` : "/api/reviews";
  const { reviews } = await fetchJSON(url);

  if (reviews.length === 0) {
    reviewsEl.innerHTML = `<div class="muted">No reviews yet. Be the first!</div>`;
    return;
  }

  reviewsEl.innerHTML = reviews
    .map(
      (r) => `<div class="review">
        <div class="reviewTop">
          <strong>${r.hall}</strong>
          <span class="badge">${stars(r.rating)} (${r.rating})</span>
        </div>
        <div class="muted small">${fmtDate(r.createdAt)}</div>
        <p style="margin:10px 0 0">${escapeHTML(r.comment)}</p>
      </div>`
    )
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

await loadHalls();
await loadSummary();
await loadReviews();