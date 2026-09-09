// The phone half of the TV sign-in flow (`auth/deviceLogin.ts`).
//
// The television shows a code and polls; this page is where a signed-in user
// approves it. Everything security-relevant is server-side — `/device/claim`
// is behind requireAuth, and the account it binds is whoever is signed in
// here, never anything this page sends.

import { api, apiFetch, escapeHtml } from '/scripts/auth.js';

const panels = {
  loading: document.getElementById('panelLoading'),
  form:    document.getElementById('panelForm'),
  success: document.getElementById('panelSuccess'),
};

function showPanel(name) {
  for (const [key, el] of Object.entries(panels)) el.classList.toggle('active', key === name);
}

function showError(msg) {
  const el = document.getElementById('formError');
  el.textContent = msg;
  el.classList.add('show');
}

function clearError() {
  document.getElementById('formError').classList.remove('show');
}

function setLoading(loading) {
  const btn = document.getElementById('codeSubmit');
  btn.disabled = loading;
  btn.innerHTML = loading ? '<div class="spin"></div>' : 'Sign in my TV';
}

// Mirrors normalizeUserCode() on the server: uppercase, drop anything outside
// the alphabet, regroup into XXXX-XXXX. Typing on a phone keyboard produces
// lowercase and stray spaces constantly, and a code that "doesn't work"
// because of a space is the whole flow wasted.
const ALPHABET = 'ACDEFGHJKMNPQRTUVWXY3467';

function normalizeUserCode(raw) {
  const cleaned = raw
    .toUpperCase()
    .split('')
    .filter((ch) => ALPHABET.includes(ch))
    .join('')
    .slice(0, 8);

  const groups = [];
  for (let i = 0; i < cleaned.length; i += 4) groups.push(cleaned.slice(i, i + 4));
  return groups.join('-');
}

const input = document.getElementById('userCode');

input.addEventListener('input', () => {
  const atEnd = input.selectionStart === input.value.length;
  input.value = normalizeUserCode(input.value);
  if (atEnd) input.setSelectionRange(input.value.length, input.value.length);
});

async function claim(code) {
  clearError();
  setLoading(true);

  try {
    const data = await api('/api/auth/device/claim', {
      method: 'POST',
      body: { user_code: code },
    });

    if (data.label) {
      document.getElementById('successSub').innerHTML =
        `<strong>${escapeHtml(data.label)}</strong> is now signed in. You can put the remote down — it will continue on its own.`;
    }
    showPanel('success');
  } catch (err) {
    showError(err.message || 'Could not sign in that TV.');
    showPanel('form');
  } finally {
    setLoading(false);
  }
}

document.getElementById('codeForm').addEventListener('submit', (event) => {
  event.preventDefault();
  const code = normalizeUserCode(input.value);
  if (code.length < 9) {
    showError('That code looks incomplete. It has eight characters.');
    return;
  }
  claim(code);
});

// The TV's QR code points at ?code=…, so the common path arrives with the code
// already filled in. It still needs an explicit confirmation — approving an
// account binding silently on page load is exactly the phishing case the
// warning copy is about.
async function init() {
  // apiFetch bounces to /login?redirect=… when there is no session, which is
  // what we want: signing in and coming back lands here with the code intact.
  try {
    await apiFetch('/api/account/me');
  } catch {
    // Either it redirected (nothing left to do) or the server is unreachable.
    showError('Could not reach the server. Check your connection and reload.');
    showPanel('form');
    return;
  }

  const fromUrl = new URLSearchParams(location.search).get('code');
  if (fromUrl) input.value = normalizeUserCode(fromUrl);

  showPanel('form');
  input.focus();
}

init();
