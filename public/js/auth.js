// Login / first-account registration screen + change-password dialog.
import { h, replace, modal } from './dom.js';
import { api } from './api.js';

/**
 * Renders the full-screen auth card into `host`.
 * opts: { registrationOpen, note, onSuccess(username) }
 */
export function renderAuth(host, { registrationOpen, note, onSuccess }) {
  let timer = null;
  const reg = !!registrationOpen;
  const user = h('input', { id: 'au-user', name: 'username', type: 'text', autocomplete: 'username', autocapitalize: 'none', spellcheck: 'false', required: true, minlength: reg ? 3 : null });
  const pass = h('input', { id: 'au-pass', name: 'password', type: 'password', autocomplete: reg ? 'new-password' : 'current-password', required: true, minlength: reg ? 8 : null });
  const pass2 = reg ? h('input', { id: 'au-pass2', name: 'password-confirm', type: 'password', autocomplete: 'new-password', required: true }) : null;
  const err = h('div', { class: 'form-err auth-err', role: 'alert' });
  const btn = h('button', { type: 'submit', class: 'btn primary wide' }, reg ? 'Create account' : 'Sign in');

  const fail = (msg) => { err.textContent = msg; };
  function lockout(seconds) {
    clearInterval(timer);
    let left = Math.max(1, Math.ceil(seconds));
    btn.disabled = true;
    const tick = () => {
      if (left <= 0) { clearInterval(timer); btn.disabled = false; fail(''); return; }
      fail(`Too many attempts. Try again in ${left}s.`); left -= 1;
    };
    tick(); timer = setInterval(tick, 1000);
  }

  const form = h('form', { class: 'auth-form', method: 'post', action: '#', novalidate: true, onsubmit: async (e) => {
    e.preventDefault();
    fail('');
    if (reg) {
      if (user.value.trim().length < 3) return fail('Username must be at least 3 characters.');
      if (pass.value.length < 8) return fail('Password must be at least 8 characters.');
      if (pass.value !== pass2.value) return fail('Passwords do not match.');
    } else if (!user.value || !pass.value) return fail('Enter your username and password.');
    btn.disabled = true;
    try {
      const r = await api('POST', reg ? '/auth/register' : '/auth/login', { username: user.value.trim(), password: pass.value }, { quiet: true });
      pass.value = ''; if (pass2) pass2.value = '';
      clearInterval(timer);
      onSuccess(r?.username || user.value.trim());
    } catch (ex) {
      btn.disabled = false;
      if (ex.status === 429) lockout(ex.data?.retryAfter ?? 30);
      else { fail(ex.message); pass.value = ''; if (pass2) pass2.value = ''; pass.focus(); }
    }
  } },
  field('Username', user), field('Password', pass), pass2 ? field('Confirm password', pass2) : null,
  err, btn);

  replace(host, h('div', { class: 'auth-wrap' }, h('div', { class: 'auth-card' },
    h('div', { class: 'brand' }, h('span', { class: 'logo', 'aria-hidden': 'true' }), h('span', 'dummy-emag')),
    h('h1', reg ? 'Create the first account' : 'Sign in'),
    note ? h('div', { class: 'note-box warn', role: 'status' }, note) : null,
    reg ? h('p', { class: 'muted small' }, 'This is the only account that can ever be registered; sign-ups close afterwards.')
      : h('p', { class: 'muted small' }, 'Sign in to manage this dummy eMAG API instance.'),
    form)));
  setTimeout(() => user.focus(), 0);
  return () => clearInterval(timer);
}

const field = (label, input) => h('div', { class: 'field' }, h('label', { for: input.id }, label), input);

/** Small dialog: POST /auth/password. */
export function changePasswordDialog() {
  // hidden username field helps password managers associate the new password with the account
  const cur = h('input', { id: 'cp-cur', name: 'current-password', type: 'password', autocomplete: 'current-password', 'data-autofocus': '' });
  const nxt = h('input', { id: 'cp-new', name: 'new-password', type: 'password', autocomplete: 'new-password' });
  const rep = h('input', { id: 'cp-rep', name: 'new-password-confirm', type: 'password', autocomplete: 'new-password' });
  const err = h('div', { class: 'form-err', role: 'alert' });
  const body = h('form', { class: 'pw-form', onsubmit: (e) => e.preventDefault() }, field('Current password', cur), field('New password (min 8 characters)', nxt), field('Repeat new password', rep), err);
  return modal({
    title: 'Change password', body,
    actions: [
      { label: 'Cancel', value: false },
      { label: 'Change password', kind: 'primary', onClick: async (close) => {
        err.textContent = '';
        if (nxt.value.length < 8) { err.textContent = 'New password must be at least 8 characters.'; return; }
        if (nxt.value !== rep.value) { err.textContent = 'Passwords do not match.'; return; }
        try { await api('POST', '/auth/password', { current: cur.value, next: nxt.value }, { quiet: true }); cur.value = nxt.value = rep.value = ''; close(true); } catch (ex) { if (!ex.authLost) err.textContent = ex.message; }
      } },
    ],
  });
}
