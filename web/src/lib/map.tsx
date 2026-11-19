// Route map on OpenStreetMap tiles via Leaflet (loaded from a CDN on first use).
import { useEffect, useRef, useState } from 'react';
import { useApp } from './app';
import type { Stop } from './types';

declare global {
  interface Window { L?: any }
}

let leaflet: Promise<any> | null = null;
function loadLeaflet(): Promise<any> {
  if (window.L) return Promise.resolve(window.L);
  if (leaflet) return leaflet;
  leaflet = new Promise((resolve, reject) => {
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
    document.head.appendChild(css);
    const s = document.createElement('script');
    s.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
    const fail = () => {
      leaflet = null;
      reject(new Error('map failed to load'));
    };
    const timer = setTimeout(fail, 8000);
    s.onload = () => {
      clearTimeout(timer);
      resolve(window.L);
    };
    s.onerror = () => {
      clearTimeout(timer);
      fail();
    };
    document.head.appendChild(s);
  });
  return leaflet;
}

export interface MapRoute {
  id: string;
  stops: Stop[];
  highlight?: boolean;
}

export function RouteMap({ routes, points = [], height = 280, label }: { routes: MapRoute[]; points?: { lat: number; lng: number; label: string; kind?: 'from' | 'to' | 'driver' }[]; height?: number; label?: string }) {
  const { site } = useApp();
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<any>(null);
  const layer = useRef<any>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    loadLeaflet().then((L) => {
      if (!alive || !el.current || map.current) return;
      map.current = L.map(el.current, { scrollWheelZoom: false, attributionControl: true }).setView([53.5, -113.5], 5);
      L.tileLayer(site?.mapTilesUrl ?? 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18, attribution: site?.mapAttribution ?? '&copy; OpenStreetMap contributors' }).addTo(map.current);
      layer.current = L.layerGroup().addTo(map.current);
      draw();
    }).catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const draw = () => {
    const L = window.L;
    if (!L || !map.current || !layer.current) return;
    layer.current.clearLayers();
    const css = getComputedStyle(document.documentElement);
    const sign = css.getPropertyValue('--sign').trim() || '#0b6b45';
    const muted = css.getPropertyValue('--muted').trim() || '#5c6862';
    const all: [number, number][] = [];
    const ordered = [...routes].sort((a, b) => Number(Boolean(a.highlight)) - Number(Boolean(b.highlight)));
    for (const r of ordered) {
      const ll = r.stops.map((s) => [s.lat, s.lng] as [number, number]);
      all.push(...ll);
      L.polyline(ll, { color: r.highlight ? sign : muted, weight: r.highlight ? 5 : 2.5, opacity: r.highlight ? 0.95 : 0.6, dashArray: r.highlight ? undefined : '6 6' }).addTo(layer.current);
      for (const s of r.stops) L.circleMarker([s.lat, s.lng], { radius: r.highlight ? 5 : 3, color: r.highlight ? sign : muted, fillColor: '#fff', fillOpacity: 1, weight: 2 }).bindTooltip(s.city).addTo(layer.current);
    }
    for (const p of points) {
      all.push([p.lat, p.lng]);
      L.circleMarker([p.lat, p.lng], { radius: 8, color: p.kind === 'driver' ? '#1d5fd1' : '#18201c', fillColor: p.kind === 'from' ? sign : p.kind === 'driver' ? '#1d5fd1' : '#18201c', fillOpacity: 1, weight: 2 })
        .bindTooltip(p.label, { permanent: p.kind !== 'driver', direction: 'top', offset: [0, -8] }).addTo(layer.current);
    }
    if (all.length === 1) map.current.setView(all[0], 11);
    else if (all.length > 1) map.current.fitBounds(all, { padding: [28, 28], maxZoom: 12 });
  };

  useEffect(draw, [routes, points]);

  if (failed) return <SchematicMap routes={routes} points={points} label={label} />;
  return <div className="map" ref={el} style={{ height }} role="img" aria-label={label ?? 'Map'} />;
}

/** Fallback when map tiles cannot load: routes drawn on a plain projection. */
function SchematicMap({ routes, points, label }: { routes: MapRoute[]; points: { lat: number; lng: number; label: string; kind?: string }[]; label?: string }) {
  const all = [...routes.flatMap((r) => r.stops), ...points];
  if (!all.length) return null;
  const W = 400, H = 220;
  const lngs = all.map((p) => p.lng), lats = all.map((p) => p.lat);
  const pad = 0.6;
  const x0 = Math.min(...lngs) - pad, x1 = Math.max(...lngs) + pad, y0 = Math.min(...lats) - pad / 2, y1 = Math.max(...lats) + pad / 2;
  const P = (p: { lat: number; lng: number }) => [((p.lng - x0) / (x1 - x0 || 1)) * W, ((y1 - p.lat) / (y1 - y0 || 1)) * H] as const;
  const cities = new Map<string, { lat: number; lng: number; hl: boolean }>();
  for (const r of routes) for (const s of r.stops) cities.set(s.city, { lat: s.lat, lng: s.lng, hl: Boolean(r.highlight) || cities.get(s.city)?.hl === true });
  const ordered = [...routes].sort((a, b) => Number(Boolean(a.highlight)) - Number(Boolean(b.highlight)));
  return (
    <svg className="map schematic" viewBox={`-10 -10 ${W + 20} ${H + 20}`} role="img" aria-label={label ?? 'Map'}>
      <rect x={-10} y={-10} width={W + 20} height={H + 20} rx={10} fill="var(--chip)" />
      {ordered.map((r) => (
        <polyline key={r.id} points={r.stops.map((s) => P(s).map((v) => v.toFixed(1)).join(',')).join(' ')} fill="none"
          stroke={r.highlight ? 'var(--sign)' : 'var(--muted)'} strokeWidth={r.highlight ? 4 : 2} strokeOpacity={r.highlight ? 1 : 0.5} strokeDasharray={r.highlight ? undefined : '5 5'} strokeLinecap="round" strokeLinejoin="round" />
      ))}
      {[...cities.entries()].map(([name, c]) => {
        const [x, y] = P(c);
        const end = x > W - 80;
        return (
          <g key={name}>
            <circle cx={x} cy={y} r={c.hl ? 4.5 : 3} fill="var(--panel)" stroke={c.hl ? 'var(--sign)' : 'var(--muted)'} strokeWidth={2} />
            <text x={x + (end ? -7 : 7)} y={y + 4} textAnchor={end ? 'end' : 'start'} fontSize={c.hl ? 12 : 10.5} fontWeight={c.hl ? 600 : 400} fill={c.hl ? 'var(--ink)' : 'var(--muted)'}>{name}</text>
          </g>
        );
      })}
      {points.map((p, i) => {
        const [x, y] = P(p);
        return <circle key={i} cx={x} cy={y} r={6} fill={p.kind === 'from' ? 'var(--sign)' : p.kind === 'driver' ? '#1d5fd1' : 'var(--ink)'} stroke="var(--panel)" strokeWidth={2}><title>{p.label}</title></circle>;
      })}
    </svg>
  );
}
