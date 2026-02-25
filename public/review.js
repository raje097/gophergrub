const form = document.querySelector("#reviewForm");
const hallEl = document.querySelector("#hall");
const ratingEl = document.querySelector("#rating");
const commentEl = document.querySelector("#comment");
const statusEl = document.querySelector("#status");
const charCountEl = document.querySelector("#charCount");

async function fetchJSON(url, opts) {
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed: ${res.status}`);
  return data;
}

function setStatus(msg, ok) {
  statusEl.textContent = msg;
  statusEl.className = `status ${ok ? "ok" : "err"}`;
}

commentEl.addEventListener("input", () => {
  charCountEl.textContent = `${commentEl.value.length} / 500`;
});

async function loadHalls() {
  const { halls } = await fetchJSON("/api/halls");
  hallEl.innerHTML = "";
  for (const hall of halls) {
    const opt = document.createElement("option");
    opt.value = hall;
    opt.textContent = hall;
    hallEl.appendChild(opt);
  }
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  setStatus("", true);

  const payload = {
    hall: hallEl.value,
    rating: Number(ratingEl.value),
    comment: commentEl.value
  };

  try {
    await fetchJSON("/api/reviews", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    setStatus("Review submitted! Redirecting…", true);
    setTimeout(() => (window.location.href = "/"), 700);
  } catch (err) {
    setStatus(err.message, false);
  }
});

await loadHalls();
charCountEl.textContent = `${commentEl.value.length} / 500`;