// ─────────────────────────────────────────────────────────────────────────────
// register.js — AgosTech Registration
// Connects to: POST http://localhost:5000/api/auth/register
// Expects body:    { fullname, email, phone_number, password, role }
// Expects response: { message: "..." }           on success (201)
//                   { message: "..." }           on failure (4xx)
// ─────────────────────────────────────────────────────────────────────────────

const API_BASE = "http://localhost:5000";

async function register() {
  // ── 1. Grab values ─────────────────────────────────────────────────────────
  const fullname = document.getElementById("fullname").value.trim();
  const email    = document.getElementById("email").value.trim();
  const phone    = document.getElementById("phone").value.trim();
  const role     = document.getElementById("role").value;
  const password = document.getElementById("password").value;
  const confirm  = document.getElementById("confirmPassword").value;
  const terms    = document.getElementById("terms").checked;

  const errorMsg  = document.getElementById("errorMsg");
  const errorText = document.getElementById("errorText");

  // ── 2. Client-side validation ──────────────────────────────────────────────
  errorMsg.classList.remove("show");
  clearHints();

  let hasError = false;

  if (!fullname) {
    showHint("fullname-hint", "Full name is required.", "err");
    hasError = true;
  }

  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!email) {
    showHint("email-hint", "Email address is required.", "err");
    hasError = true;
  } else if (!emailPattern.test(email)) {
    showHint("email-hint", "Please enter a valid email address.", "err");
    hasError = true;
  }

  if (phone && !/^(09|\+639)\d{9}$/.test(phone)) {
    showHint("phone-hint", "Enter a valid PH number (e.g. 09XXXXXXXXX).", "err");
    hasError = true;
  }

  if (!role) {
    showHint("role-hint", "Please select your role.", "err");
    hasError = true;
  }

  if (!password) {
    errorText.textContent = "Password is required.";
    errorMsg.classList.add("show");
    hasError = true;
  } else if (password.length < 8) {
    errorText.textContent = "Password must be at least 8 characters.";
    errorMsg.classList.add("show");
    hasError = true;
  }

  if (password && password !== confirm) {
    errorText.textContent = "Passwords do not match.";
    errorMsg.classList.add("show");
    hasError = true;
  }

  if (!terms) {
    errorText.textContent = "You must agree to the Terms of Use to continue.";
    errorMsg.classList.add("show");
    hasError = true;
  }

  if (hasError) return;

  // ── 3. Show loading state ──────────────────────────────────────────────────
  setLoading(true);

  try {
    // ── 4. POST to backend ────────────────────────────────────────────────────
    const res = await fetch(`${API_BASE}/api/auth/register`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fullname,
        email,
        phone_number: phone || null,
        password,
        role
      })
    });

    const data = await res.json();

    // ── 5. Handle success ─────────────────────────────────────────────────────
    if (res.ok || res.status === 201) {
      setLoading(false);
      setSuccess(data.message || "Account registered successfully!");

      setTimeout(() => {
        if (data.pending) {
          window.location.href = "login.html?pending=true";
        } else {
          window.location.href = "login.html";
        }
      }, 2200);

    } else {
      // ── 6. Handle server-side failure ─────────────────────────────────────
      const msg = data.message || "Registration failed. Please try again.";

      // Surface email-already-exists as a field hint if detected
      if (msg.toLowerCase().includes("email") && msg.toLowerCase().includes("exist")) {
        showHint("email-hint", "This email is already registered.", "err");
      } else {
        errorText.textContent = msg;
        errorMsg.classList.add("show");
      }

      setLoading(false);
    }

  } catch (err) {
    // ── 7. Handle network error ───────────────────────────────────────────────
    console.error("[AgosTech] Registration error:", err);
    errorText.textContent =
      "Unable to reach the server. Please check your connection and try again.";
    errorMsg.classList.add("show");
    setLoading(false);
  }
}

// ── UI helpers ─────────────────────────────────────────────────────────────────

function setLoading(active) {
  const btn = document.getElementById("registerBtn");
  if (!btn) return;
  btn.disabled = active;
  btn.classList.toggle("loading", active);
}

function setSuccess(message) {
  const successMsg  = document.getElementById("successMsg");
  const successText = document.getElementById("successText");
  const btn         = document.getElementById("registerBtn");

  if (successMsg && successText) {
    successText.textContent = message;
    successMsg.classList.add("show");
  }

  if (btn) {
    btn.disabled = true;
    btn.style.background = "#0F7050";
    btn.querySelector(".btn-label").innerHTML = `
      <svg viewBox="0 0 24 24"
           style="width:16px;height:16px;stroke:white;fill:none;
                  stroke-width:2.5;stroke-linecap:round;stroke-linejoin:round">
        <polyline points="20 6 9 17 4 12"/>
      </svg>
      Account Created!
    `;
  }
}

function showHint(id, message, type) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = message;
  el.className = `field-hint show ${type}`;
}

function clearHints() {
  const hints = document.querySelectorAll(".field-hint");
  hints.forEach(h => { h.className = "field-hint"; h.textContent = ""; });
  const inputs = document.querySelectorAll(".field input, .field select");
  inputs.forEach(i => i.classList.remove("invalid", "valid"));
}