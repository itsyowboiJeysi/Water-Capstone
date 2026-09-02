// forgotPassword.js — AgosTech Forgot Password Handler

async function forgotPassword() {
  const emailInput  = document.getElementById('fpEmail');
  const submitBtn   = document.getElementById('fpSubmitBtn');
  const successMsg  = document.getElementById('fpSuccessMsg');
  const successText = document.getElementById('fpSuccessText');
  const errorMsg    = document.getElementById('fpErrorMsg');
  const errorText   = document.getElementById('fpErrorText');

  const email = emailInput.value.trim();

  // ── Reset state ─────────────────────────────────────────────────────────────
  successMsg.classList.remove('show');
  errorMsg.classList.remove('show');

  // ── Basic client-side validation ────────────────────────────────────────────
  if (!email) {
    errorText.textContent = 'Please enter your email address.';
    errorMsg.classList.add('show');
    emailInput.focus();
    return;
  }

  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailPattern.test(email)) {
    errorText.textContent = 'Please enter a valid email address.';
    errorMsg.classList.add('show');
    emailInput.focus();
    return;
  }

  // ── Loading state ────────────────────────────────────────────────────────────
  submitBtn.classList.add('loading');
  submitBtn.disabled = true;

  try {
    const res = await fetch('/api/auth/forgot-password', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ email }),
    });

    const data = await res.json();

    if (res.ok) {
      // Show success — hide the form, show success block
      document.getElementById('forgotForm').style.display  = 'none';
      submitBtn.style.display = 'none';
      successText.textContent = `A reset link has been sent to ${email}. Check your inbox and follow the instructions.`;
      successMsg.classList.add('show');
    } else {
      errorText.textContent = data.message || 'Something went wrong. Please try again.';
      errorMsg.classList.add('show');
      submitBtn.classList.remove('loading');
      submitBtn.disabled = false;
    }

  } catch (err) {
    console.error('[AgosTech] forgotPassword fetch error:', err);
    errorText.textContent = 'Network error. Please check your connection and try again.';
    errorMsg.classList.add('show');
    submitBtn.classList.remove('loading');
    submitBtn.disabled = false;
  }
}