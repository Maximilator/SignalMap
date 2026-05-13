const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';
const TOKEN_KEY = 'sm_session_token_v2';

export async function getSessionToken(): Promise<string> {
  if (typeof window === 'undefined') return '';
  const existing = localStorage.getItem(TOKEN_KEY);
  if (existing) return existing;

  const res = await fetch(`${API_BASE}/api/session`, { method: 'POST' });
  if (!res.ok) throw new Error('Failed to create SignalMap session');
  const data = await res.json() as { token: string };
  localStorage.setItem(TOKEN_KEY, data.token);
  return data.token;
}
