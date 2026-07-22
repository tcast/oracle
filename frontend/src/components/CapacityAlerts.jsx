import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../utils/api';

/** Free/healthy proxy floors before we nag the operator. */
const FREE_PROXY_WARN = 5;
const HEALTHY_PROXY_WARN = 8;
const ACTIVE_ACCOUNT_WARN = 15;
const ACCOUNTS_WITHOUT_PROXY_WARN = 3;

const isOxylabs = (p) => /oxylabs/i.test(String(p || ''));
const isProxyBase = (p) => /proxybase/i.test(String(p || ''));

const HREF_BY_KIND = {
  proxies: { href: '/proxy-management', hrefLabel: 'Proxy management' },
  accounts: { href: '/social-accounts?tab=users', hrefLabel: 'Social accounts' },
  enrollment: { href: '/social-accounts?tab=schedule', hrefLabel: 'Organic schedule' },
};

/**
 * Build human-facing capacity warnings from a /api/noc/dashboard payload.
 */
export function buildCapacityAlerts(data) {
  if (!data) return [];
  const ov = data.proxies?.overview || {};
  const byProvider = data.proxies?.by_provider || [];
  const mapping = data.mapping || {};
  const byPlatform = data.accounts?.by_platform || [];

  const free = Number(ov.free ?? mapping.unassigned_proxies ?? 0) || 0;
  const healthy = Number(ov.healthy ?? 0) || 0;
  const activeProxies = Number(ov.active ?? mapping.active_proxies ?? 0) || 0;
  const withoutProxy = Number(mapping.accounts_without_proxy ?? 0) || 0;
  const activeAccounts = byPlatform.reduce((s, r) => s + (Number(r.active) || 0), 0);

  const oxylabs = byProvider.filter((r) => isOxylabs(r.provider));
  const proxybase = byProvider.filter((r) => isProxyBase(r.provider));
  const oxFree = oxylabs.reduce((s, r) => s + (Number(r.free) || 0), 0);
  const oxActive = oxylabs.reduce((s, r) => s + (Number(r.active) || 0), 0);
  const pbFree = proxybase.reduce((s, r) => s + (Number(r.free) || 0), 0);
  const pbActive = proxybase.reduce((s, r) => s + (Number(r.active) || 0), 0);

  const alerts = [];

  if (free === 0) {
    alerts.push({
      id: 'proxies-empty',
      level: 'critical',
      title: 'No free proxies left',
      body: 'Get more Oxylabs / ProxyBase proxies now — new account work and sticky sessions will stall.',
      href: '/proxy-management',
      hrefLabel: 'Proxy management',
    });
  } else if (free <= FREE_PROXY_WARN) {
    alerts.push({
      id: 'proxies-low',
      level: 'warn',
      title: `Only ${free} free prox${free === 1 ? 'y' : 'ies'}`,
      body: 'Running low on unused proxies. Get more Oxylabs / ProxyBase before the next batch.',
      href: '/proxy-management',
      hrefLabel: 'Proxy management',
    });
  }

  if (healthy > 0 && healthy <= HEALTHY_PROXY_WARN && free > FREE_PROXY_WARN) {
    alerts.push({
      id: 'proxies-unhealthy',
      level: 'warn',
      title: `Only ${healthy} healthy prox${healthy === 1 ? 'y' : 'ies'}`,
      body: `${activeProxies} active but many are cooling down or degraded. Top up Oxylabs / ProxyBase.`,
      href: '/proxy-management',
      hrefLabel: 'Proxy management',
    });
  }

  if (oxActive > 0 && oxFree <= 2) {
    alerts.push({
      id: 'oxylabs-low',
      level: oxFree === 0 ? 'critical' : 'warn',
      title: oxFree === 0 ? 'Oxylabs pool exhausted' : `Oxylabs free: ${oxFree}`,
      body: 'Get more Oxylabs sticky residential proxies for X / social live work.',
      href: '/proxy-management',
      hrefLabel: 'Add Oxylabs',
    });
  }

  if (pbActive > 0 && pbFree <= 2) {
    alerts.push({
      id: 'proxybase-low',
      level: pbFree === 0 ? 'critical' : 'warn',
      title: pbFree === 0 ? 'ProxyBase pool exhausted' : `ProxyBase free: ${pbFree}`,
      body: 'Get more ProxyBase mobile/sticky proxies.',
      href: '/proxy-management',
      hrefLabel: 'Add ProxyBase',
    });
  }

  if (withoutProxy >= ACCOUNTS_WITHOUT_PROXY_WARN) {
    alerts.push({
      id: 'accounts-no-proxy',
      level: 'warn',
      title: `${withoutProxy} accounts have no proxy`,
      body: 'Assign proxies or buy more Oxylabs / ProxyBase, then map them 1:1.',
      href: '/proxy-assignments',
      hrefLabel: 'Proxy assignments',
    });
  }

  if (activeAccounts > 0 && activeAccounts <= ACTIVE_ACCOUNT_WARN) {
    alerts.push({
      id: 'accounts-low',
      level: 'warn',
      title: `Only ${activeAccounts} active social accounts`,
      body: 'Inventory is thin — import or create more accounts before the next campaign push.',
      href: '/social-accounts?tab=users',
      hrefLabel: 'Social accounts',
    });
  }

  for (const row of byPlatform) {
    const plat = String(row.platform || '').toLowerCase();
    if (!plat || plat === 'twitter') continue;
    const active = Number(row.active) || 0;
    const total = Number(row.total) || 0;
    if (total >= 5 && active === 0) {
      alerts.push({
        id: `accounts-zero-${plat}`,
        level: 'critical',
        title: `No active ${plat} accounts`,
        body: `All ${total} ${plat} accounts are banned/inactive. Get more accounts.`,
        href: `/social-accounts?tab=users&platform=${plat === 'twitter' ? 'x' : plat}`,
        hrefLabel: `View ${plat}`,
      });
    } else if (total >= 10 && active <= 3) {
      alerts.push({
        id: `accounts-low-${plat}`,
        level: 'warn',
        title: `Only ${active} active ${plat} accounts`,
        body: `Get more ${plat} accounts — ${total - active} are not usable.`,
        href: `/social-accounts?tab=users&platform=${plat === 'twitter' ? 'x' : plat}`,
        hrefLabel: `View ${plat}`,
      });
    }
  }

  const seen = new Set();
  return alerts.filter((a) => (seen.has(a.id) ? false : (seen.add(a.id), true)));
}

