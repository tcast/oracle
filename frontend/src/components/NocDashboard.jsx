import React, { useCallback, useEffect, useMemo, useState } from 'react';
import api from '../utils/api';

const POLL_MS = 3000;

const fmt = (value) => {
  if (!value) return '—';
  try {
    return new Date(value).toLocaleString();
  } catch {
    return String(value);
  }
};

const ago = (value) => {
  if (!value) return '—';
  const ms = Date.now() - new Date(value).getTime();
  if (Number.isNaN(ms)) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  return fmt(value);
};

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

/** Lon/lat bounds for continental US — shared by outline + node dots */
const US_LON0 = -125;
const US_LON1 = -66;
const US_LAT0 = 24;
const US_LAT1 = 50;
const US_LON_SPAN = US_LON1 - US_LON0; // 59°
const US_LAT_SPAN = US_LAT1 - US_LAT0; // 26°
/** Equal-degree equirectangular: viewBox aspect = lonSpan/latSpan (~2.27:1) */
const US_MAP_PAD = 10;
const US_MAP_INNER_W = 590;
const US_MAP_INNER_H = Math.round(US_MAP_INNER_W * (US_LAT_SPAN / US_LON_SPAN)); // ~260
const US_MAP_W = US_MAP_INNER_W + US_MAP_PAD * 2;
const US_MAP_H = US_MAP_INNER_H + US_MAP_PAD * 2;

/** Project lon/lat into SVG coords (same transform for outline and dots) */
const projectUS = (lon, lat, w = US_MAP_W, h = US_MAP_H) => {
  const padX = US_MAP_PAD * (w / US_MAP_W);
  const padY = US_MAP_PAD * (h / US_MAP_H);
  const innerW = w - padX * 2;
  const innerH = h - padY * 2;
  const x = padX + ((lon - US_LON0) / US_LON_SPAN) * innerW;
  const y = padY + ((US_LAT1 - lat) / US_LAT_SPAN) * innerH;
  return { x, y };
};

/**
 * Simplified continental US ring (lon, lat), clockwise from WA coast.
 * ~110 verts — Florida peninsula, Gulf, Atlantic, Great Lakes north edge.
 */
const US_OUTLINE = [
  // Pacific NW → CA → Baja border
  [-124.72, 48.37], [-124.55, 47.90], [-124.25, 47.25], [-124.05, 46.25],
  [-124.00, 45.55], [-124.10, 43.80], [-124.25, 42.80], [-124.40, 41.90],
  [-124.20, 40.75], [-123.85, 39.70], [-123.50, 38.90], [-122.95, 38.10],
  [-122.50, 37.75], [-122.40, 37.20], [-121.95, 36.55], [-121.50, 35.85],
  [-120.90, 35.15], [-120.55, 34.55], [-119.85, 34.40], [-119.20, 34.10],
  [-118.45, 33.85], [-117.70, 33.45], [-117.15, 32.55], [-116.40, 32.55],
  [-114.80, 32.72],
  // AZ / NM / TX Mexico border → southern tip of TX
  [-114.55, 32.80], [-111.05, 31.33], [-109.05, 31.33], [-108.20, 31.78],
  [-106.55, 31.78], [-104.95, 30.40], [-103.35, 29.10], [-101.80, 29.85],
  [-100.40, 28.45], [-99.20, 27.20], [-97.55, 25.85], [-97.15, 25.90],
  // Gulf coast → FL panhandle → FL west coast → Keys → FL east → GA/SC
  [-97.40, 26.90], [-97.05, 27.85], [-95.60, 28.80], [-94.70, 29.35],
  [-93.85, 29.75], [-92.20, 29.55], [-90.85, 29.20], [-89.55, 29.15],
  [-89.10, 30.15], [-88.45, 30.35], [-87.55, 30.25], [-86.45, 30.35],
  [-85.45, 30.15], [-84.95, 29.65], [-84.15, 30.05], [-83.35, 29.45],
  [-82.85, 28.55], [-82.65, 27.75], [-82.55, 26.85], [-82.15, 26.35],
  [-81.80, 25.85], [-81.65, 25.15], [-81.25, 25.10], [-80.55, 25.15],
  [-80.15, 25.55], [-80.05, 26.15], [-80.05, 26.85], [-80.15, 27.55],
  [-80.35, 28.35], [-80.55, 29.15], [-81.05, 30.05], [-81.35, 30.75],
  [-81.45, 31.55], [-81.15, 32.05], [-80.85, 32.55], [-80.05, 32.75],
  [-79.25, 33.15], [-78.55, 33.85], [-77.85, 34.20], [-76.85, 34.85],
  [-75.95, 35.25], [-75.55, 35.55], [-75.50, 36.05], [-75.85, 36.55],
  // Chesapeake / Mid-Atlantic → NY → New England → Maine
  [-76.05, 37.15], [-76.15, 37.85], [-76.35, 38.75], [-75.65, 39.15],
  [-75.15, 38.85], [-74.85, 39.05], [-74.45, 39.35], [-74.05, 40.15],
  [-73.95, 40.55], [-72.95, 40.95], [-71.95, 41.25], [-71.15, 41.45],
  [-70.55, 41.65], [-70.05, 41.75], [-69.95, 42.05], [-70.65, 42.25],
  [-70.75, 43.05], [-69.25, 43.75], [-68.05, 44.35], [-67.15, 44.75],
  [-66.95, 44.85], [-67.15, 45.35], [-67.85, 47.05], [-69.05, 47.35],
  // Northern border / Great Lakes north edge → WA
  [-70.15, 46.65], [-71.45, 45.05], [-73.95, 45.00], [-76.35, 44.05],
  [-79.05, 43.55], [-81.95, 42.25], [-82.85, 42.05], [-83.45, 42.35],
  [-84.55, 43.55], [-85.55, 45.05], [-86.55, 45.35], [-87.55, 45.05],
  [-88.05, 46.05], [-89.55, 46.75], [-91.05, 46.85], [-92.15, 46.75],
  [-93.15, 48.15], [-94.55, 48.75], [-95.15, 49.00], [-97.25, 49.00],
  [-100.05, 49.00], [-104.05, 49.00], [-110.05, 49.00], [-115.05, 49.00],
  [-122.75, 49.00], [-123.15, 48.25], [-124.72, 48.37],
];

