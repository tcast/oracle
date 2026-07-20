const { ImapFlow } = require('imapflow');
const pool = require('./db');

/**
 * IMAP configs for providers we store in email_accounts.
 * Outlook/Hotmail may reject basic auth on some tenants — callers get a clear error.
 */
const IMAP_HOSTS = {
  yahoo: { host: 'imap.mail.yahoo.com', port: 993 },
  gmx: { host: 'imap.gmx.com', port: 993 },
  outlook: { host: 'outlook.office365.com', port: 993 },
  hotmail: { host: 'outlook.office365.com', port: 993 },
  live: { host: 'outlook.office365.com', port: 993 },
  'mail.com': { host: 'imap.mail.com', port: 993 },
  yandex: { host: 'imap.yandex.com', port: 993 },
};

const CODE_REGEX = /\b(\d{4,8})\b/g;
const VERIFY_LINK_HINTS = [
  'verify',
  'confirm',
  'activate',
  'validation',
  'email_confirm',
  'auth',
  'reddit.com',
  'click',
];

function providerFromEmail(email, providerHint) {
  const hint = String(providerHint || '').toLowerCase();
  if (IMAP_HOSTS[hint]) return hint;
  const domain = String(email || '')
    .split('@')[1]
    ?.toLowerCase();
  if (!domain) return null;
  if (domain.includes('yahoo')) return 'yahoo';
  if (domain.includes('gmx')) return 'gmx';
  if (domain.includes('outlook') || domain.includes('hotmail') || domain.includes('live.')) {
    return domain.includes('hotmail') ? 'hotmail' : 'outlook';
  }
  if (domain.includes('mail.com')) return 'mail.com';
  if (domain.includes('yandex')) return 'yandex';
  return null;
}

