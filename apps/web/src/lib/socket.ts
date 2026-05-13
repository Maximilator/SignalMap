import { io } from 'socket.io-client';
import { getSessionToken } from './session';

const BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

export const socket = io(BASE, {
  transports: ['websocket', 'polling'],
  autoConnect: false,
  reconnection: true,
  reconnectionAttempts: 10,
  reconnectionDelay: 1000
});

export async function connectSocket() {
  socket.auth = { token: await getSessionToken() };
  if (!socket.connected) socket.connect();
  return socket;
}
