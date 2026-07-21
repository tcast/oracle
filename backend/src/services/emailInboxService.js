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
  return matches
    .map((u) => u.replace(/[),.;]+$/, ''))
    .map((u) => unwrapTrackedUrl(u))
    .filter((u, i, arr) => u && arr.indexOf(u) === i);
}

/** Reddit wraps destinations in click.redditmail.com/CL0/https:%2F%2F... */
function unwrapTrackedUrl(url) {
  const raw = String(url || '');
  try {
    if (/click\.redditmail\.com\/CL0\//i.test(raw)) {
      const encoded = raw.split(/click\.redditmail\.com\/CL0\//i)[1]?.split('/')[0];
      if (encoded) {
        const decoded = decodeURIComponent(encoded);
        if (/^https?:/i.test(decoded)) return decoded;
      }
    }
  } catch (_) {
    /* keep original */
  }
  return raw;
}

function isPasswordResetUrl(url) {
  const u = unwrapTrackedUrl(url).toLowerCase();
  if (!/reddit\.com/i.test(u)) return false;
  return /password|reset|recover|change.?password|accountrecovery|forgot/i.test(u);
}

/** Strip transport headers — non-MIME bodies often lack Content-Type. */
function extractMessageBody(raw) {
  const text = String(raw || '');
  const textParts = [];
  const htmlMatch = text.match(
    /Content-Type:\s*text\/html[\s\S]*?\r?\n\r?\n([\s\S]*?)(?=\r?\n--|\r?\n\r?\nContent-Type:|$)/i
  );
  const plainMatch = text.match(
    /Content-Type:\s*text\/plain[\s\S]*?\r?\n\r?\n([\s\S]*?)(?=\r?\n--|\r?\n\r?\nContent-Type:|$)/i
  );
  if (plainMatch) textParts.push(plainMatch[1]);
  if (htmlMatch) textParts.push(htmlMatch[1].replace(/<[^>]+>/g, ' '));
  if (textParts.length) {
    return textParts.join('\n').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
  }
  const sep = text.search(/\r?\n\r?\n/);
  const body = sep >= 0 ? text.slice(sep).replace(/^\r?\n\r?\n/, '') : text;
  return body.replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

function isNoisyCode(code) {
  if (/^(19|20)\d{2}$/.test(code)) return true;
  if (/^0+$/.test(code)) return true;
  return false;
}

function extractCodes(text) {
  const raw = String(text || '');
  const preferred = [];
  const prefRe =
    /(?:verification\s*code|security\s*code|one[-\s]?time(?:\s*code)?|otp|code(?:\s*is)?)\s*[:=]?\s*(\d{4,8})\b/gi;
  let m;
  while ((m = prefRe.exec(raw)) !== null) {
    const code = m[1];
    if (isNoisyCode(code)) continue;
    if (!preferred.includes(code)) preferred.push(code);
  }
  if (preferred.length) return preferred;

  const found = [];
  const re = new RegExp(CODE_REGEX.source, 'g');
  while ((m = re.exec(raw)) !== null) {
    const code = m[1];
    if (isNoisyCode(code)) continue;
    if (!found.includes(code)) found.push(code);
  }
  return found;
}

function messageMentionsAddress(msg, address) {
  const want = String(address || '').toLowerCase();
  if (!want) return true;
  const blob = [
    ...(msg.to || []),
    msg.subject || '',
    msg.preview || '',
    msg.rawHeaders || '',
  ]
    .join(' ')
    .toLowerCase();
  return blob.includes(want);
}

function pickVerificationLinks(urls) {
  const unwrapped = (urls || []).map(unwrapTrackedUrl);
  const reset = unwrapped.filter(isPasswordResetUrl);
  if (reset.length) return reset;
  return unwrapped.filter((u) =>
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

  isYahooAccount(account) {
    return providerFromEmail(account.email, account.provider) === 'yahoo';
  }

  /**
   * Yahoo webmail fallback when IMAP auth fails (common on freshly minted accounts).
   */
  async fetchViaYahooWeb(account, { limit = 10, timeoutMs = 120000, searchQuery = null } = {}) {
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

      const context = await browser.newContext({
        viewport: { width: 1280, height: 900 },
        userAgent:
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        locale: 'en-US',
      });
      const page = await context.newPage();
      page.setDefaultTimeout(25000);

      await page.goto('https://login.yahoo.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForSelector('#login-username, input[name="username"]', { timeout: 25000 });
      await page.fill('#login-username, input[name="username"]', account.email);
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {}),
        page.click('#login-signin, button[type="submit"], input[type="submit"]'),
      ]);
      await page.waitForTimeout(1200);

      const pwSel = '#login-passwd, input[name="password"], input[type="password"]';
      await page.waitForSelector(pwSel, { timeout: 25000 });
      await page.fill(pwSel, account.password);
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {}),
        page.click('#login-signin, button[type="submit"], input[type="submit"]'),
      ]);
      await page.waitForTimeout(2500);

      // Dismiss optional challenges / "stay signed in" where possible
      for (let i = 0; i < 4; i++) {
        const challenge = await page.evaluate(() => {
          const text = (document.body?.innerText || '').slice(0, 500);
          return {
            text,
            badPw: /invalid|incorrect|didn't match|wrong password|try again/i.test(text),
            blocked: /suspicious|verify your identity|phone|captcha|unusual/i.test(text),
            inMail: /mail\.yahoo\.com|inbox/i.test(location.href + ' ' + text),
          };
        }).catch(() => ({ text: '', badPw: false, blocked: false, inMail: false }));

        if (challenge.badPw) {
          throw new Error(`Yahoo web login failed: ${challenge.text.slice(0, 160)}`);
        }
        if (challenge.blocked && !challenge.inMail) {
          throw new Error(`Yahoo web login blocked: ${challenge.text.slice(0, 160)}`);
        }
        if (challenge.inMail || /mail\.yahoo\.com/i.test(page.url())) break;

        const clicked = await page.evaluate(() => {
          const btn = [...document.querySelectorAll('button, a, input[type="submit"]')].find((el) =>
            /^(Yes|Next|Continue|Skip|Not now|Maybe later|Go to Inbox)$/i.test(
              (el.innerText || el.value || '').trim()
            )
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

      if (!/mail\.yahoo\.com/i.test(page.url())) {
        await page.goto('https://mail.yahoo.com/', {
          waitUntil: 'domcontentloaded',
          timeout: 60000,
        });
      }
      await page.waitForTimeout(3500);

      // Search is best-effort — #mail-search is often a clickable div, not an input.
      const q = searchQuery || 'reddit';
      try {
        const searchBox = page.locator('#mail-search, [data-test-id="search-input"], button[aria-label*="Search" i]').first();
        if (await searchBox.isVisible().catch(() => false)) {
          await searchBox.click({ timeout: 5000 }).catch(() => {});
          await page.waitForTimeout(800);
        }
        const searchInput = page
          .locator(
            'input[placeholder*="Search" i], input[aria-label*="Search" i], input[name="q"], input[data-test-id="search-input"], #mail-search input'
          )
          .first();
        if (await searchInput.isVisible().catch(() => false)) {
          await searchInput.fill(String(q));
          await page.keyboard.press('Enter');
          await page.waitForTimeout(3500);
        }
      } catch (searchErr) {
        console.warn(`Yahoo web search skipped: ${searchErr.message}`);
      }

      const rows = await page.evaluate((max) => {
        const items = [];
        const nodes = [
          ...document.querySelectorAll(
            '[data-test-id="message-list-item"], [role="option"], li[data-test-id], div[data-test-id="message-list"] li, a[data-test-id="message-item"]'
          ),
        ];
        for (const n of nodes) {
          const label = (n.getAttribute('aria-label') || n.innerText || '')
            .replace(/\s+/g, ' ')
            .trim();
          if (label.length < 8) continue;
          if (!/reddit|verify|code|password|confirm|@/i.test(label) && items.length > 2) continue;
          items.push({ preview: label.slice(0, 500), index: items.length });
          if (items.length >= max) break;
        }
        // Fallback: any visible list-ish rows mentioning reddit
        if (!items.length) {
          const blob = (document.body?.innerText || '').slice(0, 12000);
          const lines = blob
            .split('\n')
            .map((l) => l.replace(/\s+/g, ' ').trim())
            .filter((l) => l.length > 12 && /reddit/i.test(l));
          for (const line of lines.slice(0, max)) {
            items.push({ preview: line.slice(0, 500), index: items.length });
          }
        }
        return items;
      }, limit);

      let openedBody = null;
      let openIdx = rows.findIndex((r) => /reddit|verify|code|confirm/i.test(r.preview || ''));
      if (openIdx < 0 && rows.length) openIdx = 0;

      if (openIdx >= 0) {
        const clicked = await page.evaluate((idx) => {
          const nodes = [
            ...document.querySelectorAll(
              '[data-test-id="message-list-item"], [role="option"], li[data-test-id], a[data-test-id="message-item"]'
            ),
          ].filter((n) => {
            const label = (n.getAttribute('aria-label') || n.innerText || '')
              .replace(/\s+/g, ' ')
              .trim();
            return label.length >= 8;
          });
          const target = nodes[idx] || nodes[0];
          if (!target) return false;
          target.click();
          return true;
        }, openIdx).catch(() => false);

        if (clicked) {
          await page.waitForTimeout(2500);
          openedBody = await page.evaluate(() => {
            const reading =
              document.querySelector('[data-test-id="message-view"], [data-test-id="message-group"], .thread-item, main') ||
              document.body;
            const text = (reading?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 8000);
            const hrefs = [...reading.querySelectorAll('a[href]')]
              .map((a) => a.href)
              .filter((h) => /^https?:/i.test(h))
              .slice(0, 40);
            return { text, hrefs };
          }).catch(() => null);
        }
      }

      return rows.map((row, idx) => {
        const preview = row.preview || '';
        const isOpened = openedBody && idx === openIdx;
        const body = isOpened ? `${preview} ${openedBody.text || ''}` : preview;
        const urls = [
          ...extractUrls(body),
          ...(isOpened ? openedBody.hrefs || [] : []),
        ].filter((u, i, arr) => arr.indexOf(u) === i);
        const codes = extractCodes(body);
        return {
          uid: `yahoo-web-${idx}`,
          subject: preview.slice(0, 120),
          from: /reddit/i.test(preview) ? ['reddit'] : [],
          date: null,
          codes,
          verifyLinks: pickVerificationLinks(urls),
          urls,
          preview: body.slice(0, 400),
          source: 'yahoo_web',
        };
      });
    };

    let timer;
    try {
      return await Promise.race([
        run(),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`Yahoo web fetch timed out after ${timeoutMs}ms`)),
            timeoutMs
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      if (browser) await browser.close().catch(() => {});
    }
  }

  /**
   * Outlook/Hotmail webmail fallback when IMAP basic auth is disabled.
   * Bought Reddit resets live here — discovery must be broad (inbox/Other/junk,
   * multiple search queries) because seller Hotmail often hides Reddit in junk
   * or Focused/Other, and empty Outlook search results previously returned scanned=0.
   */
  async fetchViaOutlookWeb(account, { limit = 15, timeoutMs = 150000, searchQuery = null } = {}) {
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

      for (let i = 0; i < 4; i++) {
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
      await page.waitForTimeout(3500);

      const NAV_REJECT =
        /^(File|Home|View|Help|New mail|Delete|Archive|Report|Move to|Reply|Mark all|Flag|Enhance|Browse|Navigation|Reading Pane|Read \/ Unread|Focused|Other|Inbox|Junk|Drafts|Sent|Deleted|Select an item|To Do|Notes|Folders)/i;
      const INTERESTING =
        /reddit|password|reset|recover|noreply|redditmail|change.?password|account.?security|r\/|@/i;

      const collectRows = async (max = limit) =>
        page.evaluate(
          ({ maxRows, rejectSrc, interestingSrc }) => {
            const reject = new RegExp(rejectSrc, 'i');
            const interesting = new RegExp(interestingSrc, 'i');
            const seen = new Set();
            const items = [];
            const nodes = [
              ...document.querySelectorAll(
                '[role="option"], [role="row"], div[data-convid], div[aria-label*="Unread" i], div[aria-label*="Reddit" i], div[aria-label*="password" i]'
              ),
            ];
            for (const n of nodes) {
              const label = (n.getAttribute('aria-label') || n.innerText || '')
                .replace(/\s+/g, ' ')
                .trim();
              if (label.length < 10) continue;
              if (reject.test(label)) continue;
              const key = label.slice(0, 160).toLowerCase();
              if (seen.has(key)) continue;
              seen.add(key);
              items.push({
                preview: label.slice(0, 500),
                interesting: interesting.test(label),
              });
            }
            // Prefer likely reset/reddit rows, but keep generic inbox rows as fallback.
            items.sort((a, b) => Number(b.interesting) - Number(a.interesting));
            if (items.length) return items.slice(0, maxRows);

            // Last resort: scrape visible body lines (virtualized list / odd DOM).
            const blob = (document.body?.innerText || '').slice(0, 16000);
            const lines = blob
              .split('\n')
              .map((l) => l.replace(/\s+/g, ' ').trim())
              .filter((l) => l.length > 14 && interesting.test(l) && !reject.test(l));
            return lines.slice(0, maxRows).map((preview) => ({ preview, interesting: true }));
          },
          { maxRows: max, rejectSrc: NAV_REJECT.source, interestingSrc: INTERESTING.source }
        );

      const clickOtherTab = async () => {
        const clicked = await page.evaluate(() => {
          const el = [...document.querySelectorAll('button, [role="tab"], span, div')].find((n) =>
            /^(Other)$/i.test((n.innerText || '').trim())
          );
          if (!el) return false;
          el.click();
          return true;
        }).catch(() => false);
        if (clicked) await page.waitForTimeout(2000);
        return clicked;
      };

      const clearSearch = async (folderUrl) => {
        await page.keyboard.press('Escape').catch(() => {});
        const search = page
          .locator('input[aria-label*="Search" i], input[placeholder*="Search" i]')
          .first();
        if (await search.isVisible().catch(() => false)) {
          await search.fill('');
          await page.keyboard.press('Escape').catch(() => {});
          await page.waitForTimeout(400);
        }
        // Hard reset: empty Outlook search results are sticky — re-open folder.
        if (folderUrl) {
          await page.goto(folderUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
          await page.waitForTimeout(2500);
        }
      };

      const runSearch = async (q) => {
        if (!q) return false;
        const search = page
          .locator('input[aria-label*="Search" i], input[placeholder*="Search" i]')
          .first();
        if (!(await search.isVisible().catch(() => false))) return false;
        await search.click({ clickCount: 3 }).catch(() => {});
        await search.fill(String(q));
        await page.keyboard.press('Enter');
        await page.waitForTimeout(4000);
        return true;
      };

      const rowLooksLikeReset = (r) =>
        /password|reset|recover|change.?password|account.?security/i.test(r?.preview || '');
      const rowLooksLikeReddit = (r) =>
        /reddit|redditmail|noreply/i.test(r?.preview || '') || rowLooksLikeReset(r);

      const openCandidatesInView = async (candidateRows) => {
        const openOrder = candidateRows
          .map((r, idx) => ({ r, idx }))
          .sort((a, b) => {
            const score = (row) =>
              (rowLooksLikeReset(row) ? 5 : 0) + (rowLooksLikeReddit(row) ? 2 : 0);
            return score(b.r) - score(a.r);
          })
          .slice(0, 6);

        const openedByIdx = {};
        for (const { r, idx } of openOrder) {
          const targetPreview = r?.preview || '';
          const clicked = await page.evaluate((want) => {
            const reject =
              /^(File|Home|View|Help|New mail|Delete|Archive|Report|Reading Pane|Read \/ Unread)/i;
            const nodes = [
              ...document.querySelectorAll(
                '[role="option"], [role="row"], div[data-convid], div[aria-label*="Unread" i]'
              ),
            ];
            const needle = String(want || '').slice(0, 48);
            let target = null;
            for (const n of nodes) {
              const label = (n.getAttribute('aria-label') || n.innerText || '')
                .replace(/\s+/g, ' ')
                .trim();
              if (label.length < 10 || reject.test(label)) continue;
              if (needle && label.includes(needle)) {
                target = n;
                break;
              }
              if (!target) target = n;
            }
            if (!target) return false;
            target.scrollIntoView?.({ block: 'center' });
            target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
            return true;
          }, targetPreview).catch(() => false);

          if (!clicked) continue;
          await page.waitForTimeout(3000);
          const openedBody = await page.evaluate(() => {
            const reading = document.querySelector(
              '[role="main"], [aria-label*="Reading Pane"], .ReadingPaneContents, #ReadingPaneContainerId'
            );
            const root = reading || document.body;
            const text = (root?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 12000);
            const hrefs = [...root.querySelectorAll('a[href]')]
              .map((a) => a.href)
              .filter((h) => /^https?:/i.test(h))
              .slice(0, 60);
            return { text, hrefs };
          }).catch(() => null);
          if (!openedBody) continue;
          openedByIdx[idx] = openedBody;
          const blob = `${targetPreview} ${openedBody.text || ''} ${(openedBody.hrefs || []).join(' ')}`;
          if (/reddit\.com/i.test(blob) && /password|reset|recover|change/i.test(blob)) {
            break;
          }
        }

        return candidateRows.map((row, idx) => {
          const preview = row.preview || '';
          const openedBody = openedByIdx[idx];
          const body = openedBody ? `${preview} ${openedBody.text || ''}` : preview;
          const urls = [
            ...extractUrls(body),
            ...(openedBody?.hrefs || []),
          ].filter((u, i, arr) => arr.indexOf(u) === i);
          const codes = extractCodes(body);
          const fromReddit = /reddit|redditmail|noreply/i.test(preview + body);
          return {
            uid: `web-${idx}`,
            subject: preview.slice(0, 160),
            from: fromReddit ? ['reddit'] : [],
            date: null,
            codes,
            verifyLinks: pickVerificationLinks(urls),
            urls,
            preview: body.slice(0, 600),
            source: 'outlook_web',
            opened: !!openedBody,
          };
        });
      };

      const hasResetLink = (msgs) =>
        (msgs || []).some((m) =>
          (m.urls || m.verifyLinks || []).some((u) =>
            /reddit\.com/i.test(u) && /password|reset|recover|change|account/i.test(u)
          )
        );

      // Keep this tight — outer Promise.race kills the browser at timeoutMs.
      const searchQueries = [
        ...(searchQuery ? [String(searchQuery)] : ['from:reddit']),
        'reddit password',
      ].filter((q, i, arr) => q && arr.indexOf(q) === i).slice(0, 2);

      const folders = [
        'https://outlook.live.com/mail/0/',
        'https://outlook.live.com/mail/0/junkemail',
      ];

      let messages = [];
      let diagnostics = [];

      for (const folderUrl of folders) {
        await page.goto(folderUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
        await page.waitForTimeout(2500);
        await page
          .waitForSelector('[role="option"], [role="row"], div[data-convid]', { timeout: 12000 })
          .catch(() => {});

        for (const pass of ['primary', 'other']) {
          if (pass === 'other') {
            if (!/mail\/0\/?$/i.test(folderUrl) && !/\/inbox/i.test(folderUrl)) break;
            const switched = await clickOtherTab();
            if (!switched) continue;
          }

          let rows = await collectRows(limit);
          diagnostics.push({
            folderUrl,
            pass,
            mode: 'list',
            count: rows.length,
            sample: rows.slice(0, 2).map((r) => (r.preview || '').slice(0, 80)),
          });

          if (rows.length) {
            // Open while this folder view is still on screen (navigating away loses the DOM).
            const opened = await openCandidatesInView(rows);
            if (opened.some((m) => m.opened) || opened.length >= messages.length) {
              messages = opened;
            }
            if (hasResetLink(opened) || opened.some((m) => rowLooksLikeReset({ preview: m.subject }))) {
              if (hasResetLink(opened)) {
                messages = opened;
                break;
              }
            }
          }

          if (pass === 'primary' && /mail\/0\/?$/i.test(folderUrl)) {
            for (const q of searchQueries) {
              await runSearch(q);
              rows = await collectRows(limit);
              diagnostics.push({
                folderUrl,
                pass,
                mode: `search:${q}`,
                count: rows.length,
                sample: rows.slice(0, 2).map((r) => (r.preview || '').slice(0, 80)),
              });
              if (rows.length) {
                const opened = await openCandidatesInView(rows);
                if (hasResetLink(opened) || opened.some((m) => m.opened)) {
                  messages = opened;
                }
                if (hasResetLink(opened)) break;
              }
              await clearSearch(folderUrl);
            }
          }
          if (hasResetLink(messages)) break;
        }
        if (hasResetLink(messages)) break;
      }

      if (!messages.length) {
        console.warn(
          `Outlook web scrape found 0 rows for ${account.email}:`,
          JSON.stringify({
            url: page.url(),
            diagnostics: diagnostics.slice(-8),
          })
        );
      }

      console.warn(
        `Outlook web scrape ${account.email}: rows=${messages.length} opened=${messages.filter((m) => m.opened).length} ` +
          `withLinks=${messages.filter((m) => (m.urls || []).length).length} ` +
          `sample=${JSON.stringify(
            messages.slice(0, 3).map((m) => ({
              s: (m.subject || '').slice(0, 60),
              links: (m.urls || []).slice(0, 2),
              opened: !!m.opened,
            }))
          )}`
      );

      return messages;
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
      if (this.isMicrosoftAccount(account)) {
        console.warn(
          `IMAP failed for ${account.email} (${imapErr.message}); trying Outlook web…`
        );
        const messages = await this.fetchViaOutlookWeb(account, opts);
        return { method: 'outlook_web', messages, imapError: imapErr.message };
      }
      if (this.isYahooAccount(account)) {
        console.warn(
          `IMAP failed for ${account.email} (${imapErr.message}); trying Yahoo web…`
        );
        const messages = await this.fetchViaYahooWeb(account, opts);
        return { method: 'yahoo_web', messages, imapError: imapErr.message };
      }
      throw imapErr;
    }
  }

  /**
   * Fetch recent messages (headers + body text/html snippet).
   * For catch-all pool mailboxes, IMAP-search by To/alias so we don't miss
   * verification mail buried under other aliases' traffic.
   */
  async fetchRecentMessages(account, { limit = 10, mailbox = 'INBOX' } = {}) {
    return this.withClient(account, async (client) => {
      const lock = await client.getMailboxLock(mailbox);
      try {
        const status = client.mailbox;
        const total = status?.exists || 0;
        if (!total) return [];

        const cfg = this.resolveImapConfig(account);
        const alias = cfg.catchallAddress ? String(cfg.catchallAddress).toLowerCase() : null;
        let seq = null;

        if (alias) {
          try {
            // Prefer messages addressed to this alias (shared pool inbox).
            // Try several IMAP search strategies — To: indexing varies by server.
            const localPart = alias.split('@')[0];
            const attempts = [
              { to: alias },
              { header: { To: alias } },
              { body: alias },
              localPart ? { body: localPart } : null,
              { or: [{ to: alias }, { from: 'reddit.com' }] },
            ].filter(Boolean);
            let uids = null;
            for (const criteria of attempts) {
              try {
                uids = await client.search(criteria, { uid: true });
                if (uids?.length) break;
              } catch (_) {
                /* try next strategy */
              }
            }
            if (uids?.length) {
              const slice = uids.slice(-Math.max(limit, 40));
              seq = { uid: true, set: slice.join(',') };
            }
          } catch (searchErr) {
            console.warn(
              `IMAP catchall search failed for ${alias}: ${searchErr.message}; falling back to recent`
            );
          }
        }

        if (!seq) {
          const start = Math.max(1, total - Math.max(limit, alias ? 80 : 10) + 1);
          seq = { uid: false, set: `${start}:${total}` };
        }

        const messages = [];
        const fetchOpts = { envelope: true, source: true, uid: true };
        for await (const msg of client.fetch(seq.set, fetchOpts, seq.uid ? { uid: true } : undefined)) {
          const raw = msg.source ? msg.source.toString('utf8') : '';
          const headerEnd = raw.search(/\r?\n\r?\n/);
          const rawHeaders = headerEnd >= 0 ? raw.slice(0, headerEnd) : '';
          const body = extractMessageBody(raw);
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
            rawHeaders: rawHeaders.slice(0, 2000),
          });
        }

        // Newest first
        let out = messages.sort((a, b) => {
          const da = a.date ? new Date(a.date).getTime() : 0;
          const db = b.date ? new Date(b.date).getTime() : 0;
          return db - da;
        });
        if (alias) {
          out = out.filter((m) => messageMentionsAddress(m, alias));
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
  pickLatestFromMessages(messages, { fromIncludes, subjectIncludes, afterDate, linkIncludes, requirePasswordReset = false } = {}) {
    const afterMs = afterDate ? new Date(afterDate).getTime() : null;
    const subjectNeedles = subjectIncludes
      ? (Array.isArray(subjectIncludes) ? subjectIncludes : [subjectIncludes]).map((s) =>
          String(s).toLowerCase()
        )
      : [];
    const fromNeedles = fromIncludes
      ? (Array.isArray(fromIncludes) ? fromIncludes : [fromIncludes]).map((s) =>
          String(s).toLowerCase()
        )
      : [];

    const filtered = (messages || []).filter((m) => {
      if (afterMs && m.date) {
        const t = new Date(m.date).getTime();
        if (!Number.isNaN(t) && t < afterMs - 60_000) return false;
      }
      const hay = `${(m.from || []).join(' ')} ${m.subject || ''} ${m.preview || ''}`.toLowerCase();
      if (fromNeedles.length && !fromNeedles.some((n) => hay.includes(n))) return false;
      if (subjectNeedles.length && !subjectNeedles.some((n) => hay.includes(n))) return false;
      const links = [...(m.verifyLinks || []), ...(m.urls || [])].map(unwrapTrackedUrl);
      const resetLinks = links.filter(isPasswordResetUrl);
      if (requirePasswordReset) {
        const subjectOk = /password|reset|recover|change.?password/i.test(hay);
        if (!resetLinks.length && !subjectOk) return false;
        if (!resetLinks.length && subjectOk && !links.length) return false;
      }
      if (linkIncludes) {
        const needle = String(linkIncludes).toLowerCase();
        const hasLink =
          resetLinks.length > 0 ||
          links.some((u) => String(u).toLowerCase().includes(needle));
        if (!hasLink && !(m.codes && m.codes.length)) return false;
      }
      return (m.codes && m.codes.length) || (links && links.length);
    });

    filtered.sort((a, b) => {
      const score = (m) => {
        const t = `${m.subject || ''} ${m.preview || ''}`.toLowerCase();
        const links = [...(m.verifyLinks || []), ...(m.urls || [])].map(unwrapTrackedUrl);
        let s = 0;
        if (/password|reset|recover/i.test(t)) s += 8;
        if (links.some(isPasswordResetUrl)) s += 10;
        if (/reddit/i.test(t)) s += 1;
        if ((m.verifyLinks || []).length) s += 1;
        return s;
      };
      return score(b) - score(a);
    });

    const best = filtered[0] || null;
    const links = [
      ...(best?.verifyLinks || []),
      ...(best?.urls || []),
    ].map(unwrapTrackedUrl);
    const resetLink =
      links.find(isPasswordResetUrl) ||
      (requirePasswordReset ? null : links.find((u) => /reddit\.com/i.test(u))) ||
      (requirePasswordReset ? null : links[0]) ||
      null;
    const found = requirePasswordReset
      ? !!(best && resetLink && isPasswordResetUrl(resetLink))
      : !!best;
    return {
      found,
      code: best?.codes?.[0] || null,
      link: resetLink,
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
      if (this.isMicrosoftAccount(account)) {
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
      if (this.isYahooAccount(account)) {
        const messages = await this.fetchViaYahooWeb(account, { limit: 3 });
        return {
          success: true,
          method: 'yahoo_web',
          email: account.email,
          provider: account.provider,
          imapError: err.message,
          sampleCount: messages.length,
        };
      }
      throw err;
    }
  }
}

module.exports = new EmailInboxService();
