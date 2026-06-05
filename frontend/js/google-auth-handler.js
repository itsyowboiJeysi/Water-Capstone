async function handleGoogleCallback() {
  const params = new URLSearchParams(window.location.search);
  const code   = params.get("code");

  if (!code) return; // not a Google callback, resolve immediately

  try {
    const res  = await fetch("http://localhost:5000/api/auth/exchange-code", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ code }),
    });

    const data = await res.json();

    if (res.ok && data.token) {
      localStorage.setItem("token", data.token);
      localStorage.setItem("user",  JSON.stringify(data.user));
      window.history.replaceState({}, document.title, window.location.pathname);
    } else {
      console.error("[OAuth] Exchange failed:", data.message);
      window.location.href = "login.html?error=auth_failed";
    }

  } catch (err) {
    console.error("[OAuth] Network error:", err);
    window.location.href = "login.html?error=network_error";
  }
}

// NO auto-call here anymore — dashboard.html calls it explicitly