/** Map AccountOpsBrain /api/ops/capacity alerts into banner shape. */
export function mapOpsCapacityAlerts(ops) {
  const list = Array.isArray(ops?.alerts) ? ops.alerts : [];
  return list.map((a) => {
    const link = HREF_BY_KIND[a.kind] || HREF_BY_KIND.proxies;
    const platformHref =
      a.platform === 'x'
        ? { href: '/social-accounts?tab=users&platform=x', hrefLabel: 'View X' }
        : a.platform === 'reddit'
          ? { href: '/social-accounts?tab=users&platform=reddit', hrefLabel: 'View Reddit' }
          : link;
    return {
      id: `ops-${a.id}`,
      level: a.severity === 'critical' ? 'critical' : a.severity === 'info' ? 'info' : 'warn',
      title: a.message,
      body: a.action || '',
      href: a.kind === 'accounts' ? platformHref.href : link.href,
      hrefLabel: a.kind === 'accounts' ? platformHref.hrefLabel : link.hrefLabel,
      source: 'ops',
    };
  });
}

function mergeAlerts(opsAlerts, dashAlerts) {
  const out = [...opsAlerts];
  const seen = new Set(out.map((a) => a.id));
  // Drop generic oxylabs/proxybase/accounts-low when ops already covers them
  const opsCoversOx = opsAlerts.some((a) => /oxylabs|x_oxylabs/i.test(a.id));
  const opsCoversPb = opsAlerts.some((a) => /proxybase|reddit_proxybase/i.test(a.id));
  const opsCoversAcct = opsAlerts.some((a) => /accounts_low|x_accounts|reddit_accounts/i.test(a.id));

  for (const a of dashAlerts) {
    if (seen.has(a.id)) continue;
    if (opsCoversOx && /oxylabs/i.test(a.id)) continue;
    if (opsCoversPb && /proxybase/i.test(a.id)) continue;
    if (opsCoversAcct && /^accounts-low/.test(a.id)) continue;
    seen.add(a.id);
    out.push(a);
  }
  return out;
}

