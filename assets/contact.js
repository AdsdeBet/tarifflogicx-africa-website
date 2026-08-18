// assets/contact.js
//
// Loaded on every page (tools.html, the static SEO info/*.html pages,
// index.html, privacy.html, delete-data.html). Intercepts clicks on the
// footer's "Contact" mailto: link and opens an on-site form instead — a
// bare mailto: link pops an OS "choose an app to open this" dialog on any
// machine without a configured default mail client, which is a dead end
// for a lot of visitors. The mailto: href is left in place as a no-JS
// fallback; this only takes over when JS actually runs.
//
// Self-contained (styles + markup injected here) so a single <script> tag
// is enough on every page, rather than needing a matching <link> + modal
// markup hand-added to 49 separate HTML files.

(function () {
  const API_BASE = 'https://tarifflogicx-africa-proxy-production.up.railway.app';

  const style = document.createElement('style');
  style.textContent = `
    #tlxa-contact-modal { display:none; position:fixed; inset:0; background:rgba(0,0,0,0.4); z-index:200; align-items:center; justify-content:center; padding:20px 0; overflow-y:auto; }
    #tlxa-contact-modal.open { display:flex; }
    #tlxa-contact-modal .tlxa-contact-card { background:#fff; border-radius:14px; padding:24px; width:360px; max-width:90vw; max-height:90vh; overflow-y:auto; font-family:inherit; }
    #tlxa-contact-modal h3 { margin:0 0 6px; font-size:15px; color:#0F6E56; }
    #tlxa-contact-modal p.tlxa-contact-sub { font-size:12.5px; color:#7A7267; margin:0 0 14px; line-height:1.5; }
    #tlxa-contact-modal label { display:block; font-size:12px; font-weight:600; color:#7A7267; text-transform:uppercase; letter-spacing:0.5px; margin:10px 0 6px; }
    #tlxa-contact-modal input, #tlxa-contact-modal textarea {
      width:100%; padding:11px 13px; border:1px solid #E4DFD5; border-radius:10px;
      font-size:14px; font-family:inherit; box-sizing:border-box; color:#2B2620;
    }
    #tlxa-contact-modal input:focus, #tlxa-contact-modal textarea:focus {
      outline:none; border-color:#1D9E75; box-shadow:0 0 0 3px rgba(29,158,117,0.15);
    }
    #tlxa-contact-modal textarea { resize:vertical; min-height:80px; }
    #tlxa-contact-modal .tlxa-contact-actions { display:flex; gap:8px; margin-top:16px; }
    #tlxa-contact-modal button { border-radius:10px; font-size:13px; font-weight:600; padding:11px 16px; cursor:pointer; border:none; flex:1; }
    #tlxa-contact-modal .tlxa-contact-cancel { background:#fff; border:1px solid #1D9E75; color:#0F6E56; }
    #tlxa-contact-modal .tlxa-contact-submit { background:#1D9E75; color:#fff; }
    #tlxa-contact-modal .tlxa-contact-submit:disabled { background:#B8CFC7; cursor:default; }
    #tlxa-contact-modal .tlxa-contact-msg { border-radius:10px; padding:11px 13px; font-size:12.5px; margin-top:12px; display:none; line-height:1.5; }
    #tlxa-contact-modal .tlxa-contact-msg.error { display:block; background:#FAEEDA; border:1px solid #FAC775; color:#633806; }
    #tlxa-contact-modal .tlxa-contact-msg.success { display:block; background:#EAF3DE; border:1px solid #C7DFA6; color:#3B6D11; }
  `;
  document.head.appendChild(style);

  const modal = document.createElement('div');
  modal.id = 'tlxa-contact-modal';
  modal.innerHTML = `
    <div class="tlxa-contact-card">
      <h3>Contact Us</h3>
      <p class="tlxa-contact-sub">Please complete the form below and a member of our team will respond to your enquiry as soon as possible.</p>
      <form id="tlxa-contact-form">
        <label for="tlxa-contact-name">Name</label>
        <input type="text" id="tlxa-contact-name" required maxlength="200">
        <label for="tlxa-contact-email">Email</label>
        <input type="email" id="tlxa-contact-email" required maxlength="200">
        <label for="tlxa-contact-message">Message</label>
        <textarea id="tlxa-contact-message" required maxlength="5000"></textarea>
        <div class="tlxa-contact-msg" id="tlxa-contact-msg"></div>
        <div class="tlxa-contact-actions">
          <button type="button" class="tlxa-contact-cancel" id="tlxa-contact-cancel">Cancel</button>
          <button type="submit" class="tlxa-contact-submit" id="tlxa-contact-submit">Send</button>
        </div>
      </form>
    </div>
  `;
  document.body.appendChild(modal);

  const form = document.getElementById('tlxa-contact-form');
  const msgEl = document.getElementById('tlxa-contact-msg');
  const submitBtn = document.getElementById('tlxa-contact-submit');

  function openModal() {
    msgEl.className = 'tlxa-contact-msg';
    msgEl.textContent = '';
    form.style.display = 'block';
    modal.classList.add('open');
  }
  function closeModal() { modal.classList.remove('open'); }

  document.getElementById('tlxa-contact-cancel').addEventListener('click', closeModal);
  modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = document.getElementById('tlxa-contact-name').value.trim();
    const email = document.getElementById('tlxa-contact-email').value.trim();
    const message = document.getElementById('tlxa-contact-message').value.trim();
    msgEl.className = 'tlxa-contact-msg';
    msgEl.textContent = '';
    submitBtn.disabled = true;
    submitBtn.textContent = 'Sending…';
    try {
      const res = await fetch(`${API_BASE}/web/contact`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, email, message }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Your message could not be sent. Please try again shortly.');
      msgEl.className = 'tlxa-contact-msg success';
      msgEl.textContent = 'Thank you. Your message has been received, and our team will respond as soon as possible.';
      form.querySelectorAll('input, textarea').forEach((el) => { el.value = ''; });
      setTimeout(closeModal, 2500);
    } catch (err) {
      msgEl.className = 'tlxa-contact-msg error';
      msgEl.textContent = err.message || 'Your message could not be sent. Please try again, or email support@tarifflogicxafrica.co.za directly.';
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Send';
    }
  });

  document.querySelectorAll('a[href^="mailto:support@tarifflogicxafrica.co.za"]').forEach((link) => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      openModal();
    });
  });
})();
