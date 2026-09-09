import { saveAccessToken } from '/scripts/auth.js';

// /api/version/download requires a logged-in user but can't read the
// Authorization header on a plain browser navigation, so it accepts the
// access token as a `?token=` query param instead (same fallback the room
// WebSocket uses). Only ever add it back onto that one destination — never
// leak the access token onto an arbitrary `redirect` target.
function withDownloadToken(redirect, accessToken) {
    if (redirect !== '/api/version/download') return redirect;
    return `${redirect}?token=${encodeURIComponent(accessToken)}`;
}

// Handle OAuth callback — /auth/callback?code=... redirects here.
// The server redirects to APP_URL/auth/callback, so we also serve this page
// at /auth/callback via the public router.
//
// The exchange below is the whole reason the session survives past 15
// minutes. The OAuth callback runs on the APP_URL origin, which can differ
// from the origin this page ends up on for a reverse-proxied install (e.g. a
// tunnel or public hostname in front of the app), and a server can only set
// a cookie for the host it was contacted on. So the callback hands over a single-use code
// and *we* trade it for a session here — a POST to our own origin, which puts
// the refresh cookie on the host the browser is actually browsing.
//
// `?token=` is still honoured: an in-flight redirect issued by the previous
// build, or a link someone kept, must not dead-end on a login page.
(async function() {
const params = new URLSearchParams(window.location.search);
const code   = params.get('code');
const token  = params.get('token');

function leave(accessToken) {
    saveAccessToken(accessToken);
    const redirect = params.get('redirect') || '/';
    window.location.replace(withDownloadToken(redirect, accessToken));
}

if (code) {
    // Drop the code from the address bar before anything can await on it, so
    // it can't be re-shared or land in the referrer of a later request. It is
    // single-use and 60-second-lived server-side regardless.
    history.replaceState(null, '', window.location.pathname);
    try {
        const res = await fetch('/api/auth/oauth/exchange', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ code }),
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data.access_token) {
            leave(data.access_token);
            return;
        }
        // Falling through to a bare login form looks identical to "your
        // click did nothing" — say what happened instead.
        showError('loginError', data.error || 'Accesso non riuscito. Riprova.');
    } catch {
        showError('loginError', 'Impossibile contattare il server. Riprova.');
    }
    return;
}

if (token) leave(token);
})();

// The OAuth buttons' hrefs are static in login.html, so the page's own
// `redirect` param (set by e.g. auth.js's redirectToLogin) has to be
// stitched on here before the browser follows them — otherwise
// /api/auth/:provider never sees where to send the user back to, and the
// OAuth round trip always lands on '/' regardless of what page sent them
// to /login.
(function() {
const redirect = new URLSearchParams(window.location.search).get('redirect');
if (!redirect) return;
document.querySelectorAll('#oauthGroup .oauth-btn').forEach(a => {
    const url = new URL(a.href, window.location.origin);
    url.searchParams.set('redirect', redirect);
    a.href = url.toString();
});
})();

let mode = 'login'; // 'login' | 'register' | 'reset'

// Mode tabs
document.querySelectorAll('.mode-tab').forEach(tab => {
tab.addEventListener('click', () => switchMode(tab.dataset.mode));
});

document.getElementById('switchToRegister').addEventListener('click', e => {
e.preventDefault();
switchMode('register');
});

document.getElementById('forgotLink').addEventListener('click', e => {
e.preventDefault();
switchMode('reset');
});

document.getElementById('backToLogin').addEventListener('click', e => {
e.preventDefault();
switchMode('login');
});

