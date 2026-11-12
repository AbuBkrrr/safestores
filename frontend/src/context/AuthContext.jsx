import { createContext, useContext, useState, useCallback } from 'react';
import { registerPushOnLogin, unregisterPushOnLogout } from '../mobile/push.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(() => {
    const raw = localStorage.getItem('ss_user');
    return raw ? JSON.parse(raw) : null;
  });

  const login = useCallback((token, userData) => {
    localStorage.setItem('ss_token', token);
    localStorage.setItem('ss_user', JSON.stringify(userData));
    setUser(userData);
    registerPushOnLogin(); // no-op outside the mobile app — see mobile/push.js
  }, []);

  const updateUser = useCallback((partial) => {
    setUser((prev) => {
      const next = { ...prev, ...partial };
      localStorage.setItem('ss_user', JSON.stringify(next));
      return next;
    });
  }, []);

  const logout = useCallback(() => {
    unregisterPushOnLogout(); // no-op outside the mobile app — see mobile/push.js
    localStorage.removeItem('ss_token');
    localStorage.removeItem('ss_user');
    setUser(null);
  }, []);

  return (
    <AuthContext.Provider value={{ user, login, logout, updateUser }}>
      {children}
    </AuthContext.Provider>
  );
}

/** Like useAuth, but returns {} outside an AuthProvider instead of throwing. */
export function useOptionalAuth() {
  return useContext(AuthContext) || {};
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
