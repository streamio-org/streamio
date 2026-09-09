// Email verification: auto-verify a token from the URL, and fall back to the
// paste-a-code / resend panel. That fallback is the common path, not an edge
// case — see the comment in verify-email.html.

const REDIRECT_SECONDS = 3;

const panels = {
  verifying: document.getElementById('panelVerifying'),
  success:   document.getElementById('panelSuccess'),
  manual:    document.getElementById('panelManual'),
};

function showPanel(name) {
  for (const [key, el] of Object.entries(panels)) el.classList.toggle('active', key === name);
}

function setLoading(btnId, loading, label) {
  const btn = document.getElementById(btnId);
  btn.disabled = loading;
  btn.innerHTML = loading ? '<div class="spin"></div>' : label;
}

function showError(msg) {
  document.getElementById('manualSuccess').classList.remove('show');
  const el = document.getElementById('manualError');
  el.textContent = msg;
  el.classList.add('show');
}
function showSuccess(msg) {
  document.getElementById('manualError').classList.remove('show');
  const el = document.getElementById('manualSuccess');
  el.textContent = msg;
  el.classList.add('show');
}

// A dead link is the expected failure here, so people paste the whole broken
// URL as often as the bare code. Pull the token out of either.
function normalizeCode(raw) {
  const value = raw.trim();
  const match = value.match(/[?&]token=([^&\s]+)/);
  return match ? decodeURIComponent(match[1]) : value;
}

function onVerified() {
  showPanel('success');
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

async function verify(token, { fromUrl = false } = {}) {
  if (fromUrl) showPanel('verifying');

  let res, data;
  try {
    res = await fetch('/api/auth/verify-email', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ token }),
    });
    data = await res.json();
  } catch {
    showPanel('manual');
    showError('Could not reach the server. Check your connection and try again.');
    return;
  }

  if (res.ok) {
    onVerified();
    return;
  }

  showPanel('manual');
  document.getElementById('manualSub').textContent =
    'That link has expired or was already used. Paste the code from your email, or request a new one.';
  showError(data.error ?? data.message ?? 'Verification failed.');
  if (fromUrl) document.getElementById('token').focus();
}

document.getElementById('manualForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const token = normalizeCode(document.getElementById('token').value);
  if (!token) return showError('Paste the code from your verification email.');

  setLoading('manualSubmit', true);
  try {
    await verify(token);
  } finally {
    setLoading('manualSubmit', false, 'Verify');
  }
});

document.getElementById('resendForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  setLoading('resendSubmit', true);
  try {
    const res = await fetch('/api/auth/verify-email/resend', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ email: document.getElementById('email').value.trim() }),
    });
    const data = await res.json();
    if (res.ok) showSuccess(data.message ?? 'A new link is on its way.');
    else        showError(data.error ?? 'Could not send a new link.');
  } catch {
    showError('Could not reach the server. Check your connection and try again.');
  } finally {
    setLoading('resendSubmit', false, 'Send a new link');
  }
});

const urlToken = new URLSearchParams(location.search).get('token');
if (urlToken) {
  verify(urlToken, { fromUrl: true });
} else {
  showPanel('manual');
  document.getElementById('token').focus();
}