function switchMode(m) {
mode = m;
document.getElementById('loginForm').style.display    = m === 'login'    ? 'block' : 'none';
document.getElementById('registerForm').style.display = m === 'register' ? 'block' : 'none';
document.getElementById('resetForm').style.display    = m === 'reset'    ? 'block' : 'none';
document.getElementById('oauthGroup').style.display   = m === 'reset'    ? 'none'  : 'flex';
document.getElementById('dividerEl').style.display    = m === 'reset'    ? 'none'  : 'flex';
document.getElementById('modeTabs').style.display     = m === 'reset'    ? 'none'  : 'flex';
document.getElementById('authFooter').style.display   = m === 'reset'    ? 'none'  : 'block';

document.querySelectorAll('.mode-tab').forEach(t => t.classList.toggle('active', t.dataset.mode === m));

if (m === 'login') {
    document.getElementById('authHeading').textContent = 'Welcome back';
    document.getElementById('authSub').textContent     = 'Sign in to continue watching.';
    document.getElementById('authFooter').innerHTML    = 'Don\'t have an account? <a href="#" id="switchToRegister" onclick="switchMode(\'register\');return false;">Sign up for free</a>';
    document.getElementById('switchToRegister')?.addEventListener('click', e => { e.preventDefault(); switchMode('register'); });
} else if (m === 'register') {
    document.getElementById('authHeading').textContent = 'Create account';
    document.getElementById('authSub').textContent     = 'Join Streamio to save your shows and history.';
    document.getElementById('authFooter').innerHTML    = 'Already have an account? <a href="#" onclick="switchMode(\'login\');return false;">Sign in</a>';
} else {
    document.getElementById('authHeading').textContent = 'Reset password';
    document.getElementById('authSub').textContent     = 'We\'ll email you a link to reset your password.';
}
}

function setLoading(btnId, loading) {
const btn = document.getElementById(btnId);
if (loading) {
    btn.disabled = true;
    btn.innerHTML = '<div class="spin"></div>';
} else {
    btn.disabled = false;
}
}

function showError(id, msg) {
const el = document.getElementById(id);
el.textContent = msg;
el.classList.add('show');
}
function hideError(id) {
document.getElementById(id).classList.remove('show');
}

async function handleLogin(e) {
e.preventDefault();
hideError('loginError');
setLoading('loginSubmit', true);
try {
    const res = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({
        email:    document.getElementById('loginEmail').value,
        password: document.getElementById('loginPassword').value,
    })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Login failed.');
    saveAccessToken(data.access_token);
    const redirect = new URLSearchParams(window.location.search).get('redirect') || '/';
    window.location.href = withDownloadToken(redirect, data.access_token);
} catch (err) {
    showError('loginError', err.message);
    document.getElementById('loginSubmit').textContent = 'Sign In';
    document.getElementById('loginSubmit').disabled = false;
}
}

async function handleRegister(e) {
e.preventDefault();
hideError('registerError');
const pw = document.getElementById('regPassword').value;
if (pw.length < 8) return showError('registerError', 'Password must be at least 8 characters.');
setLoading('registerSubmit', true);
try {
    const res = await fetch('/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({
        email:        document.getElementById('regEmail').value,
        password:     pw,
        display_name: document.getElementById('regName').value.trim() || undefined,
    })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Registration failed.');
    saveAccessToken(data.access_token);
    window.location.href = '/account';
} catch (err) {
    showError('registerError', err.message);
    document.getElementById('registerSubmit').textContent = 'Create Account';
    document.getElementById('registerSubmit').disabled = false;
}
}

async function handleReset(e) {
e.preventDefault();
hideError('resetError');
setLoading('resetSubmit', true);
try {
    const res = await fetch('/api/auth/password-reset/request', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: document.getElementById('resetEmail').value })
    });
    document.getElementById('resetSubmit').disabled = false;
    document.getElementById('resetSubmit').textContent = '✓ Check your inbox';
    document.getElementById('resetSubmit').style.background = '#1a6e33';
} catch (err) {
    showError('resetError', err.message);
    document.getElementById('resetSubmit').textContent = 'Send Reset Link';
    document.getElementById('resetSubmit').disabled = false;
}
}

// Wire form submit listeners here (can't use onsubmit="" with ES modules)
document.getElementById('loginForm').addEventListener('submit', handleLogin);
document.getElementById('registerForm').addEventListener('submit', handleRegister);
document.getElementById('resetForm').addEventListener('submit', handleReset);