const usOutlinePath = (w, h) => {
  const pts = US_OUTLINE.map(([lon, lat]) => projectUS(lon, lat, w, h));
  if (!pts.length) return '';
  return pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ') + ' Z';
};

const STATUS_COLOR = {
  healthy: '#34d399',
  good: '#34d399',
  quiet: '#fbbf24',
  warn: '#fbbf24',
  cooldown: '#fbbf24',
  degraded: '#f59e0b',
  failing: '#f87171',
  bad: '#f87171',
  offline: '#64748b',
  idle: '#64748b',
  posted: '#34d399',
  error: '#f87171',
};

const Gauge = ({ label, value, max = 100, unit = '%', tone = 'good' }) => {
  const pct = clamp((Number(value) || 0) / max, 0, 1);
  const angle = -120 + pct * 240;
  const color =
    tone === 'bad' || pct > 0.85 && label.toLowerCase().includes('error') ? '#f87171' :
    tone === 'warn' ? '#fbbf24' :
    pct > 0.7 ? '#34d399' : pct > 0.4 ? '#22d3ee' : '#64748b';
  const r = 42;
  const rad = (a) => (a * Math.PI) / 180;
  const needleX = 50 + r * Math.cos(rad(angle - 90));
  const needleY = 55 + r * Math.sin(rad(angle - 90));

  return (
    <div className="noc-gauge">
      <svg viewBox="0 0 100 78" className="w-full h-auto">
        <path
          d="M10 55 A40 40 0 0 1 90 55"
          fill="none"
          stroke="#1e293b"
          strokeWidth="8"
          strokeLinecap="round"
        />
        <path
          d="M10 55 A40 40 0 0 1 90 55"
          fill="none"
          stroke={color}
          strokeWidth="8"
          strokeLinecap="round"
          strokeDasharray={`${pct * 126} 126`}
          className="noc-gauge-arc"
        />
        <line
          x1="50"
          y1="55"
          x2={needleX}
          y2={needleY}
          stroke="#e2e8f0"
          strokeWidth="2"
          strokeLinecap="round"
        />
        <circle cx="50" cy="55" r="3.5" fill={color} />
        <text x="50" y="72" textAnchor="middle" fill="#94a3b8" fontSize="7" fontFamily="ui-monospace, monospace">
          {label}
        </text>
      </svg>
      <div className="noc-gauge-value" style={{ color }}>
        {Number(value) ?? 0}{unit}
      </div>
    </div>
  );
};

