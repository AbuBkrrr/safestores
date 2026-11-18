import { useEffect, useState } from 'react';
import api from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import { toolsFor } from './businessTypes.js';

// The store's size (mini / midi / mega) and business type. Both come with the
// login; older sessions fetch them once from store settings.
let cached = { storeId: null, tier: null, businessType: null };
const listeners = new Set();

/** Call after the admin changes the business type in Store Settings. */
export function setCachedProfile(storeId, patch) {
  cached = { ...cached, storeId, ...patch };
  listeners.forEach((fn) => fn(cached));
}

export function useStoreProfile() {
  const { user } = useAuth();
  const [p, setP] = useState(cached.storeId === user?.storeId ? cached : {});
  useEffect(() => {
    const fn = (c) => setP({ ...c });
    listeners.add(fn);
    if (user?.storeId && !(cached.storeId === user.storeId && cached.businessType)) {
      api.get(`/stores/${user.storeId}/settings`).then((r) => {
        setCachedProfile(user.storeId, { tier: r.data.store_tier || null, businessType: r.data.business_type || 'general' });
      }).catch(() => {});
    }
    return () => listeners.delete(fn);
  }, [user?.storeId]);
  const tier = (p.storeId === user?.storeId && p.tier) || user?.storeTier || null;
  const businessType = (p.storeId === user?.storeId && p.businessType) || user?.businessType || 'general';
  return { tier, businessType, tools: toolsFor(businessType) };
}

export function useStoreTier() {
  return useStoreProfile().tier;
}

/** Pages a Mini store (owner + 1–2 helpers) doesn't need. */
export const MINI_HIDDEN = ['/handovers', '/exit-check', '/transfers', '/integrations', '/cycle-counting', '/shrinkage-report'];
/** Roles a Mini store can invite. */
export const MINI_ROLES = ['manager', 'cashier', 'staff'];
