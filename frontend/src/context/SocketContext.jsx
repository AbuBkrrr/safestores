import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { useAuth } from './AuthContext.jsx';

const SocketContext = createContext({ socket: null, connected: false, peers: 0 });

// The Vite dev proxy forwards /socket.io to the backend, and in production
// VITE_API_URL (minus its /api suffix, if present) is the backend origin.
// Leaving this undefined makes socket.io-client default to the page's own
// origin, which is exactly right for same-origin deployments.
const apiUrl = import.meta.env.VITE_API_URL || '';
const SOCKET_ORIGIN = apiUrl ? apiUrl.replace(/\/api\/?$/, '') : undefined;

export function SocketProvider({ children }) {
  const { user } = useAuth();
  const [connected, setConnected] = useState(false);
  const [peers, setPeers] = useState(0);
  const socketRef = useRef(null);

  useEffect(() => {
    // Super admins aren't scoped to a store and desktop-edition builds may
    // not run a realtime server at all — in either case this simply never
    // connects, and every page still works fine over plain REST calls.
    if (!user || user.role === 'super_admin' || !user.storeId) return undefined;

    const token = localStorage.getItem('ss_token');
    if (!token) return undefined;

    const socket = io(SOCKET_ORIGIN, {
      auth: { token },
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
    });
    socketRef.current = socket;

    socket.on('connect', () => setConnected(true));
    socket.on('disconnect', () => setConnected(false));
    socket.on('connect_error', () => setConnected(false));
    socket.on('presence:joined', () => setPeers((p) => p + 1));
    socket.on('presence:left', () => setPeers((p) => Math.max(0, p - 1)));

    return () => {
      socket.disconnect();
      socketRef.current = null;
      setConnected(false);
      setPeers(0);
    };
  }, [user?.storeId, user?.role]);

  return (
    <SocketContext.Provider value={{ socket: socketRef.current, connected, peers }}>
      {children}
    </SocketContext.Provider>
  );
}

export function useSocket() {
  return useContext(SocketContext);
}

/**
 * Subscribes to a set of realtime events for as long as the component is
 * mounted, calling `onEvent(eventName, payload)` for each one. Pass the
 * list of event names relevant to the page (e.g. ['arrival:created',
 * 'product:updated']) so every open tab on the same store stays in sync
 * without the user needing to manually refresh.
 */
export function useRealtimeEvents(events, onEvent) {
  const { socket } = useSocket();

  useEffect(() => {
    if (!socket) return undefined;
    const handlers = events.map((event) => {
      const handler = (payload) => onEvent(event, payload);
      socket.on(event, handler);
      return [event, handler];
    });
    return () => handlers.forEach(([event, handler]) => socket.off(event, handler));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [socket, events.join(',')]);
}
