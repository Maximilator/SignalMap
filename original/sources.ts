// ════════════════════════════════════════════════════════════
// SignalMap — Complete Next.js Frontend Source
// All components in one file for reference; split as needed.
// ════════════════════════════════════════════════════════════

// ────────────────────────────────────────────────────────────
// FILE: app/layout.tsx
// ────────────────────────────────────────────────────────────
import type { Metadata } from 'next';
import { Syne, JetBrains_Mono } from 'next/font/google';
import './globals.css';

const syne = Syne({ subsets: ['latin'], variable: '--font-syne', weight: ['400','500','600','700','800'] });
const mono = JetBrains_Mono({ subsets: ['latin'], variable: '--font-mono', weight: ['400','500','600'] });

export const metadata: Metadata = {
  title: 'SignalMap — Urban Intelligence Layer',
  description: 'Real-time crowd-sourced urban activity map. Report and confirm signals.',
  openGraph: {
    title: 'SignalMap',
    description: 'Live urban activity map',
    type: 'website',
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${syne.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  );
}

// ────────────────────────────────────────────────────────────
// FILE: app/globals.css
// ────────────────────────────────────────────────────────────
/*
@import url('https://unpkg.com/maplibre-gl@4.1.3/dist/maplibre-gl.css');

*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

:root {
  --bg0: #070810;
  --bg1: #0b0d16;
  --bg2: #0f1220;
  --bg3: #141828;
  --bg4: #1a2035;
  --border: rgba(255,255,255,0.06);
  --border2: rgba(255,255,255,0.11);
  --border3: rgba(255,255,255,0.18);
  --text0: #eef0f8;
  --text1: #c2c8dc;
  --text2: #7a8299;
  --text3: #3d4460;
  --accent: #00d4ff;
  --accent-dim: rgba(0,212,255,0.12);
  --green: #00e87a;
  --green-dim: rgba(0,232,122,0.12);
  --amber: #ffb300;
  --red: #ff3355;
  --purple: #a066ff;
  --font: var(--font-syne, 'Syne', sans-serif);
  --mono: var(--font-mono, 'JetBrains Mono', monospace);
  --radius: 10px;
  --radius-sm: 6px;
  --radius-lg: 16px;
  --transition: 0.18s cubic-bezier(0.4,0,0.2,1);
}

html, body { width: 100%; height: 100%; background: var(--bg0); overflow: hidden; }
*/

// ────────────────────────────────────────────────────────────
// FILE: app/page.tsx
// ────────────────────────────────────────────────────────────
'use client';
import { useEffect } from 'react';
import MapCanvas from '@/components/map/MapCanvas';
import TopBar from '@/components/ui/TopBar';
import FilterPanel from '@/components/ui/FilterPanel';
import SignalDrawer from '@/components/ui/SignalDrawer';
import CreatePanel from '@/components/ui/CreatePanel';
import ToastContainer from '@/components/ui/ToastContainer';
import StatsBar from '@/components/ui/StatsBar';
import ZoomControls from '@/components/ui/ZoomControls';
import Fab from '@/components/ui/Fab';
import CrosshairOverlay from '@/components/ui/CrosshairOverlay';
import MapDim from '@/components/ui/MapDim';
import { useSocket } from '@/hooks/useSocket';
import { useSignalSync } from '@/hooks/useSignalSync';

export default function MapPage() {
  useSocket();
  useSignalSync();

  return (
    <div style={{ position: 'fixed', inset: 0 }}>
      <MapCanvas />
      <CrosshairOverlay />
      <MapDim />
      <div id="overlay" style={{ position: 'fixed', inset: 0, zIndex: 10, pointerEvents: 'none' }}>
        <TopBar />
        <ZoomControls />
        <FilterPanel />
        <StatsBar />
        <ToastContainer />
        <Fab />
        <SignalDrawer />
        <CreatePanel />
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────
// FILE: components/map/MapCanvas.tsx
// ────────────────────────────────────────────────────────────
'use client';
import { useEffect, useRef } from 'react';
import maplibregl from 'maplibre-gl';
import { useMapStore } from '@/store/mapStore';
import { useSignalStore } from '@/store/signalStore';
import { useFilterStore } from '@/store/filterStore';
import { useUIStore } from '@/store/uiStore';
import { buildGeoJSON } from '@/lib/geojson';
import { debounce } from '@/lib/utils';
import { CATEGORY_COLORS } from '@/lib/constants';

export default function MapCanvas() {
  const containerRef = useRef<HTMLDivElement>(null);
  const { setMap, setReady } = useMapStore();
  const { signals } = useSignalStore();
  const { activeFilters } = useFilterStore();
  const { createMode, setCreateCoords, openCreatePanel } = useUIStore();

  useEffect(() => {
    if (!containerRef.current) return;

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
      center: [4.9, 52.37],
      zoom: 13,
      minZoom: 5,
      maxZoom: 19,
      attributionControl: false,
    });

    map.on('load', () => {
      // GeoJSON source
      map.addSource('signals', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });

      // Heatmap layer
      map.addLayer({
        id: 'signals-heat',
        type: 'heatmap',
        source: 'signals',
        maxzoom: 12,
        paint: {
          'heatmap-weight': ['interpolate', ['linear'], ['get', 'trust'], 0, 0, 100, 1],
          'heatmap-intensity': ['interpolate', ['linear'], ['zoom'], 5, 0.5, 12, 2],
          'heatmap-color': [
            'interpolate', ['linear'], ['heatmap-density'],
            0, 'rgba(0,0,0,0)', 0.3, 'rgba(0,100,180,0.4)',
            0.6, 'rgba(0,212,255,0.6)', 1, 'rgba(255,30,60,0.9)'
          ],
          'heatmap-radius': 30,
          'heatmap-opacity': 0.8,
        }
      });

      // Circle signals
      map.addLayer({
        id: 'signals-circles',
        type: 'circle',
        source: 'signals',
        minzoom: 10,
        paint: {
          'circle-color': ['get', 'color'],
          'circle-radius': ['interpolate', ['linear'], ['get', 'trust'], 0, 5, 30, 8, 70, 12, 100, 18],
          'circle-opacity': ['interpolate', ['linear'], ['get', 'freshness'], 0, 0.2, 1, 0.9],
          'circle-stroke-width': ['interpolate', ['linear'], ['get', 'trust'], 0, 0, 50, 1.5, 100, 2.5],
          'circle-stroke-color': ['get', 'color'],
          'circle-stroke-opacity': 0.5,
          'circle-blur': ['interpolate', ['linear'], ['get', 'freshness'], 0, 0.6, 1, 0],
        }
      });

      // Pulse ring layer
      map.addLayer({
        id: 'signals-pulse',
        type: 'circle',
        source: 'signals',
        minzoom: 11,
        filter: ['>', ['get', 'trust'], 60],
        paint: {
          'circle-color': 'rgba(0,0,0,0)',
          'circle-radius': ['interpolate', ['linear'], ['get', 'trust'], 60, 14, 100, 28],
          'circle-stroke-width': 1.5,
          'circle-stroke-color': ['get', 'color'],
          'circle-stroke-opacity': 0.3,
          'circle-opacity': 0,
        }
      });

      map.on('click', 'signals-circles', (e) => {
        if (useUIStore.getState().createMode) return;
        const id = e.features?.[0]?.properties?.id;
        if (id) useUIStore.getState().openDrawer(id);
        e.stopPropagation();
      });

      map.on('mouseenter', 'signals-circles', () => {
        map.getCanvas().style.cursor = 'pointer';
      });

      map.on('mouseleave', 'signals-circles', () => {
        map.getCanvas().style.cursor = useUIStore.getState().createMode ? 'crosshair' : '';
      });

      setMap(map);
      setReady(true);
    });

    // Map click for create mode
    map.on('click', (e) => {
      const uiState = useUIStore.getState();
      if (uiState.createMode) {
        setCreateCoords(e.lngLat.lat, e.lngLat.lng);
        openCreatePanel();
      }
    });

    // Viewport changes
    const handleViewport = debounce(() => {
      const bounds = map.getBounds();
      const sw = bounds.getSouthWest();
      const ne = bounds.getNorthEast();
      // Emit via socket
      import('@/lib/socket').then(({ socket }) => {
        socket.emit('viewport:update', {
          sw: { lat: sw.lat, lng: sw.lng },
          ne: { lat: ne.lat, lng: ne.lng },
          zoom: map.getZoom(),
        });
      });
    }, 300);

    map.on('moveend', handleViewport);

    return () => {
      map.remove();
      setReady(false);
    };
  }, []);

  return (
    <div
      ref={containerRef}
      style={{ position: 'fixed', inset: 0, zIndex: 0 }}
    />
  );
}

