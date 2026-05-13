import { getSessionToken } from './session';

const BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const token = await getSessionToken();
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-SM-Token': token
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  getSignals: (bbox: { swLat: number; swLng: number; neLat: number; neLng: number; categories?: string[] }) => {
    const params = new URLSearchParams({
      sw_lat: String(bbox.swLat),
      sw_lng: String(bbox.swLng),
      ne_lat: String(bbox.neLat),
      ne_lng: String(bbox.neLng)
    });
    if (bbox.categories?.length) params.set('categories', bbox.categories.join(','));
    return req('GET', `/api/signals?${params.toString()}`);
  },
  createSignal: (data: { category: string; lat: number; lng: number; description?: string; image_url?: string }) =>
    req('POST', '/api/signals', data),
  confirmSignal: (id: string) => req('POST', `/api/signals/${id}/confirm`, {}),
  flagSignal: (id: string, reason?: string) => req('POST', `/api/signals/${id}/flag`, { reason }),
  getSignal: (id: string) => req('GET', `/api/signals/${id}`),
  getStats: () => req('GET', '/api/stats')
};
