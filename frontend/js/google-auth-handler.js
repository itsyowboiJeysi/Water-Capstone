async function handleGoogleCallback() {
  const params = new URLSearchParams(window.location.search);
  const code   = params.get("code");

  if (!code) return; // not a Google callback — resolve immediately

  // If we already have a valid token, the code may be stale (page reload/back).
  // Clean the URL and continue with the existing session.
  const existingToken = localStorage.getItem("token") || sessionStorage.getItem("token");
  if (existingToken) {
    window.history.replaceState({}, document.title, window.location.pathname);
    return;
  }

  try {
    const res = await fetch("http://localhost:5000/api/auth/exchange-code", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ code }),
    });

    const data = await res.json();

    if (res.ok && data.token) {
      // Store token — always use localStorage for Google OAuth sessions (persistent)
      localStorage.setItem("token", data.token);
      localStorage.setItem("user",  JSON.stringify(data.user));
      // Remove the ?code= from the URL so page refresh doesn't try to re-use it
      window.history.replaceState({}, document.title, window.location.pathname);
    } else {
      // Exchange failed — if an existing token exists from a prior session, keep it
      const fallbackToken = localStorage.getItem("token") || sessionStorage.getItem("token");
      if (fallbackToken) {
        window.history.replaceState({}, document.title, window.location.pathname);
        return;
      }
      console.error("[OAuth] Exchange failed:", data.message);
      // Don't redirect immediately — let the .then() block handle the redirect
      // so we don't get stuck in a redirect loop if the server is slow
      throw new Error(data.message || "Auth exchange failed");
    }

  } catch (err) {
    console.error("[OAuth] Exchange error:", err.message);
    // Only redirect to login if we truly have no token
    const fallbackToken = localStorage.getItem("token") || sessionStorage.getItem("token");
    if (!fallbackToken) {
      window.location.replace("login.html?error=auth_failed");
    } else {
      // We have a token — clean the URL and continue
      window.history.replaceState({}, document.title, window.location.pathname);
    }
    throw err;
  }
}

// NO auto-call here anymore — dashboard.html calls it explicitly