// ────────────────────────────────────────────────────────────
// FILE: store/signalStore.ts
// ────────────────────────────────────────────────────────────
import { create } from 'zustand';
import type { Signal } from '@/types';
import { computeTrustScore } from '@/lib/trust';

interface SignalState {
  signals: Map<string, Signal>;
  addSignal: (sig: Signal) => void;
  updateSignal: (id: string, patch: Partial<Signal>) => void;
  removeSignal: (id: string) => void;
  setSignals: (signals: Signal[]) => void;
  runDecay: () => void;
}

export const useSignalStore = create<SignalState>((set, get) => ({
  signals: new Map(),

  addSignal: (sig) => set((s) => {
    const next = new Map(s.signals);
    next.set(sig.id, sig);
    return { signals: next };
  }),

  updateSignal: (id, patch) => set((s) => {
    const sig = s.signals.get(id);
    if (!sig) return s;
    const next = new Map(s.signals);
    next.set(id, { ...sig, ...patch });
    return { signals: next };
  }),

  removeSignal: (id) => set((s) => {
    const next = new Map(s.signals);
    next.delete(id);
    return { signals: next };
  }),

  setSignals: (signals) => set(() => {
    const map = new Map<string, Signal>();
    signals.forEach(s => map.set(s.id, s));
    return { signals: map };
  }),

  runDecay: () => set((s) => {
    const next = new Map(s.signals);
    const expired: string[] = [];

    for (const [id, sig] of next) {
      const { score, freshness, state } = computeTrustScore(sig);
      if (freshness < 0.02 || Date.now() > new Date(sig.expires_at).getTime()) {
        expired.push(id);
      } else {
        next.set(id, { ...sig, trust_score: score, freshness, trust_state: state });
      }
    }

    expired.forEach(id => next.delete(id));
    return { signals: next };
  }),
}));