/**
 * Visible capacity banners for Social Accounts (light) and NOC (dark).
 * Prefers /api/ops/capacity (brain) and merges NOC dashboard heuristics.
 */
const CapacityAlerts = ({ data: externalData = null, variant = 'light', pollMs = 60000 }) => {
  const [data, setData] = useState(externalData);
  const [ops, setOps] = useState(null);
  const [dismissed, setDismissed] = useState(() => new Set());

  const loadOps = useCallback(async () => {
    try {
      const res = await api.get('/api/ops/capacity?fresh=1');
      setOps(res.data);
    } catch {
      /* best-effort */
    }
  }, []);

  const loadDash = useCallback(async () => {
    if (externalData) return;
    try {
      const res = await api.get('/api/noc/dashboard');
      setData(res.data);
    } catch {
      /* silent */
    }
  }, [externalData]);

  useEffect(() => {
    if (externalData) setData(externalData);
  }, [externalData]);

  useEffect(() => {
    loadOps();
    if (!externalData) loadDash();
    if (!pollMs) {
      // Still refresh ops on a modest cadence when parent owns dashboard polling
      const t = setInterval(loadOps, 30000);
      return () => clearInterval(t);
    }
    const t = setInterval(() => {
      loadOps();
      loadDash();
    }, pollMs);
    return () => clearInterval(t);
  }, [externalData, loadDash, loadOps, pollMs]);

  const alerts = useMemo(() => {
    const merged = mergeAlerts(mapOpsCapacityAlerts(ops), buildCapacityAlerts(data));
    return merged.filter((a) => !dismissed.has(a.id));
  }, [ops, data, dismissed]);

  if (!alerts.length) return null;

  const dark = variant === 'dark';

  return (
    <div className={`space-y-2 ${dark ? 'px-3 mt-2' : ''}`}>
      {alerts.map((a) => {
        const critical = a.level === 'critical';
        const box = dark
          ? critical
            ? 'border-red-500/50 bg-red-950/50 text-red-200'
            : 'border-amber-500/40 bg-amber-950/40 text-amber-200'
          : critical
            ? 'border-red-300 bg-red-50 text-red-900'
            : 'border-amber-300 bg-amber-50 text-amber-950';
        return (
          <div
            key={a.id}
            role="alert"
            className={`flex flex-wrap items-start justify-between gap-3 rounded-xl border px-4 py-3 ${box}`}
          >
            <div className="min-w-0 flex-1">
              <div className={`text-sm font-semibold ${dark ? 'font-mono tracking-wide' : ''}`}>
                {critical ? '⚠ ' : ''}
                {a.title}
              </div>
              {a.body ? (
                <p className={`text-sm mt-0.5 ${dark ? 'text-slate-300 font-mono text-xs' : 'text-amber-900/80'}`}>
                  {a.body}
                </p>
              ) : null}
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {a.href && (
                <Link
                  to={a.href}
                  className={
                    dark
                      ? 'noc-btn text-[10px]'
                      : 'btn-secondary text-xs px-3 py-1.5'
                  }
                >
                  {a.hrefLabel || 'Open'}
                </Link>
              )}
              <button
                type="button"
                className={
                  dark
                    ? 'text-[10px] font-mono text-slate-500 hover:text-slate-300'
                    : 'text-xs text-gray-500 hover:text-gray-800'
                }
                onClick={() => setDismissed((prev) => new Set(prev).add(a.id))}
              >
                Dismiss
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
};

export default CapacityAlerts;
