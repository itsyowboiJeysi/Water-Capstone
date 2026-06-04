function handleGoogleCallback() {
  const params = new URLSearchParams(window.location.search);
  const token  = params.get("token");
  const user   = params.get("user");
 
  if (token && user) {
    // Save to localStorage (same as "remember me" in login.js)
    localStorage.setItem("token", token);
    localStorage.setItem("user",  user);
 
    // Clean the URL so the token isn't visible in the address bar
    const cleanURL = window.location.origin + window.location.pathname;
    window.history.replaceState({}, document.title, cleanURL);
 
    console.log("[AquaMonitor] Google login successful, token saved.");
  }
};