// ────────────────────────────────────────────────────────────
// FILE: store/filterStore.ts
// ────────────────────────────────────────────────────────────
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { SIGNAL_CATEGORIES } from '@/lib/constants';
import type { SignalCategory } from '@/types';

interface FilterState {
  activeFilters: Set<SignalCategory>;
  toggleFilter: (cat: SignalCategory) => void;
  setAllFilters: (enabled: boolean) => void;
}

export const useFilterStore = create<FilterState>()(
  persist(
    (set) => ({
      activeFilters: new Set(SIGNAL_CATEGORIES),

      toggleFilter: (cat) => set((s) => {
        const next = new Set(s.activeFilters);
        if (next.has(cat)) next.delete(cat);
        else next.add(cat);
        return { activeFilters: next };
      }),

      setAllFilters: (enabled) => set(() => ({
        activeFilters: enabled ? new Set(SIGNAL_CATEGORIES) : new Set(),
      })),
    }),
    {
      name: 'sm-filters',
      storage: {
        getItem: (key) => {
          const val = localStorage.getItem(key);
          if (!val) return null;
          const parsed = JSON.parse(val);
          return { ...parsed, state: { ...parsed.state, activeFilters: new Set(parsed.state.activeFilters) } };
        },
        setItem: (key, val) => {
          localStorage.setItem(key, JSON.stringify({
            ...val, state: { ...val.state, activeFilters: [...val.state.activeFilters] }
          }));
        },
        removeItem: (key) => localStorage.removeItem(key),
      },
    }
  )
);

// ────────────────────────────────────────────────────────────
// FILE: store/uiStore.ts
// ────────────────────────────────────────────────────────────
import { create } from 'zustand';

interface UIState {
  selectedSignalId: string | null;
  drawerOpen: boolean;
  createPanelOpen: boolean;
  createMode: boolean;
  createLat: number | null;
  createLng: number | null;
  selectedCategory: string | null;
  toasts: Array<{ id: string; icon: string; message: string; color: string }>;

  openDrawer: (signalId: string) => void;
  closeDrawer: () => void;
  enterCreateMode: () => void;
  exitCreateMode: () => void;
  openCreatePanel: () => void;
  closeCreatePanel: () => void;
  setCreateCoords: (lat: number, lng: number) => void;
  selectCategory: (cat: string) => void;
  addToast: (icon: string, message: string, color?: string) => void;
  removeToast: (id: string) => void;
}

