// Password reset — the confirm half. Requesting the email lives in login.js.

const REDIRECT_SECONDS = 3;

const urlToken   = new URLSearchParams(location.search).get('token');
const tokenRow   = document.getElementById('tokenRow');
const tokenInput = document.getElementById('token');
const passwordEl = document.getElementById('password');
const confirmEl  = document.getElementById('confirm');
const errorEl    = document.getElementById('formError');

if (!urlToken) {
  tokenRow.hidden = false;
  tokenInput.focus();
} else {
  passwordEl.focus();
}

function showError(msg) {
  errorEl.textContent = msg;
  errorEl.classList.add('show');
}
function hideError() {
  errorEl.classList.remove('show');
}

function setLoading(loading) {
  const btn = document.getElementById('submitBtn');
  btn.disabled = loading;
  btn.innerHTML = loading ? '<div class="spin"></div>' : 'Reset password';
}

// People paste the whole dead link as often as the bare code (the tunnel host
// rotates on restart), so accept either form.
function normalizeCode(raw) {
  const value = raw.trim();
  const match = value.match(/[?&]token=([^&\s]+)/);
  return match ? decodeURIComponent(match[1]) : value;
}

// ── Strength meter ──
// Advisory only. The server's rule is length >= 8 and nothing else, so this
// never blocks a submit — it just tells the user where they stand.
const meter      = document.getElementById('pwMeter');
const meterLabel = document.getElementById('pwMeterLabel');
const LABELS     = ['', 'Weak', 'Good', 'Strong'];

function scorePassword(pw) {
  if (!pw) return 0;
  let points = 0;
  if (pw.length >= 8)             points++;
  if (pw.length >= 12)            points++;
  if (/\d/.test(pw))              points++;
  if (/[a-zA-Z]/.test(pw))        points++;
  if (/[^\w\s]/.test(pw))         points++;
  if (pw.length < 8)  return 1; // below the server's minimum, never anything but weak
  if (points <= 2)    return 1;
  if (points === 3)   return 2;
  return 3;
}

passwordEl.addEventListener('input', () => {
  const score = scorePassword(passwordEl.value);
  meter.dataset.score = String(score);
  meterLabel.textContent = LABELS[score];
});

// ── Reveal toggles ──
document.querySelectorAll('.pw-toggle').forEach(btn => {
  btn.addEventListener('click', () => {
    const input   = document.getElementById(btn.dataset.toggle);
    const showing = input.type === 'text';
    input.type = showing ? 'password' : 'text';
    btn.setAttribute('aria-pressed', String(!showing));
    btn.setAttribute('aria-label', showing ? 'Show password' : 'Hide password');
  });
});

// ── Success ──
function onReset() {
  document.getElementById('panelForm').classList.remove('active');
  document.getElementById('panelSuccess').classList.add('active');

  const note = document.getElementById('redirectNote');
  let left = REDIRECT_SECONDS;
  note.textContent = `Redirecting in ${left}s…`;
  const tick = setInterval(() => {
    left -= 1;
    if (left <= 0) {
      clearInterval(tick);
      location.href = '/login';
      return;
    }
    note.textContent = `Redirecting in ${left}s…`;
  }, 1000);
}

// ── Submit ──
document.getElementById('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  hideError();

  const token    = urlToken ?? normalizeCode(tokenInput.value);
  const password = passwordEl.value;

  if (!token)                     return showError('Paste the reset code from your email.');
  if (password.length < 8)        return showError('Password must be at least 8 characters.');
  if (password !== confirmEl.value) return showError("Passwords don't match.");

  setLoading(true);
  try {
    const res  = await fetch('/api/auth/password-reset/confirm', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ token, password }),
    });
    const data = await res.json();
    if (res.ok) onReset();
    else        showError(data.error ?? data.message ?? 'Could not reset your password.');
  } catch {
    showError('Could not reach the server. Check your connection and try again.');
  } finally {
    setLoading(false);
  }
});
