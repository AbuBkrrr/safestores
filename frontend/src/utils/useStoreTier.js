import { useEffect, useState } from 'react';
import api from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';

// The store's size (mini / midi / mega). Comes with the login; older sessions
// fetch it once from store settings.
let cached = { storeId: null, tier: null };

export function useStoreTier() {
  const { user } = useAuth();
  const [tier, setTier] = useState(user?.storeTier || (cached.storeId === user?.storeId ? cached.tier : null));
  useEffect(() => {
    if (!user?.storeId || user.storeTier || (cached.storeId === user.storeId && cached.tier)) return;
    api.get(`/stores/${user.storeId}/settings`).then((r) => {
      cached = { storeId: user.storeId, tier: r.data.store_tier || null };
      setTier(cached.tier);
    }).catch(() => {});
  }, [user?.storeId, user?.storeTier]);
  return user?.storeTier || tier;
}

/** Pages a Mini store (owner + 1–2 helpers) doesn't need. */
export const MINI_HIDDEN = ['/handovers', '/exit-check', '/transfers', '/integrations', '/cycle-counting', '/shrinkage-report'];
/** Roles a Mini store can invite. */
export const MINI_ROLES = ['manager', 'cashier', 'staff'];