export const useUIStore = create<UIState>((set, get) => ({
  selectedSignalId: null,
  drawerOpen: false,
  createPanelOpen: false,
  createMode: false,
  createLat: null,
  createLng: null,
  selectedCategory: null,
  toasts: [],

  openDrawer: (signalId) => set({ selectedSignalId: signalId, drawerOpen: true }),
  closeDrawer: () => set({ selectedSignalId: null, drawerOpen: false }),

  enterCreateMode: () => set({ createMode: true }),
  exitCreateMode: () => set({
    createMode: false, createPanelOpen: false,
    createLat: null, createLng: null, selectedCategory: null,
  }),

  openCreatePanel: () => set({ createPanelOpen: true, createMode: false }),
  closeCreatePanel: () => {
    set({ createPanelOpen: false, selectedCategory: null });
    get().exitCreateMode();
  },

  setCreateCoords: (lat, lng) => set({ createLat: lat, createLng: lng }),
  selectCategory: (cat) => set({ selectedCategory: cat }),

  addToast: (icon, message, color = '#00d4ff') => {
    const id = Math.random().toString(36).slice(2);
    set(s => ({ toasts: [...s.toasts, { id, icon, message, color }] }));
    setTimeout(() => get().removeToast(id), 3000);
  },

  removeToast: (id) => set(s => ({ toasts: s.toasts.filter(t => t.id !== id) })),
}));

// ────────────────────────────────────────────────────────────
// FILE: store/mapStore.ts
// ────────────────────────────────────────────────────────────
import { create } from 'zustand';
import type maplibregl from 'maplibre-gl';

interface MapState {
  map: maplibregl.Map | null;
  ready: boolean;
  setMap: (map: maplibregl.Map) => void;
  setReady: (r: boolean) => void;
  updateSource: (geojson: GeoJSON.FeatureCollection) => void;
}

export const useMapStore = create<MapState>((set, get) => ({
  map: null,
  ready: false,
  setMap: (map) => set({ map }),
  setReady: (ready) => set({ ready }),
  updateSource: (geojson) => {
    const { map, ready } = get();
    if (!map || !ready) return;
    const src = map.getSource('signals') as maplibregl.GeoJSONSource;
    src?.setData(geojson);
  },
}));

// ────────────────────────────────────────────────────────────
// FILE: hooks/useSignalSync.ts
// ────────────────────────────────────────────────────────────
import { useEffect } from 'react';
import { socket } from '@/lib/socket';
import { useSignalStore } from '@/store/signalStore';
import { useMapStore } from '@/store/mapStore';
import { useFilterStore } from '@/store/filterStore';
import { useUIStore } from '@/store/uiStore';
import { buildGeoJSON } from '@/lib/geojson';
import type { Signal, SignalFeature } from '@/types';

// The key pattern: WS events update the MapLibre source directly,
// bypassing React render cycle for maximum performance.
export function useSignalSync() {
  const { addSignal, updateSignal, removeSignal, setSignals, runDecay } = useSignalStore();
  const { updateSource } = useMapStore();
  const { activeFilters } = useFilterStore();
  const { addToast } = useUIStore();

  useEffect(() => {
    // Initial viewport load
    socket.on('signals:init', (featureCollection: GeoJSON.FeatureCollection) => {
      const signals = featureCollection.features.map(featureToSignal);
      setSignals(signals);
      const geojson = buildGeoJSON(useSignalStore.getState().signals, activeFilters);
      updateSource(geojson);
    });

    // New signal created
    socket.on('signal:created', ({ feature }: { feature: SignalFeature }) => {
      const sig = featureToSignal(feature);
      addSignal(sig);
      const geojson = buildGeoJSON(useSignalStore.getState().signals, useFilterStore.getState().activeFilters);
      updateSource(geojson);
      addToast(getCategoryEmoji(sig.category), `New ${sig.category.replace('_', ' ')} nearby`, getCategoryColor(sig.category));
    });

    // Signal updated (confirm / decay)
    socket.on('signal:updated', (patch: Partial<Signal> & { id: string }) => {
      updateSignal(patch.id, patch);
      const geojson = buildGeoJSON(useSignalStore.getState().signals, useFilterStore.getState().activeFilters);
      updateSource(geojson);
    });

    // Signal expired
    socket.on('signal:expired', ({ id }: { id: string }) => {
      removeSignal(id);
      const geojson = buildGeoJSON(useSignalStore.getState().signals, useFilterStore.getState().activeFilters);
      updateSource(geojson);
    });

    return () => {
      socket.off('signals:init');
      socket.off('signal:created');
      socket.off('signal:updated');
      socket.off('signal:expired');
    };
  }, []);

  // Client-side decay loop (15s)
  useEffect(() => {
    const interval = setInterval(() => {
      runDecay();
      const geojson = buildGeoJSON(useSignalStore.getState().signals, useFilterStore.getState().activeFilters);
      updateSource(geojson);
    }, 15000);
    return () => clearInterval(interval);
  }, []);

  // Re-apply filter changes to map source
  useEffect(() => {
    const geojson = buildGeoJSON(useSignalStore.getState().signals, activeFilters);
    updateSource(geojson);
  }, [activeFilters]);
}