function extractUrls(text) {
  const matches = String(text || '').match(/https?:\/\/[^\s"'<>]+/gi) || [];
  return matches.map((u) => u.replace(/[),.;]+$/, ''));
}

function extractCodes(text) {
  const found = [];
  const raw = String(text || '');
  let m;
  const re = new RegExp(CODE_REGEX.source, 'g');
  while ((m = re.exec(raw)) !== null) {
    const code = m[1];
    // Skip years / common noise
    if (/^(19|20)\d{2}$/.test(code)) continue;
    if (!found.includes(code)) found.push(code);
  }
  return found;
}

function pickVerificationLinks(urls) {
  return urls.filter((u) =>
    VERIFY_LINK_HINTS.some((h) => u.toLowerCase().includes(h))
  );
}

class EmailInboxService {
  resolveImapConfig(account) {
    const provider = providerFromEmail(account.email, account.provider);
    const base = provider ? IMAP_HOSTS[provider] : null;
    if (!base) {
      throw new Error(
        `No IMAP host for provider=${account.provider || '?'} email=${account.email}`
      );
    }
    const meta = account.metadata || {};
    return {
      provider,
      host: meta.imap_host || base.host,
      port: meta.imap_port || base.port,
      secure: true,
      auth: {
        user: meta.imap_user || account.email,
        pass: account.password,
      },
    };
  }

  async withClient(account, fn) {
    if (!account?.password) throw new Error('Email account has no password');
    const cfg = this.resolveImapConfig(account);
    const client = new ImapFlow({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure,
      auth: cfg.auth,
      logger: false,
      greetingTimeout: 20000,
      socketTimeout: 60000,
    });

    try {
      await client.connect();
      return await fn(client, cfg);
    } finally {
      try {
        await client.logout();
      } catch (_) {
        try {
          client.close();
        } catch (__) {
          /* ignore */
        }
      }
    }
  }

  /**
   * Fetch recent messages (headers + body text/html snippet).
   */
  async fetchRecentMessages(account, { limit = 10, mailbox = 'INBOX' } = {}) {
    return this.withClient(account, async (client) => {
      const lock = await client.getMailboxLock(mailbox);
      try {
        const status = client.mailbox;
        const total = status?.exists || 0;
        if (!total) return [];

        const start = Math.max(1, total - limit + 1);
        const messages = [];

        for await (const msg of client.fetch(`${start}:${total}`, {
          envelope: true,
          source: true,
          uid: true,
        })) {
          const raw = msg.source ? msg.source.toString('utf8') : '';
          const textParts = [];
          const htmlMatch = raw.match(/Content-Type:\s*text\/html[\s\S]*?\r?\n\r?\n([\s\S]*?)(?=\r?\n--|\r?\n\r?\nContent-Type:|$)/i);
          const plainMatch = raw.match(/Content-Type:\s*text\/plain[\s\S]*?\r?\n\r?\n([\s\S]*?)(?=\r?\n--|\r?\n\r?\nContent-Type:|$)/i);
          if (plainMatch) textParts.push(plainMatch[1]);
          if (htmlMatch) textParts.push(htmlMatch[1].replace(/<[^>]+>/g, ' '));
          if (!textParts.length) textParts.push(raw.slice(0, 8000));

          const body = textParts.join('\n').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
          const urls = extractUrls(body);
          const codes = extractCodes(body);
          const verifyLinks = pickVerificationLinks(urls);

          messages.push({
            uid: msg.uid,
            subject: msg.envelope?.subject || null,
            from: (msg.envelope?.from || []).map((a) => a.address || a.name).filter(Boolean),
            date: msg.envelope?.date || null,
            codes,
            verifyLinks,
            urls: urls.slice(0, 20),
            preview: body.slice(0, 400),
          });
        }

        // Newest first
        messages.reverse();
        return messages;
      } finally {
        lock.release();
      }
    });
  }

  /**
   * Latest verification code/link across recent messages, optionally filtered by sender/subject.
   */
  async getLatestVerification(account, { limit = 15, fromIncludes, subjectIncludes } = {}) {
    const messages = await this.fetchRecentMessages(account, { limit });
    const filtered = messages.filter((m) => {
      if (fromIncludes) {
        const needle = String(fromIncludes).toLowerCase();
        if (!(m.from || []).some((f) => String(f).toLowerCase().includes(needle))) return false;
      }
      if (subjectIncludes) {
        const needle = String(subjectIncludes).toLowerCase();
        if (!String(m.subject || '').toLowerCase().includes(needle)) return false;
      }
      return (m.codes && m.codes.length) || (m.verifyLinks && m.verifyLinks.length);
    });

    const best = filtered[0] || null;
    return {
      found: !!best,
      code: best?.codes?.[0] || null,
      link: best?.verifyLinks?.[0] || null,
      codes: best?.codes || [],
      links: best?.verifyLinks || [],
      message: best,
      scanned: messages.length,
    };
  }

  async pollForVerification(
    account,
    {
      timeoutMs = 90000,
      intervalMs = 5000,
      fromIncludes,
      subjectIncludes,
      limit = 10,
    } = {}
  ) {
    const start = Date.now();
    let last = null;
    while (Date.now() - start < timeoutMs) {
      last = await this.getLatestVerification(account, {
        limit,
        fromIncludes,
        subjectIncludes,
      });
      if (last.found) return last;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    throw new Error(
      `Verification email not received within ${timeoutMs}ms` +
        (last ? ` (scanned ${last.scanned} messages)` : '')
    );
  }

  async getAccountById(id) {
    const result = await pool.query('SELECT * FROM email_accounts WHERE id = $1', [id]);
    if (!result.rows[0]) throw new Error(`Email account ${id} not found`);
    return result.rows[0];
  }

  async checkInbox(emailAccountId, opts = {}) {
    const account = await this.getAccountById(emailAccountId);
    const messages = await this.fetchRecentMessages(account, {
      limit: opts.limit || 10,
    });
    const latest = await this.getLatestVerification(account, {
      limit: opts.limit || 10,
      fromIncludes: opts.fromIncludes,
      subjectIncludes: opts.subjectIncludes,
    });

    await pool.query(
      `UPDATE email_accounts
       SET metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb
       WHERE id = $1`,
      [
        emailAccountId,
        JSON.stringify({
          last_inbox_check_at: new Date().toISOString(),
          last_inbox_ok: true,
          last_inbox_count: messages.length,
        }),
      ]
    ).catch(() => {});

    return {
      emailAccountId,
      email: account.email,
      provider: account.provider,
      messages,
      latestVerification: latest,
    };
  }

  async testImapLogin(emailAccountId) {
    const account = await this.getAccountById(emailAccountId);
    await this.withClient(account, async (client) => {
      await client.mailboxOpen('INBOX');
    });
    return { success: true, email: account.email, provider: account.provider };
  }
}

module.exports = new EmailInboxService();
