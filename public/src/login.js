// Login screen. Credentials live only in the form fields while submitting; nothing is stored in the browser.

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  if (props.class) node.className = props.class;
  if (props.text !== undefined) node.textContent = props.text;
  for (const [k, v] of Object.entries(props.attrs || {})) node.setAttribute(k, v);
  for (const c of [].concat(children)) if (c) node.append(c);
  return node;
}

function field(id, label, type, autocomplete) {
  const input = el('input', { attrs: { id, name: id, type, autocomplete, required: '', maxlength: '200' } });
  return { input, wrap: el('div', { class: 'field' }, [el('label', { text: label, attrs: { for: id } }), input]) };
}

// Builds the login card into `container` and calls onSuccess() after a successful sign-in.
export function renderLogin(container, onSuccess) {
  const user = field('login-username', 'Username', 'text', 'username');
  const pass = field('login-password', 'Password', 'password', 'current-password');
  const message = el('div', { class: 'login-message', attrs: { role: 'alert' } });
  const submit = el('button', { class: 'btn btn-primary', text: 'Sign In', attrs: { type: 'submit' } });
  const form = el('form', { class: 'login-form' }, [user.wrap, pass.wrap, message, submit]);

  container.replaceChildren(
    el('div', { class: 'login-card' }, [
      el('img', { class: 'login-logo', attrs: { src: '/logo-512.png', alt: 'Stockinator 5000', width: '88', height: '88' } }),
      el('div', { class: 'login-title', text: 'Stockinator 5000' }),
      el('div', { class: 'login-sub', text: 'Sign in to continue' }),
      form,
    ]),
  );

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    message.textContent = '';
    submit.disabled = true;
    submit.textContent = 'Signing in...';
    try {
      const res = await fetch('/api/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'login', username: user.input.value, password: pass.input.value }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.authenticated) {
        pass.input.value = '';
        onSuccess();
        return;
      }
      pass.input.value = '';
      message.textContent = typeof data.error === 'string' ? data.error : 'Could not sign in. Please try again.';
      pass.input.focus();
    } catch (err) {
      console.error(err);
      message.textContent = 'Could not sign in. Please try again.';
    } finally {
      submit.disabled = false;
      submit.textContent = 'Sign In';
    }
  });

  user.input.focus();
}