// ────────────────────────────────────────────────────────────
// FILE: hooks/useSocket.ts
// ────────────────────────────────────────────────────────────
import { useEffect } from 'react';
import { socket } from '@/lib/socket';

export function useSocket() {
  useEffect(() => {
    if (!socket.connected) socket.connect();
    return () => { /* keep connected across navigation */ };
  }, []);
}

// ────────────────────────────────────────────────────────────
// FILE: lib/socket.ts
// ────────────────────────────────────────────────────────────
import { io } from 'socket.io-client';

export const socket = io(process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001', {
  transports: ['websocket', 'polling'],
  autoConnect: false,
  reconnection: true,
  reconnectionAttempts: 10,
  reconnectionDelay: 1000,
});

// ────────────────────────────────────────────────────────────
// FILE: lib/api.ts
// ────────────────────────────────────────────────────────────
const BASE = process.env.NEXT_PUBLIC_API_URL || '';
const getToken = () => localStorage.getItem('sm_token') || '';

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-SM-Token': getToken(),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(err.error || `HTTP ${res.status}`);
  }

  return res.json();
}

export const api = {
  getSignals: (bbox: { swLat: number; swLng: number; neLat: number; neLng: number }) =>
    req('GET', `/api/signals?sw_lat=${bbox.swLat}&sw_lng=${bbox.swLng}&ne_lat=${bbox.neLat}&ne_lng=${bbox.neLng}`),

  createSignal: (data: { category: string; lat: number; lng: number; description?: string; image_url?: string }) =>
    req('POST', '/api/signals', data),

  confirmSignal: (id: string) =>
    req('POST', `/api/signals/${id}/confirm`, {}),

  getSignal: (id: string) =>
    req('GET', `/api/signals/${id}`),

  getStats: () =>
    req('GET', '/api/stats'),
};

// ────────────────────────────────────────────────────────────
// FILE: lib/trust.ts
// ────────────────────────────────────────────────────────────
import { DECAY_RATES } from './constants';
import type { Signal, TrustState } from '@/types';

export function computeTrustScore(sig: Signal): { score: number; freshness: number; state: TrustState } {
  const ageMinutes = (Date.now() - new Date(sig.created_at).getTime()) / 60000;
  const lambda = DECAY_RATES[sig.category] ?? 0.02;
  const freshness = Math.exp(-lambda * ageMinutes);
  const base = Math.min(sig.confirmation_count * 8, 60) + 8;
  const score = Math.min(100, Math.round(base * freshness));

  let state: TrustState = 'ghost';
  if (score > 10) state = 'low';
  if (score > 25) state = 'medium';
  if (score > 55) state = 'high';
  if (score > 80) state = 'verified';

  return { score, freshness: Math.max(0, freshness), state };
}

export function getTrustColor(score: number): string {
  if (score <= 10) return '#a066ff';
  if (score <= 25) return '#94a3b8';
  if (score <= 55) return '#ffb300';
  if (score <= 80) return '#00e87a';
  return '#ff3355';
}

export function getTrustLabel(state: TrustState): string {
  return { ghost: 'GHOST', low: 'LOW', medium: 'MEDIUM', high: 'HIGH', verified: 'VERIFIED' }[state];
}

// ────────────────────────────────────────────────────────────
// FILE: lib/geojson.ts
// ────────────────────────────────────────────────────────────
import { CATEGORY_COLORS } from './constants';
import type { Signal, SignalCategory } from '@/types';

