const { ImapFlow } = require('imapflow');
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const pool = require('./db');

chromium.use(stealth);

/**
 * IMAP configs for providers we store in email_accounts.
 * Outlook/Hotmail often reject basic auth — we fall back to Outlook web scrape.
 */
const IMAP_HOSTS = {
  yahoo: { host: 'imap.mail.yahoo.com', port: 993 },
  gmx: { host: 'imap.gmx.com', port: 993 },
  outlook: { host: 'outlook.office365.com', port: 993, altHosts: ['imap-mail.outlook.com'] },
  hotmail: { host: 'outlook.office365.com', port: 993, altHosts: ['imap-mail.outlook.com'] },
  live: { host: 'outlook.office365.com', port: 993, altHosts: ['imap-mail.outlook.com'] },
  'mail.com': { host: 'imap.mail.com', port: 993 },
  yandex: { host: 'imap.yandex.com', port: 993 },
};

const MICROSOFT_PROVIDERS = new Set(['outlook', 'hotmail', 'live']);

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
    const hosts = [cfg.host, ...(IMAP_HOSTS[cfg.provider]?.altHosts || [])];
    let lastErr;

    for (const host of hosts) {
      const client = new ImapFlow({
        host,
        port: cfg.port,
        secure: cfg.secure,
        auth: cfg.auth,
        logger: false,
        greetingTimeout: 20000,
        socketTimeout: 60000,
      });

      try {
        await client.connect();
        try {
          return await fn(client, { ...cfg, host });
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
      } catch (err) {
        lastErr = err;
        console.warn(`IMAP ${host} failed for ${account.email}: ${err.message}`);
      }
    }

    throw lastErr || new Error('IMAP connection failed');
  }

  isMicrosoftAccount(account) {
    const provider = providerFromEmail(account.email, account.provider);
    return MICROSOFT_PROVIDERS.has(provider);
  }

  /**
   * Outlook/Hotmail webmail fallback when IMAP basic auth is disabled.
   */
  async fetchViaOutlookWeb(account, { limit = 10 } = {}) {
    const executablePath =
      process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ||
      process.env.CHROMIUM_PATH ||
      undefined;

    const browser = await chromium.launch({
      headless: true,
      executablePath,
      args: ['--disable-blink-features=AutomationControlled'],
    });

    try {
      const context = await browser.newContext({
        viewport: { width: 1280, height: 900 },
        userAgent:
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        locale: 'en-US',
      });
      const page = await context.newPage();
      page.setDefaultTimeout(45000);

      await page.goto('https://login.live.com/', { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('input[type="email"], input[name="loginfmt"]', { timeout: 20000 });
      await page.fill('input[type="email"], input[name="loginfmt"]', account.email);
      await page.click('input[type="submit"], button[type="submit"]');
      await page.waitForTimeout(1500);

      await page.waitForSelector('input[type="password"], input[name="passwd"]', { timeout: 20000 });
      await page.fill('input[type="password"], input[name="passwd"]', account.password);
      await page.click('input[type="submit"], button[type="submit"]');
      await page.waitForTimeout(2500);

      // Stay signed in / skip prompts
      const kmSI = await page.$('input[type="submit"][value*="Yes"], button:has-text("Yes"), input#idSIButton9');
      if (kmSI) {
        await kmSI.click().catch(() => {});
        await page.waitForTimeout(1500);
      }

      const bodyText = await page.evaluate(() => (document.body?.innerText || '').slice(0, 500));
      if (/incorrect|wrong password|doesn't exist|too many times|help us protect/i.test(bodyText)) {
        throw new Error(`Outlook web login failed: ${bodyText.slice(0, 160)}`);
      }

      await page.goto('https://outlook.live.com/mail/0/', {
        waitUntil: 'domcontentloaded',
        timeout: 60000,
      });
      await page.waitForTimeout(4000);

      // Dismiss any leftover consent
      const yesBtn = await page.$('input[type="submit"][value*="Yes"], button:has-text("Yes")');
      if (yesBtn) await yesBtn.click().catch(() => {});

      await page.waitForTimeout(3000);

      const rows = await page.evaluate((max) => {
        const items = [];
        const nodes = document.querySelectorAll(
          '[role="option"], [role="row"], [aria-label*="Unread"], [aria-label*="Read"], div[class*="jGG6V"]'
        );
        for (const n of nodes) {
          const label = n.getAttribute('aria-label') || n.innerText || '';
          if (label.length < 8) continue;
          items.push(label.replace(/\s+/g, ' ').trim().slice(0, 500));
          if (items.length >= max) break;
        }
        // Fallback: scan visible list text blocks
        if (!items.length) {
          const text = (document.body?.innerText || '').split('\n').map((s) => s.trim()).filter(Boolean);
          for (const line of text) {
            if (line.length > 20 && line.length < 300) items.push(line);
            if (items.length >= max) break;
          }
        }
        return items;
      }, limit);

      const messages = rows.map((preview, idx) => {
        const codes = extractCodes(preview);
        const urls = extractUrls(preview);
        return {
          uid: `web-${idx}`,
          subject: preview.slice(0, 120),
          from: [],
          date: null,
          codes,
          verifyLinks: pickVerificationLinks(urls),
          urls,
          preview,
          source: 'outlook_web',
        };
      });

      return messages;
    } finally {
      await browser.close().catch(() => {});
    }
  }

  async fetchRecentMessagesWithFallback(account, opts = {}) {
    try {
      return {
        method: 'imap',
        messages: await this.fetchRecentMessages(account, opts),
      };
    } catch (imapErr) {
      if (!this.isMicrosoftAccount(account)) throw imapErr;
      console.warn(
        `IMAP failed for ${account.email} (${imapErr.message}); trying Outlook web…`
      );
      const messages = await this.fetchViaOutlookWeb(account, opts);
      return { method: 'outlook_web', messages, imapError: imapErr.message };
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
  pickLatestFromMessages(messages, { fromIncludes, subjectIncludes } = {}) {
    const filtered = (messages || []).filter((m) => {
      if (fromIncludes) {
        const needle = String(fromIncludes).toLowerCase();
        const hay = `${(m.from || []).join(' ')} ${m.subject || ''} ${m.preview || ''}`.toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      if (subjectIncludes) {
        const needle = String(subjectIncludes).toLowerCase();
        if (!String(m.subject || m.preview || '').toLowerCase().includes(needle)) return false;
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
      scanned: (messages || []).length,
    };
  }

  async getLatestVerification(account, { limit = 15, fromIncludes, subjectIncludes } = {}) {
    const { messages } = await this.fetchRecentMessagesWithFallback(account, { limit });
    return this.pickLatestFromMessages(messages, { fromIncludes, subjectIncludes });
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
    const fetched = await this.fetchRecentMessagesWithFallback(account, {
      limit: opts.limit || 10,
    });
    const messages = fetched.messages;
    const latest = this.pickLatestFromMessages(messages, {
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
          last_inbox_method: fetched.method,
          last_inbox_count: messages.length,
          last_imap_error: fetched.imapError || null,
        }),
      ]
    ).catch(() => {});

    return {
      emailAccountId,
      email: account.email,
      provider: account.provider,
      method: fetched.method,
      imapError: fetched.imapError || null,
      messages,
      latestVerification: latest,
    };
  }

  async testImapLogin(emailAccountId) {
    const account = await this.getAccountById(emailAccountId);
    try {
      await this.withClient(account, async (client) => {
        await client.mailboxOpen('INBOX');
      });
      return { success: true, method: 'imap', email: account.email, provider: account.provider };
    } catch (err) {
      if (!this.isMicrosoftAccount(account)) throw err;
      const messages = await this.fetchViaOutlookWeb(account, { limit: 3 });
      return {
        success: true,
        method: 'outlook_web',
        email: account.email,
        provider: account.provider,
        imapError: err.message,
        sampleCount: messages.length,
      };
    }
  }
}

module.exports = new EmailInboxService();