const TopologyPanel = ({ flow }) => {
  const hubs = flow?.hubs || [];
  const links = flow?.links || [];
  const proxy = hubs.find((h) => h.id === 'proxies');
  const accounts = hubs.find((h) => h.id === 'accounts');
  const plats = hubs.filter((h) => h.id.startsWith('plat:'));

  const W = 640;
  const H = 280;
  const left = { x: 90, y: H / 2 };
  const mid = { x: 280, y: H / 2 };
  const rightX = 520;
  const platPositions = plats.map((p, i) => {
    const spread = plats.length <= 1 ? 0 : (i / (plats.length - 1) - 0.5) * 200;
    return { ...p, x: rightX, y: H / 2 + spread };
  });

  const nodePos = {
    proxies: left,
    accounts: mid,
    ...Object.fromEntries(platPositions.map((p) => [p.id, { x: p.x, y: p.y }])),
  };

  const statusStroke = (s) => STATUS_COLOR[s] || STATUS_COLOR.idle;

  return (
    <div className="noc-panel h-full flex flex-col">
      <div className="noc-panel-head">
        <span>LIVE TRAFFIC FLOW</span>
        <span className="noc-live-dot">ROUTING</span>
      </div>
      <div className="flex-1 relative min-h-[240px]">
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-full absolute inset-0">
          <defs>
            <linearGradient id="nocFlowGrad" x1="0%" y1="0%" x2="100%" y2="0%">
              <stop offset="0%" stopColor="#22d3ee" stopOpacity="0.15" />
              <stop offset="100%" stopColor="#34d399" stopOpacity="0.35" />
            </linearGradient>
            <filter id="nocGlow">
              <feGaussianBlur stdDeviation="2.5" result="b" />
              <feMerge>
                <feMergeNode in="b" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>

          {links.map((link, i) => {
            const a = nodePos[link.from];
            const b = nodePos[link.to];
            if (!a || !b) return null;
            const midX = (a.x + b.x) / 2;
            const midY = (a.y + b.y) / 2 - 20;
            const path = `M${a.x},${a.y} Q${midX},${midY} ${b.x},${b.y}`;
            const active = link.active || link.from === 'proxies';
            return (
              <g key={`${link.from}-${link.to}-${i}`}>
                <path
                  d={path}
                  fill="none"
                  stroke={active ? 'url(#nocFlowGrad)' : '#1e293b'}
                  strokeWidth={active ? 2.5 : 1.5}
                />
                {active && (
                  <>
                    <circle r="3" fill="#22d3ee" filter="url(#nocGlow)">
                      <animateMotion dur={`${2.2 + (i % 3) * 0.4}s`} repeatCount="indefinite" path={path} />
                    </circle>
                    <circle r="2" fill="#34d399" opacity="0.7">
                      <animateMotion dur={`${3 + (i % 4) * 0.35}s`} begin="0.6s" repeatCount="indefinite" path={path} />
                    </circle>
                  </>
                )}
              </g>
            );
          })}

          {[
            { id: 'proxies', node: proxy, pos: left },
            { id: 'accounts', node: accounts, pos: mid },
            ...platPositions.map((p) => ({ id: p.id, node: p, pos: { x: p.x, y: p.y } })),
          ].map(({ id, node, pos }) => {
            if (!node) return null;
            const color = statusStroke(node.status);
            const pulse = node.pulse || id === 'proxies' || id === 'accounts';
            return (
              <g key={id} transform={`translate(${pos.x},${pos.y})`}>
                {pulse && (
                  <circle r="28" fill="none" stroke={color} strokeOpacity="0.35">
                    <animate attributeName="r" values="22;34;22" dur="2.4s" repeatCount="indefinite" />
                    <animate attributeName="stroke-opacity" values="0.4;0;0.4" dur="2.4s" repeatCount="indefinite" />
                  </circle>
                )}
                <circle r="22" fill="#0f172a" stroke={color} strokeWidth="2" filter="url(#nocGlow)" />
                <text
                  y="-2"
                  textAnchor="middle"
                  fill="#e2e8f0"
                  fontSize="11"
                  fontWeight="700"
                  fontFamily="ui-monospace, monospace"
                >
                  {node.count}
                </text>
                <text
                  y="12"
                  textAnchor="middle"
                  fill="#94a3b8"
                  fontSize="8"
                  fontFamily="ui-monospace, monospace"
                  className="uppercase"
                >
                  {(node.label || '').slice(0, 10)}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
};

const GeoMapPanel = ({ geo }) => {
  const nodes = geo?.nodes || [];
  const W = US_MAP_W;
  const H = US_MAP_H;
  const landPath = useMemo(() => usOutlinePath(W, H), []);

  return (
    <div className="noc-panel h-full flex flex-col">
      <div className="noc-panel-head">
        <span>EGRESS MAP</span>
        <span className="text-[10px] text-slate-500 font-mono">
          {nodes.length} nodes · continental US
        </span>
      </div>
      <div className="flex-1 relative min-h-[220px] bg-[#060b14]">
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-full absolute inset-0" preserveAspectRatio="xMidYMid meet">
          <defs>
            <radialGradient id="nocMapGlow" cx="50%" cy="45%" r="55%">
              <stop offset="0%" stopColor="#0ea5e9" stopOpacity="0.08" />
              <stop offset="100%" stopColor="#060b14" stopOpacity="0" />
            </radialGradient>
            <linearGradient id="nocLandFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#1e3a5f" />
              <stop offset="100%" stopColor="#152a45" />
            </linearGradient>
          </defs>
          {/* ocean */}
          <rect width={W} height={H} fill="#060b14" />
          <rect width={W} height={H} fill="url(#nocMapGlow)" />
          {/* lon/lat grid */}
          {[-120, -110, -100, -90, -80, -70].map((lon) => {
            const { x } = projectUS(lon, 37, W, H);
            return <line key={`v${lon}`} x1={x} y1={US_MAP_PAD} x2={x} y2={H - US_MAP_PAD} stroke="#1e293b" strokeWidth="0.6" />;
          })}
          {[30, 35, 40, 45].map((lat) => {
            const { y } = projectUS(-95, lat, W, H);
            return <line key={`h${lat}`} x1={US_MAP_PAD} y1={y} x2={W - US_MAP_PAD} y2={y} stroke="#1e293b" strokeWidth="0.6" />;
          })}
          {/* continental US landmass — same lon/lat projection as dots */}
          <path
            d={landPath}
            fill="url(#nocLandFill)"
            stroke="#38bdf8"
            strokeWidth="1.4"
            strokeOpacity="0.55"
            strokeLinejoin="round"
          />
          <path
            d={landPath}
            fill="none"
            stroke="#94a3b8"
            strokeWidth="0.4"
            strokeOpacity="0.35"
            strokeLinejoin="round"
          />

          {nodes.slice(0, 180).map((n) => {
            if (n.lon == null || n.lat == null) return null;
            const { x, y } = projectUS(n.lon, n.lat, W, H);
            const color = STATUS_COLOR[n.status] || STATUS_COLOR.idle;
            const hot = n.status === 'healthy' && n.last_success_at &&
              Date.now() - new Date(n.last_success_at).getTime() < 30 * 60 * 1000;
            return (
              <g key={n.id}>
                {hot && (
                  <circle cx={x} cy={y} r="6" fill={color} opacity="0.25">
                    <animate attributeName="r" values="4;10;4" dur="2s" repeatCount="indefinite" />
                  </circle>
                )}
                <circle
                  cx={x}
                  cy={y}
                  r={n.status === 'cooldown' || n.status === 'degraded' ? 3.5 : 2.2}
                  fill={color}
                  opacity={0.95}
                  stroke="#0b1220"
                  strokeWidth="0.4"
                >
                  <title>{`${n.provider} #${n.id} · ${n.city || ''} · ${n.status}${n.account_platform ? ` · ${n.account_platform}/${n.account_username}` : ''}`}</title>
                </circle>
              </g>
            );
          })}
        </svg>
      </div>
      <div className="flex gap-3 px-3 pb-2 text-[10px] font-mono text-slate-500">
        <span className="flex items-center gap-1"><i className="noc-legend" style={{ background: STATUS_COLOR.healthy }} /> healthy</span>
        <span className="flex items-center gap-1"><i className="noc-legend" style={{ background: STATUS_COLOR.cooldown }} /> cool</span>
        <span className="flex items-center gap-1"><i className="noc-legend" style={{ background: STATUS_COLOR.degraded }} /> degraded</span>
        <span className="flex items-center gap-1"><i className="noc-legend" style={{ background: STATUS_COLOR.offline }} /> off</span>
      </div>
    </div>
  );
};

const PlatformStrip = ({ platforms, quietActive }) => (
  <div className="noc-panel">
    <div className="noc-panel-head">
      <span>NETWORKS</span>
      {quietActive ? <span className="text-amber-400 text-[10px] font-mono">QUIET HOURS</span> : null}
    </div>
    <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-5 gap-2 p-3">
      {(platforms || []).map((p) => {
        const color = STATUS_COLOR[p.status] || STATUS_COLOR.idle;
        return (
          <div
            key={p.platform}
            className="noc-plat-card"
            style={{ borderColor: `${color}55`, boxShadow: p.status === 'healthy' ? `0 0 18px ${color}22` : undefined }}
          >
            <div className="flex items-center justify-between mb-2">
              <span className="font-semibold text-slate-100 capitalize tracking-wide">{p.platform}</span>
              <span className="text-[10px] font-mono uppercase px-1.5 py-0.5 rounded" style={{ color, background: `${color}22` }}>
                {p.status}
              </span>
            </div>
            <div className="grid grid-cols-2 gap-x-2 gap-y-1 font-mono text-[11px]">
              <div className="text-slate-500">jobs</div>
              <div className="text-slate-200 text-right">{p.jobs_enabled}/{p.jobs_total}</div>
              <div className="text-slate-500">posted</div>
              <div className="text-emerald-400 text-right text-sm font-bold">{p.today_posted}</div>
              <div className="text-slate-500">failed</div>
              <div className={`text-right text-sm font-bold ${p.today_failed ? 'text-red-400' : 'text-slate-500'}`}>{p.today_failed}</div>
              <div className="text-slate-500">last ok</div>
              <div className="text-slate-300 text-right">{ago(p.last_success_at)}</div>
            </div>
            {p.running > 0 && (
              <div className="mt-2 text-[10px] font-mono text-cyan-400 noc-blink">{p.running} RUNNING</div>
            )}
          </div>
        );
      })}
      {!platforms?.length && (
        <div className="text-slate-500 text-sm col-span-full py-4 text-center">No platforms</div>
      )}
    </div>
  </div>
);

const EventTicker = ({ events }) => {
  const items = events?.items || [];
  if (!items.length) {
    return (
      <div className="noc-ticker">
        <span className="noc-ticker-label">EVENTS</span>
        <span className="text-slate-500 font-mono text-xs">Awaiting traffic…</span>
      </div>
    );
  }

  const line = items.slice(0, 30).map((e) => {
    let tag = 'FAIL';
    let color = 'text-red-400';
    if (e.kind === 'create' && e.status === 'created') {
      tag = 'CREATED';
      color = 'text-emerald-400';
    } else if (e.kind === 'create' && e.status === 'attempt_failed') {
      tag = 'ATTEMPT';
      color = 'text-red-400';
    } else if (e.kind === 'create' && e.status === 'blocked') {
      tag = 'BLOCKED';
      color = 'text-amber-400';
    } else if (e.kind === 'create' && e.status === 'skipped') {
      tag = 'SKIP';
      color = 'text-slate-400';
    } else if (e.kind === 'post' && e.status === 'posted') {
      tag = 'POST';
      color = 'text-emerald-400';
    } else if (e.kind === 'proxy') {
      tag = 'PROXY';
      color = 'text-amber-400';
    } else if (e.status === 'cooldown') {
      tag = 'COOL';
      color = 'text-amber-400';
    }
    return (
      <span key={`${e.kind}-${e.at}-${e.username}-${e.detail}-${e.status}`} className="noc-ticker-item">
        <span className={`font-bold ${color}`}>{tag}</span>
        <span className="text-slate-400">{ago(e.at)}</span>
        <span className="text-slate-200 capitalize">{e.platform}</span>
        <span className="text-cyan-300/80">{e.username}</span>
        {e.target ? <span className="text-slate-500">{e.target}</span> : null}
        {e.detail ? <span className="text-slate-500 truncate max-w-[180px]">{e.detail}</span> : null}
      </span>
    );
  });

  return (
    <div className="noc-ticker">
      <span className="noc-ticker-label">EVENTS</span>
      <div className="noc-ticker-track">
        <div className="noc-ticker-marquee">
          {line}
          {line}
        </div>
      </div>
    </div>
  );
};

const SocialCreationPanel = ({ accountCreation }) => {
  const today = accountCreation?.today || {};
  const h24 = accountCreation?.last_24h || {};
  const platforms = accountCreation?.by_platform || [];

  return (
    <div className="noc-panel">
      <div className="noc-panel-head">
        <span>SOCIAL · ACCOUNT CREATION</span>
        <span className="text-[10px] text-slate-500 font-mono">
          created vs attempted · today / 24h
        </span>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 px-3 pt-3 font-mono text-xs">
        <div className="noc-plat-card" style={{ borderColor: '#34d39955' }}>
          <div className="text-slate-500 text-[10px]">CREATED TODAY</div>
          <div className="text-emerald-400 text-xl font-bold">{today.created ?? 0}</div>
        </div>
        <div className="noc-plat-card" style={{ borderColor: '#22d3ee55' }}>
          <div className="text-slate-500 text-[10px]">ATTEMPTED TODAY</div>
          <div className="text-cyan-300 text-xl font-bold">{today.attempted ?? 0}</div>
        </div>
        <div className="noc-plat-card" style={{ borderColor: '#f8717155' }}>
          <div className="text-slate-500 text-[10px]">FAILED / BLOCKED</div>
          <div className={`text-xl font-bold ${(today.failed || today.blocked) ? 'text-red-400' : 'text-slate-500'}`}>
            {(today.failed || 0) + (today.blocked || 0)}
          </div>
        </div>
        <div className="noc-plat-card" style={{ borderColor: '#94a3b855' }}>
          <div className="text-slate-500 text-[10px]">SUCCESS RATE</div>
          <div className="text-slate-100 text-xl font-bold">{today.success_rate ?? 0}%</div>
          <div className="text-[10px] text-slate-600 mt-0.5">24h {h24.created ?? 0}/{h24.attempted ?? 0}</div>
        </div>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-5 gap-2 p-3">
        {platforms.map((p) => (
          <div key={p.platform} className="noc-plat-card" style={{ borderColor: '#1e293b' }}>
            <div className="flex items-center justify-between mb-2">
              <span className="font-semibold text-slate-100 capitalize tracking-wide">{p.platform}</span>
              <span className="text-[10px] font-mono text-slate-500">{p.accounts_active} live</span>
            </div>
            <div className="grid grid-cols-2 gap-x-2 gap-y-1 font-mono text-[11px]">
              <div className="text-slate-500">created</div>
              <div className="text-emerald-400 text-right font-bold">{p.today_created}</div>
              <div className="text-slate-500">attempted</div>
              <div className="text-cyan-300 text-right font-bold">{p.today_attempted}</div>
              <div className="text-slate-500">failed</div>
              <div className={`text-right ${p.today_failed ? 'text-red-400' : 'text-slate-500'}`}>{p.today_failed}</div>
              <div className="text-slate-500">rate</div>
              <div className="text-slate-300 text-right">{p.today_success_rate}%</div>
              <div className="text-slate-500">24h</div>
              <div className="text-slate-400 text-right">{p.h24_created}/{p.h24_attempted}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

const DetailSection = ({ title, children, action }) => (
  <section className="noc-detail">
    <div className="flex items-center justify-between px-3 py-2 border-b border-slate-800/80">
      <h3 className="text-[11px] font-semibold text-slate-400 tracking-widest uppercase font-mono">{title}</h3>
      {action}
    </div>
    <div className="p-3">{children}</div>
  </section>
);

const NocDashboard = () => {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [probing, setProbing] = useState(false);
  const [lastFetchMs, setLastFetchMs] = useState(null);
  const [clock, setClock] = useState(() => new Date());
  const [showDetails, setShowDetails] = useState(true);

  const load = useCallback(async () => {
    const started = Date.now();
    try {
      const res = await api.get('/api/noc/dashboard');
      setData(res.data);
      setError(null);
      setLastFetchMs(Date.now() - started);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  useEffect(() => {
    const t = setInterval(() => setClock(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  const runProbeBatch = async () => {
    try {
      setProbing(true);
      await api.post('/api/noc/proxies/probe-batch', { limit: 3 });
      await load();
    } catch (err) {
      alert(err.response?.data?.error || err.message);
    } finally {
      setProbing(false);
    }
  };

  const gauges = data?.flow?.gauges || {};
  const platforms = data?.postingByPlatform?.platforms || [];
  const px = data?.proxies || {};
  const ov = px.overview || {};
  const accounts = data?.accounts || {};
  const posting = data?.posting || {};
  const errors = data?.errors || {};
  const mapping = data?.mapping || {};
  const queue = data?.queue || {};
  const protection = data?.protection || {};
  const organic = posting.organic || {};

  const overallOk =
    (gauges.post_success_pct ?? 100) >= 70 &&
    (ov.error_rate || 0) < 40 &&
    (ov.in_cooldown || 0) <= 8;

  const clockStr = useMemo(
    () => clock.toLocaleTimeString(undefined, { hour12: false }),
    [clock]
  );

  if (loading && !data) {
    return (
      <div className="noc-wall flex items-center justify-center">
        <div className="text-cyan-400/80 font-mono text-sm tracking-widest animate-pulse">
          INITIALIZING NOC UPLINK…
        </div>
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="noc-wall flex items-center justify-center p-8">
        <div className="text-red-400 font-mono text-sm border border-red-500/40 bg-red-950/40 px-4 py-3 rounded">
          UPLINK FAILED · {error}
        </div>
      </div>
    );
  }

  return (
    <div className="noc-wall">
      <header className="noc-header">
        <div className="flex items-center gap-3 min-w-0">
          <div className="noc-brand-mark" />
          <div className="min-w-0">
            <div className="flex items-baseline gap-2">
              <h1 className="text-lg sm:text-xl font-bold text-slate-100 tracking-[0.2em] font-mono">
                WHISPER NOC
              </h1>
              <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${overallOk ? 'bg-emerald-500/20 text-emerald-400' : 'bg-amber-500/20 text-amber-400'}`}>
                {overallOk ? 'NOMINAL' : 'ATTENTION'}
              </span>
            </div>
            <p className="text-[11px] text-slate-500 font-mono truncate">
              Proxies · Accounts · Networks · Posting · Errors
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3 sm:gap-5 font-mono text-xs text-slate-400">
          <span className="hidden sm:inline text-slate-200 text-sm tabular-nums">{clockStr}</span>
          <span className="flex items-center gap-1.5 text-cyan-400">
            <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-pulse" />
            LIVE {POLL_MS / 1000}s
          </span>
          <span className="hidden md:inline">{lastFetchMs != null ? `${lastFetchMs}ms` : ''}</span>
          <button type="button" onClick={load} className="noc-btn">Refresh</button>
          <button type="button" onClick={() => setShowDetails((v) => !v)} className="noc-btn">
            {showDetails ? 'Hide ops' : 'Show ops'}
          </button>
        </div>
      </header>

      {error && (
        <div className="mx-3 mt-2 text-amber-300 text-xs font-mono border border-amber-500/30 bg-amber-950/40 px-3 py-1.5 rounded">
          Last refresh failed: {error}
        </div>
      )}

      <div className="noc-gauges">
        <Gauge label="PROXY HEALTH" value={gauges.proxy_health_pct ?? 0} tone={(gauges.proxy_health_pct ?? 0) < 60 ? 'warn' : 'good'} />
        <Gauge label="POST SUCCESS" value={gauges.post_success_pct ?? 100} tone={(gauges.post_success_pct ?? 100) < 70 ? 'bad' : 'good'} />
        <Gauge label="ERROR RATE" value={gauges.error_rate_pct ?? 0} tone={(gauges.error_rate_pct ?? 0) > 25 ? 'bad' : 'good'} />
        <div className="noc-metric-block">
          <div className="noc-metric-label">POSTED TODAY</div>
          <div className="noc-metric-num text-emerald-400">{gauges.posted_today ?? 0}</div>
        </div>
        <div className="noc-metric-block">
          <div className="noc-metric-label">FAILED TODAY</div>
          <div className={`noc-metric-num ${(gauges.failed_today || 0) ? 'text-red-400' : 'text-slate-500'}`}>
            {gauges.failed_today ?? 0}
          </div>
        </div>
        <div className="noc-metric-block">
          <div className="noc-metric-label">QUEUE / DUE</div>
          <div className="noc-metric-num text-cyan-400">{gauges.queue_depth ?? 0}</div>
        </div>
        <div className="noc-metric-block">
          <div className="noc-metric-label">PROXIES</div>
          <div className="noc-metric-num text-slate-100">{gauges.proxies_active ?? 0}</div>
        </div>
        <div className="noc-metric-block">
          <div className="noc-metric-label">JOBS ON</div>
          <div className="noc-metric-num text-slate-100">{gauges.jobs_enabled ?? 0}</div>
        </div>
        <div className="noc-metric-block">
          <div className="noc-metric-label">CREATED TODAY</div>
          <div className="noc-metric-num text-emerald-400">{gauges.creates_today ?? 0}</div>
        </div>
        <div className="noc-metric-block">
          <div className="noc-metric-label">CREATE ATTEMPTS</div>
          <div className="noc-metric-num text-cyan-300">{gauges.create_attempts_today ?? 0}</div>
        </div>
      </div>

      <div className="px-3 mt-3">
        <PlatformStrip
          platforms={platforms}
          quietActive={!!data?.postingByPlatform?.quiet_hours?.active}
        />
      </div>

      <div className="px-3 mt-3">
        <SocialCreationPanel accountCreation={data?.accountCreation} />
      </div>

      <div className="grid lg:grid-cols-2 gap-3 px-3 mt-3 min-h-[280px]">
        <TopologyPanel flow={data?.flow} />
        <GeoMapPanel geo={data?.geo} />
      </div>

      <div className="px-3 mt-3">
        <EventTicker events={data?.events} />
      </div>

      {showDetails && (
        <div className="px-3 mt-3 pb-6 space-y-3 noc-ops-scroll">
          <div className="grid lg:grid-cols-2 gap-3">
            <DetailSection
              title="Proxy fleet"
              action={
                <button type="button" disabled={probing} onClick={runProbeBatch} className="noc-btn text-[10px]">
                  {probing ? 'Probing…' : 'Probe batch'}
                </button>
              }
            >
              <div className="grid grid-cols-2 gap-2 mb-3 text-xs font-mono text-slate-400">
                <div>Assigned <span className="text-slate-200">{ov.assigned}</span></div>
                <div>Free <span className="text-slate-200">{ov.free}</span></div>
                <div>Mapping {mapping.ok ? <span className="text-emerald-400">OK</span> : <span className="text-amber-400">Gaps</span>}</div>
                <div>Without proxy <span className="text-slate-200">{mapping.accounts_without_proxy ?? 0}</span></div>
              </div>
              <div className="overflow-x-auto">
                <table className="min-w-full text-xs font-mono">
                  <thead>
                    <tr className="text-slate-500 text-left border-b border-slate-800">
                      <th className="py-1.5 pr-2 font-medium">Provider / zone</th>
                      <th className="py-1.5 pr-2 font-medium">Active</th>
                      <th className="py-1.5 pr-2 font-medium">Cool</th>
                      <th className="py-1.5 pr-2 font-medium">Free</th>
                      <th className="py-1.5 font-medium">Assigned</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(px.by_provider || []).map((row) => (
                      <tr key={`${row.provider}-${row.zone}`} className="border-b border-slate-800/60 text-slate-300">
                        <td className="py-1.5 pr-2">
                          <div className="text-slate-100">{row.provider}</div>
                          {row.zone ? <div className="text-slate-500">{row.zone}</div> : null}
                        </td>
                        <td className="py-1.5 pr-2">{row.active}/{row.total}</td>
                        <td className="py-1.5 pr-2">{row.in_cooldown || 0}</td>
                        <td className="py-1.5 pr-2">{row.free}</td>
                        <td className="py-1.5">{row.assigned}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="mt-2 text-[10px] text-slate-600 font-mono">
                Protection: cool after {protection.cooldownAfterProxyPathFails}/{protection.cooldownAfterOtherFails} ·
                disable @ {protection.disableAfterConsecutiveProxyPath}/{protection.disableAfterConsecutiveAny} ·
                total ≥ {protection.disableAfterTotalFailures}
              </p>
            </DetailSection>

            <DetailSection title="Unhealthy / cooling">
              <div className="overflow-x-auto max-h-64 overflow-y-auto">
                <table className="min-w-full text-xs font-mono">
                  <thead className="sticky top-0 bg-[#0b1220]">
                    <tr className="text-slate-500 text-left border-b border-slate-800">
                      <th className="py-1.5 pr-2">ID</th>
                      <th className="py-1.5 pr-2">Status</th>
                      <th className="py-1.5 pr-2">Fails</th>
                      <th className="py-1.5 pr-2">Account</th>
                      <th className="py-1.5">Last error</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(px.unhealthy || []).map((p) => {
                      const cooled = p.cooldown_until && new Date(p.cooldown_until) > new Date();
                      const status = !p.is_active ? 'off' : cooled ? 'cool' : 'degraded';
                      return (
                        <tr key={p.id} className="border-b border-slate-800/50 text-slate-300 align-top">
                          <td className="py-1.5 pr-2">{p.id}</td>
                          <td className="py-1.5 pr-2" style={{ color: STATUS_COLOR[status === 'off' ? 'offline' : status === 'cool' ? 'cooldown' : 'degraded'] }}>
                            {status}
                          </td>
                          <td className="py-1.5 pr-2">
                            {p.consecutive_failures}/{p.failure_count}
                            <div className="text-slate-600">{ago(p.last_failure_at)}</div>
                          </td>
                          <td className="py-1.5 pr-2">
                            {p.account_username ? `${p.account_platform}/${p.account_username}` : '—'}
                          </td>
                          <td className="py-1.5 text-slate-500 max-w-[200px] truncate" title={p.last_error || ''}>
                            {p.last_error || '—'}
                          </td>
                        </tr>
                      );
                    })}
                    {!px.unhealthy?.length && (
                      <tr><td colSpan={5} className="py-3 text-emerald-400">All clear</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </DetailSection>
          </div>

          <div className="grid lg:grid-cols-2 gap-3">
            <DetailSection title="Accounts">
              <div className="overflow-x-auto">
                <table className="min-w-full text-xs font-mono">
                  <thead>
                    <tr className="text-slate-500 text-left border-b border-slate-800">
                      <th className="py-1.5 pr-2">Platform</th>
                      <th className="py-1.5 pr-2">Active</th>
                      <th className="py-1.5 pr-2">Banned</th>
                      <th className="py-1.5 pr-2">Error</th>
                      <th className="py-1.5 pr-2">Warm</th>
                      <th className="py-1.5">Proxy</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(accounts.by_platform || []).map((row) => (
                      <tr key={row.platform} className="border-b border-slate-800/50 text-slate-300">
                        <td className="py-1.5 pr-2 capitalize text-slate-100">{row.platform}</td>
                        <td className="py-1.5 pr-2">{row.active}</td>
                        <td className="py-1.5 pr-2">{row.banned}</td>
                        <td className="py-1.5 pr-2">{row.error}</td>
                        <td className="py-1.5 pr-2">{row.warming}</td>
                        <td className="py-1.5">{row.with_proxy}/{row.total}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </DetailSection>

            <DetailSection title="Posting / organic">
              <div className="grid grid-cols-2 gap-3 text-xs font-mono">
                <div>
                  <div className="text-slate-500">Organic</div>
                  <div className={organic.enabled ? 'text-emerald-400 text-lg font-bold' : 'text-amber-400 text-lg font-bold'}>
                    {organic.enabled ? 'ON' : 'OFF'}
                  </div>
                </div>
                <div>
                  <div className="text-slate-500">Quiet hours</div>
                  <div className={organic.quiet_hours?.active ? 'text-amber-400 text-lg font-bold' : 'text-slate-300 text-lg font-bold'}>
                    {organic.quiet_hours?.active ? 'ACTIVE' : 'open'}
                  </div>
                </div>
                <div>
                  <div className="text-slate-500">Posted today</div>
                  <div className="text-emerald-400 text-lg font-bold">{organic.today?.posted ?? 0}</div>
                </div>
                <div>
                  <div className="text-slate-500">Failed today</div>
                  <div className={`text-lg font-bold ${organic.today?.failed ? 'text-red-400' : 'text-slate-500'}`}>
                    {organic.today?.failed ?? 0}
                  </div>
                </div>
              </div>
              <div className="mt-3 space-y-1 text-[11px] font-mono text-slate-500">
                <div>
                  Quiet {organic.quiet_hours?.start ?? '—'}–{organic.quiet_hours?.end ?? '—'}
                  {' · '}cap {organic.min_per_day ?? '?'}–{organic.max_per_day ?? '?'}/day
                </div>
                <div>
                  X follows: {posting.x_follow?.today?.followed ?? 0} ok / {posting.x_follow?.today?.failed ?? 0} fail
                  {' · '}jobs {posting.x_follow?.jobs?.enabled ?? 0}
                </div>
                <div>
                  Warm: {posting.warm?.today?.ok ?? 0} ok / {posting.warm?.today?.failed ?? 0} fail
                </div>
                <div>
                  Queue: {queue.started ? 'running' : 'stopped'}
                  {queue.error ? ` (${queue.error})` : ''}
                </div>
              </div>
            </DetailSection>
          </div>

          <DetailSection title="Errors (24h)">
            <div className="flex flex-wrap gap-2 mb-3">
              {(errors.last_24h_by_class || []).map((c) => (
                <span key={c.failure_class} className="text-[10px] font-mono px-2 py-0.5 rounded bg-slate-800 text-slate-300">
                  {c.failure_class}: <strong className="text-slate-100">{c.count}</strong>
                </span>
              ))}
              {!errors.last_24h_by_class?.length && (
                <span className="text-xs text-emerald-400 font-mono">No classified failures in the last 24h</span>
              )}
            </div>
            <div className="space-y-1.5 max-h-56 overflow-y-auto">
              {(errors.samples || []).map((s, i) => (
                <div key={i} className="flex gap-2 text-xs font-mono border-b border-slate-800/50 pb-1.5">
                  <span className="text-amber-400/90 shrink-0">{s.class}</span>
                  <span className="text-slate-600 shrink-0 w-16">{s.source}</span>
                  <span className="text-slate-200 shrink-0">×{s.count}</span>
                  <span className="text-slate-500 truncate flex-1" title={s.message}>{s.message}</span>
                  <span className="text-slate-600 shrink-0">{ago(s.last_seen)}</span>
                </div>
              ))}
            </div>
          </DetailSection>
        </div>
      )}
    </div>
  );
};

export default NocDashboard;
