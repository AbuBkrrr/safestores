import { createContext, useContext, useEffect, useState } from 'react';
import api from '../api/client.js';
import { useAuth } from './AuthContext.jsx';
import { queueSize } from '../offline/outbox.js';
import { onSyncEvent, startAutoSync } from '../offline/sync.js';

const OfflineContext = createContext({ isOnline: true, queuedCount: 0 });

export function OfflineProvider({ children }) {
  const { user } = useAuth();
  const [isOnline, setIsOnline] = useState(typeof navigator === 'undefined' ? true : navigator.onLine);
  const [queuedCount, setQueuedCount] = useState(0);

  const refreshCount = () => {
    if (user?.storeId) queueSize(user.storeId).then(setQueuedCount).catch(() => {});
  };

  useEffect(() => {
    const goOnline = () => setIsOnline(true);
    const goOffline = () => setIsOnline(false);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => { window.removeEventListener('online', goOnline); window.removeEventListener('offline', goOffline); };
  }, []);

  useEffect(() => {
    if (!user?.storeId) return undefined;
    refreshCount();
    const stopSync = startAutoSync(api, () => user.storeId);
    const unsubscribe = onSyncEvent(() => refreshCount());
    const interval = setInterval(refreshCount, 10000);
    return () => { stopSync(); unsubscribe(); clearInterval(interval); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.storeId]);

  return (
    <OfflineContext.Provider value={{ isOnline, queuedCount }}>
      {children}
    </OfflineContext.Provider>
  );
}

export function useOffline() {
  return useContext(OfflineContext);
}
