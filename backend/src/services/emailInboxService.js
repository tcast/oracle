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
  'password',
  'reset',
  'change-password',
  'accountrecovery',
  'forgot',
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
    const meta = account.metadata || {};
    const provider = providerFromEmail(account.email, account.provider);
    const base = provider ? IMAP_HOSTS[provider] : null;

    // Catch-all / custom domain pool: IMAP creds live in metadata
    if (meta.imap_host || meta.catchall || account.provider === 'catchall') {
      const insecure =
        meta.imap_tls_reject_unauthorized === false ||
        process.env.MAIL_IMAP_TLS_INSECURE === '1' ||
        true; // self-signed cert on mail.proteusmail.net for now
      return {
        provider: provider || 'catchall',
        host: meta.imap_host || process.env.MAIL_IMAP_IP || process.env.MAIL_IMAP_HOST,
        port: meta.imap_port || Number(process.env.MAIL_IMAP_PORT || 993),
        secure: true,
        tls: { rejectUnauthorized: !insecure },
        auth: {
          user: meta.imap_user || process.env.MAIL_POOL_USER || account.email,
          pass: account.password,
        },
        catchallAddress: account.email,
      };
    }

    if (!base) {
      throw new Error(
        `No IMAP host for provider=${account.provider || '?'} email=${account.email}`
      );
    }
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
        greetingTimeout: 15000,
        socketTimeout: 30000,
        tls: cfg.tls,
      });
      client.on('error', () => {});

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
        try {
          client.close();
        } catch (_) {
          /* ignore */
        }
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
  async fetchViaOutlookWeb(account, { limit = 10, timeoutMs = 90000, searchQuery = null } = {}) {
    let browser;
    const run = async () => {
    const executablePath =
      process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ||
      process.env.CHROMIUM_PATH ||
      undefined;

    browser = await chromium.launch({
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
      page.setDefaultTimeout(25000);

      await page.goto('https://login.live.com/', { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('input[type="email"], input[name="loginfmt"]', { timeout: 20000 });
      await page.fill('input[type="email"], input[name="loginfmt"]', account.email);
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {}),
        page.click('input[type="submit"], button[type="submit"]'),
      ]);
      await page.waitForTimeout(1000);

      await page.waitForSelector('input[type="password"], input[name="passwd"]', { timeout: 20000 });
      await page.fill('input[type="password"], input[name="passwd"]', account.password);
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {}),
        page.click('input[type="submit"], button[type="submit"]'),
      ]);
      await page.waitForTimeout(2000);

      // Stay signed in / skip prompts (safe after navigation settles)
      for (let i = 0; i < 3; i++) {
        const url = page.url();
        if (/outlook\.live\.com|outlook\.office/i.test(url)) break;
        const challenge = await page.evaluate(() => {
          const text = (document.body?.innerText || '').slice(0, 400);
          return {
            text,
            hasPasswordError: /incorrect|wrong password|doesn't exist|too many times/i.test(text),
            hasProtect: /help us protect|verify your identity|approve/i.test(text),
          };
        }).catch(() => ({ text: '', hasPasswordError: false, hasProtect: false }));

        if (challenge.hasPasswordError) {
          throw new Error(`Outlook web login failed: ${challenge.text.slice(0, 160)}`);
        }
        if (challenge.hasProtect) {
          throw new Error(
            `Outlook web login blocked by identity challenge: ${challenge.text.slice(0, 160)}`
          );
        }

        const clicked = await page.evaluate(() => {
          const btn =
            document.querySelector('input#idSIButton9') ||
            document.querySelector('input[type="submit"][value*="Yes"]') ||
            [...document.querySelectorAll('button')].find((b) =>
              /^(Yes|Next|Continue)$/i.test((b.innerText || '').trim())
            );
          if (btn) {
            btn.click();
            return true;
          }
          return false;
        }).catch(() => false);
        if (clicked) await page.waitForTimeout(2000);
        else break;
      }

      if (!/outlook\.live\.com|outlook\.office/i.test(page.url())) {
        await page.goto('https://outlook.live.com/mail/0/', {
          waitUntil: 'domcontentloaded',
          timeout: 60000,
        });
      }
      await page.waitForTimeout(3000);
      await page
        .waitForSelector('[role="option"], [role="listbox"] [role="option"]', { timeout: 20000 })
        .catch(() => {});
      await page.waitForTimeout(1500);

      const collectRows = async () =>
        page.evaluate((max) => {
          const items = [];
          const reject =
            /^(File|Home|View|Help|New mail|Delete|Archive|Report|Move to|Reply|Mark all|Flag|Enhance|Browse|Navigation|Reading Pane|Read \/ Unread|Focused|Other|Inbox|Junk|Drafts|Sent|Deleted|Select an item)/i;
          const nodes = [...document.querySelectorAll(
            '[role="option"], [role="row"], div[data-convid], div[aria-label*="Reddit" i]'
          )];
          for (const n of nodes) {
            const label = (n.getAttribute('aria-label') || n.innerText || '')
              .replace(/\s+/g, ' ')
              .trim();
            if (label.length < 12) continue;
            if (reject.test(label)) continue;
            if (!/reddit|password|reset|@|message|r\//i.test(label)) continue;
            items.push({ preview: label.slice(0, 500), index: items.length });
            if (items.length >= max) break;
          }
          return items;
        }, limit);

      const runSearch = async (q) => {
        const search = page.locator('input[aria-label*="Search" i], input[placeholder*="Search" i]').first();
        if (q && (await search.isVisible().catch(() => false))) {
          await search.fill(String(q));
          await page.keyboard.press('Enter');
          await page.waitForTimeout(3500);
        }
      };

      let rows = [];
      const folders =
        searchQuery && /password/i.test(String(searchQuery))
          ? [
              'https://outlook.live.com/mail/0/junkemail',
              'https://outlook.live.com/mail/0/',
            ]
          : [null];

      for (const folderUrl of folders) {
        if (folderUrl) {
          await page.goto(folderUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
          await page.waitForTimeout(2500);
        }
        await runSearch(searchQuery);
        rows = await collectRows();
        if (rows.some((r) => /password|reset|recover/i.test(r.preview || ''))) break;
        if (!searchQuery) break;
        // Search returned nothing useful — try folder without search
        await runSearch('');
        await page.keyboard.press('Escape').catch(() => {});
        await page.waitForTimeout(1500);
        rows = await collectRows();
        if (rows.some((r) => /password|reset|recover/i.test(r.preview || ''))) break;
      }

      // Prefer password-reset subjects, else any Reddit message (for link scrape).
      let openedBody = null;
      let openIdx = rows.findIndex((r) => /password|reset|recover/i.test(r.preview || ''));
      if (openIdx < 0) openIdx = rows.findIndex((r) => /reddit/i.test(r.preview || ''));
      if (openIdx < 0 && rows.length) openIdx = 0;

      if (openIdx >= 0) {
        const clicked = await page.evaluate((idx) => {
          const reject =
            /^(File|Home|View|Help|New mail|Delete|Archive|Report|Reading Pane|Read \/ Unread)/i;
          const nodes = [...document.querySelectorAll(
            '[role="option"], [role="row"], div[data-convid], div[aria-label*="Reddit" i]'
          )].filter((n) => {
            const label = (n.getAttribute('aria-label') || n.innerText || '')
              .replace(/\s+/g, ' ')
              .trim();
            return label.length >= 12 && !reject.test(label) && /reddit|password|reset|@|r\//i.test(label);
          });
          const target = nodes[idx] || nodes[0];
          if (!target) return false;
          target.click();
          return true;
        }, openIdx).catch(() => false);

        if (clicked) {
          await page.waitForTimeout(3000);
          openedBody = await page.evaluate(() => {
            const reading = document.querySelector(
              '[role="main"], [aria-label*="Reading Pane"], .ReadingPaneContents, #ReadingPaneContainerId'
            );
            const root = reading || document.body;
            const text = (root?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 8000);
            const hrefs = [...root.querySelectorAll('a[href]')]
              .map((a) => a.href)
              .filter((h) => /^https?:/i.test(h))
              .slice(0, 40);
            return { text, hrefs };
          }).catch(() => null);
        }
      }

      const messages = rows.map((row, idx) => {
        const preview = row.preview || '';
        const isOpened = openedBody && idx === openIdx;
        const body = isOpened ? `${preview} ${openedBody.text || ''}` : preview;
        const urls = [
          ...extractUrls(body),
          ...(isOpened ? openedBody.hrefs || [] : []),
        ].filter((u, i, arr) => arr.indexOf(u) === i);
        const codes = extractCodes(body);
        return {
          uid: `web-${idx}`,
          subject: preview.slice(0, 120),
          from: /reddit/i.test(preview) ? ['reddit'] : [],
          date: null,
          codes,
          verifyLinks: pickVerificationLinks(urls),
          urls,
          preview: body.slice(0, 400),
          source: 'outlook_web',
        };
      });

      return messages;
    } finally {
      /* closed in outer finally */
    }
    };

    let timer;
    try {
      return await Promise.race([
        run(),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`Outlook web fetch timed out after ${timeoutMs}ms`)),
            timeoutMs
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      if (browser) await browser.close().catch(() => {});
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
            to: (msg.envelope?.to || []).map((a) => a.address || a.name).filter(Boolean),
            date: msg.envelope?.date || null,
            codes,
            verifyLinks,
            urls: urls.slice(0, 20),
            preview: body.slice(0, 400),
          });
        }

        // Newest first
        let out = messages.reverse();
        const cfg = this.resolveImapConfig(account);
        if (cfg.catchallAddress) {
          const want = String(cfg.catchallAddress).toLowerCase();
          out = out.filter((m) => {
            const blob = `${(m.to || []).join(' ')} ${m.preview || ''} ${m.subject || ''}`.toLowerCase();
            return blob.includes(want);
          });
        }
        return out;
      } finally {
        lock.release();
      }
    });
  }

  /**
   * Latest verification code/link across recent messages, optionally filtered by sender/subject.
   */
  pickLatestFromMessages(messages, { fromIncludes, subjectIncludes, afterDate, linkIncludes } = {}) {
    const afterMs = afterDate ? new Date(afterDate).getTime() : null;
    const filtered = (messages || []).filter((m) => {
      if (afterMs && m.date) {
        const t = new Date(m.date).getTime();
        if (!Number.isNaN(t) && t < afterMs - 60_000) return false;
      }
      if (fromIncludes) {
        const needle = String(fromIncludes).toLowerCase();
        const hay = `${(m.from || []).join(' ')} ${m.subject || ''} ${m.preview || ''}`.toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      if (subjectIncludes) {
        const needle = String(subjectIncludes).toLowerCase();
        if (!String(m.subject || m.preview || '').toLowerCase().includes(needle)) return false;
      }
      const links = m.verifyLinks || m.urls || [];
      if (linkIncludes) {
        const needle = String(linkIncludes).toLowerCase();
        const hasLink = links.some((u) => String(u).toLowerCase().includes(needle));
        if (!hasLink && !(m.codes && m.codes.length)) return false;
      }
      return (m.codes && m.codes.length) || (links && links.length);
    });

    const best = filtered[0] || null;
    const links = best?.verifyLinks?.length ? best.verifyLinks : best?.urls || [];
    return {
      found: !!best,
      code: best?.codes?.[0] || null,
      link: links[0] || null,
      codes: best?.codes || [],
      links,
      message: best,
      scanned: (messages || []).length,
    };
  }

  async getLatestVerification(
    account,
    { limit = 15, fromIncludes, subjectIncludes, afterDate, linkIncludes, searchQuery } = {}
  ) {
    const { messages } = await this.fetchRecentMessagesWithFallback(account, {
      limit,
      searchQuery,
      timeoutMs: searchQuery ? 120000 : 90000,
    });
    return this.pickLatestFromMessages(messages, {
      fromIncludes,
      subjectIncludes,
      afterDate,
      linkIncludes,
    });
  }

  async pollForVerification(
    account,
    {
      timeoutMs = 90000,
      intervalMs = 5000,
      fromIncludes,
      subjectIncludes,
      afterDate,
      linkIncludes,
      searchQuery,
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
        afterDate,
        linkIncludes,
        searchQuery,
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