export function buildGeoJSON(
  signals: Map<string, Signal>,
  activeFilters: Set<SignalCategory>
): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = [];

  for (const sig of signals.values()) {
    if (!activeFilters.has(sig.category)) continue;
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [sig.lng, sig.lat] },
      properties: {
        id: sig.id,
        category: sig.category,
        trust: sig.trust_score,
        freshness: sig.freshness,
        color: CATEGORY_COLORS[sig.category] || '#888',
        confirmation_count: sig.confirmation_count,
        trust_state: sig.trust_state,
      },
    });
  }

  return { type: 'FeatureCollection', features };
}

// ────────────────────────────────────────────────────────────
// FILE: lib/constants.ts
// ────────────────────────────────────────────────────────────
export const SIGNAL_CATEGORIES = [
  'police_patrol', 'foot_patrol', 'bicycle_patrol', 'road_check',
  'incident', 'protest', 'public_action', 'temp_restriction',
  'emergency', 'unusual_activity',
] as const;

export const CATEGORIES = [
  { id: 'police_patrol',    label: 'Police patrol',   emoji: '🚔', color: '#3d8bff', rgb: '61,139,255' },
  { id: 'foot_patrol',     label: 'Foot patrol',     emoji: '🦺', color: '#a066ff', rgb: '160,102,255' },
  { id: 'bicycle_patrol',  label: 'Bicycle patrol',  emoji: '🚴', color: '#00c97a', rgb: '0,201,122' },
  { id: 'road_check',      label: 'Road check',      emoji: '🚧', color: '#ffb300', rgb: '255,179,0' },
  { id: 'incident',        label: 'Incident',        emoji: '⚠️', color: '#ff3355', rgb: '255,51,85' },
  { id: 'protest',         label: 'Protest',         emoji: '✊', color: '#ff6b6b', rgb: '255,107,107' },
  { id: 'public_action',   label: 'Public action',   emoji: '📢', color: '#ff7733', rgb: '255,119,51' },
  { id: 'temp_restriction',label: 'Restriction',     emoji: '🚫', color: '#00b8d4', rgb: '0,184,212' },
  { id: 'emergency',       label: 'Emergency',       emoji: '🚨', color: '#ff0033', rgb: '255,0,51' },
  { id: 'unusual_activity',label: 'Unusual',         emoji: '👁',  color: '#94a3b8', rgb: '148,163,184' },
] as const;

export const CATEGORY_COLORS: Record<string, string> = Object.fromEntries(
  CATEGORIES.map(c => [c.id, c.color])
);

export const DECAY_RATES: Record<string, number> = {
  police_patrol: 0.020, foot_patrol: 0.022, bicycle_patrol: 0.022,
  road_check: 0.015, incident: 0.035, protest: 0.008,
  public_action: 0.018, temp_restriction: 0.006,
  emergency: 0.010, unusual_activity: 0.040,
};

export const CATEGORY_TTL: Record<string, number> = {
  police_patrol: 45, foot_patrol: 40, bicycle_patrol: 40,
  road_check: 60, incident: 30, protest: 180,
  public_action: 60, temp_restriction: 240,
  emergency: 120, unusual_activity: 20,
};

// ────────────────────────────────────────────────────────────
// FILE: types/index.ts
// ────────────────────────────────────────────────────────────
export type SignalCategory =
  | 'police_patrol' | 'foot_patrol' | 'bicycle_patrol'
  | 'road_check' | 'incident' | 'protest'
  | 'public_action' | 'temp_restriction'
  | 'emergency' | 'unusual_activity';

export type TrustState = 'ghost' | 'low' | 'medium' | 'high' | 'verified';

export interface Signal {
  id: string;
  category: SignalCategory;
  lat: number;
  lng: number;
  description?: string;
  image_url?: string;
  reporter_token?: string;
  trust_score: number;
  confirmation_count: number;
  freshness: number;
  trust_state: TrustState;
  is_active: boolean;
  created_at: string | Date;
  expires_at: string | Date;
  updated_at?: string | Date;
}

export interface SignalFeature extends GeoJSON.Feature<GeoJSON.Point> {
  properties: {
    id: string;
    category: SignalCategory;
    trust: number;
    freshness: number;
    color: string;
    confirmation_count: number;
    trust_state: TrustState;
    description?: string;
    age_minutes?: number;
  };
}
