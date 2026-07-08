const crypto = require('crypto');
const MAILTM_API = 'https://api.mail.tm';

class MailTmService {
  async createInbox() {
    const domainRes = await fetch(`${MAILTM_API}/domains`, {
      headers: { Accept: 'application/json' }
    });
    const domains = await domainRes.json();
    const domain = domains['hydra:member']?.[0]?.domain;
    if (!domain) throw new Error('No Mail.tm domain available');

    const id = crypto.randomUUID().slice(0, 12);
    const address = `${id}@${domain}`;
    const password = crypto.randomUUID() + 'Aa1!';

    const createRes = await fetch(`${MAILTM_API}/accounts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address, password })
    });
    if (!createRes.ok) throw new Error(`Mail.tm account creation failed: ${createRes.status}`);

    const tokenRes = await fetch(`${MAILTM_API}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address, password })
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.token) throw new Error('Mail.tm token retrieval failed');

    return { email: address, password, token: tokenData.token };
  }

  async getMessages(token) {
    const res = await fetch(`${MAILTM_API}/messages`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!res.ok) return [];
    const data = await res.json();
    return data['hydra:member'] || [];
  }

  async getMessage(token, messageId) {
    const res = await fetch(`${MAILTM_API}/messages/${messageId}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!res.ok) return null;
    return res.json();
  }

  extractVerificationLinks(message) {
    const links = [];
    const text = message.html || message.text || '';
    const urlRegex = /https?:\/\/[^\s"'<>]+/g;
    const matches = text.match(urlRegex);
    if (matches) links.push(...matches);

    const verifyKeywords = ['verify', 'confirm', 'activate', 'validate', 'email_confirm', 'auth'];
    return links.filter(link => verifyKeywords.some(k => link.toLowerCase().includes(k)));
  }

  async pollForVerificationLink(token, timeoutMs = 90000, intervalMs = 3000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const messages = await this.getMessages(token);
      if (messages.length > 0) {
        for (const msg of messages) {
          const full = await this.getMessage(token, msg.id);
          if (!full) continue;
          const links = this.extractVerificationLinks(full);
          if (links.length > 0) return { link: links[0], message: full };
        }
      }
      await new Promise(r => setTimeout(r, intervalMs));
    }
    throw new Error('Verification email not received within timeout');
  }
}

module.exports = new MailTmService();
