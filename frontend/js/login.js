// ─────────────────────────────────────────────────────────────────────────────
// login.js — AgosTech Auth
// Connects to: POST http://localhost:5000/api/auth/login
// Expects response: { token: "...", user: { ... } }  on success
//                   { message: "..." }                on failure
// ─────────────────────────────────────────────────────────────────────────────

const API_BASE = "http://localhost:5000";

async function login() {
  const emailInput  = document.getElementById("email");
  const signInBtn   = document.getElementById("signInBtn");
  const errorMsg    = document.getElementById("errorMsg");
  const errorText   = document.getElementById("errorText");

  const email    = emailInput.value.trim();
  const password = document.getElementById("password").value;

  // ── 1. Client-side validation ──────────────────────────────────────────────
  errorMsg.classList.remove("show");

  if (!email || !password) {
    errorText.textContent = "Please fill in all fields.";
    errorMsg.classList.add("show");
    return;
  }

  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailPattern.test(email)) {
    errorText.textContent = "Please enter a valid email address.";
    errorMsg.classList.add("show");
    return;
  }

  // ── 2. Show loading state ──────────────────────────────────────────────────
  setLoading(true);

  try {
    // ── 3. Hit the backend ───────────────────────────────────────────────────
    const res = await fetch(`${API_BASE}/api/auth/login`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ email, password })
    });

    const data = await res.json();

    // ── 4. Handle success ────────────────────────────────────────────────────
    if (res.ok && data.token) {
      // Persist token — use sessionStorage if "Keep me signed in" is unchecked
      const remember = document.getElementById("remember")?.checked;
      const storage  = remember ? localStorage : sessionStorage;
      storage.setItem("token", data.token);

      // Optional: store user info for the dashboard to use
      if (data.user) {
        storage.setItem("user", JSON.stringify(data.user));
      }

      // Success UI feedback before redirect
      setSuccess();

      setTimeout(() => {
        window.location.href = "/frontend/dashboard.html";
      }, 900);

    } else {
      // ── 5. Handle server-side auth failure ──────────────────────────────────
      const msg = data.message || "Invalid email or password. Please try again.";
      errorText.textContent = msg;
      errorMsg.classList.add("show");
      setLoading(false);
    }

  } catch (err) {
    // ── 6. Handle network / server unreachable errors ────────────────────────
    console.error("[AgosTech] Login error:", err);
    errorText.textContent =
      "Unable to reach the server. Please check your connection and try again.";
    errorMsg.classList.add("show");
    setLoading(false);
  }
}

// ── UI helpers ─────────────────────────────────────────────────────────────────

function setLoading(active) {
  const btn = document.getElementById("signInBtn");
  if (!btn) return;
  btn.disabled = active;
  if (active) {
    btn.classList.add("loading");
  } else {
    btn.classList.remove("loading");
  }
}

function setSuccess() {
  const btn = document.getElementById("signInBtn");
  if (!btn) return;
  btn.classList.remove("loading");
  btn.disabled = true;
  btn.style.background = "#0F7050";
  btn.querySelector(".btn-label").innerHTML = `
    <svg viewBox="0 0 24 24"
         style="width:16px;height:16px;stroke:white;fill:none;
                stroke-width:2.5;stroke-linecap:round;stroke-linejoin:round">
      <polyline points="20 6 9 17 4 12"/>
    </svg>
    Signed in!
  `;
}

document.addEventListener("DOMContentLoaded", () => {
  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.get("pending") === "true") {
    const pendingNotice = document.getElementById("pendingNotice");
    if (pendingNotice) {
      pendingNotice.style.display = "flex";
      pendingNotice.classList.add("show");
    }
  }
});