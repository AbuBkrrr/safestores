// ------------------------------------------------------------
// Native-shell wiring for the mobile (Capacitor) edition — push
// notification registration, splash screen, and status bar styling.
//
// This file is imported unconditionally (see main.jsx) so the SAME
// frontend bundle serves the web edition, the desktop edition, and the
// mobile edition — every function here checks Capacitor.isNativePlatform()
// first and is a complete no-op when that's false (i.e. running as a
// normal website or inside desktop's Electron shell, neither of which
// has anything Capacitor to talk to). Safe to call from anywhere.
// ------------------------------------------------------------

import { Capacitor } from '@capacitor/core';
import api from '../api/client.js';

const isNative = () => Capacitor.isNativePlatform();

/** Hides the native splash screen once the app has actually mounted and rendered — call once, on startup. */
export async function hideSplashScreen() {
  if (!isNative()) return;
  const { SplashScreen } = await import('@capacitor/splash-screen');
  await SplashScreen.hide();
}

/** Matches the native status bar to the app's brand color — call once, on startup. */
export async function setupStatusBar() {
  if (!isNative()) return;
  const { StatusBar, Style } = await import('@capacitor/status-bar');
  try {
    await StatusBar.setBackgroundColor({ color: '#0f7180' });
    await StatusBar.setStyle({ style: Style.Dark }); // light icons/text on the dark teal bar
  } catch {
    // Some OEM Android builds don't support setBackgroundColor — harmless to skip.
  }
}

/**
 * Requests notification permission and registers this device's FCM token
 * with the backend (POST /api/push/register), so the store's other staff
 * can push this device recount alerts, new Marketplace orders, and
 * support replies — see backend/src/utils/push.js for what triggers a
 * send. Call this right after a successful login (see AuthContext.jsx).
 */
export async function registerPushOnLogin() {
  if (!isNative()) return;
  const { PushNotifications } = await import('@capacitor/push-notifications');

  const permission = await PushNotifications.requestPermissions();
  if (permission.receive !== 'granted') return;

  await PushNotifications.register();

  // 'registration' fires once FCM hands back this device's token. Cached
  // locally (not sensitive — it only identifies a device inbox, not an
  // account) purely so unregisterPushOnLogout() below can reference it;
  // the backend is still the source of truth via the ON CONFLICT (token)
  // upsert in migrations/023, this is just so logout can clean up.
  PushNotifications.addListener('registration', (token) => {
    localStorage.setItem('ss_push_token', token.value);
    api.post('/push/register', { token: token.value, platform: Capacitor.getPlatform() }).catch(() => {
      // Offline at login time is fine — this device just re-registers
      // (or gets caught by the next login) rather than needing a retry
      // queue; a missed registration only means missed pushes, not a
      // data-integrity problem.
    });
  });

  // Tapping a notification while the app is backgrounded/closed lands here.
  PushNotifications.addListener('pushNotificationActionPerformed', (action) => {
    const data = action.notification?.data;
    if (data?.type === 'recount_needed') window.location.hash = '#/shelf-audit';
    else if (data?.type === 'marketplace.order_placed') window.location.hash = '#/marketplace';
    else if (data?.type === 'support_ticket.replied') window.location.hash = '#/support';
  });
}

/** Un-registers this device's push token — call on logout so a shared/reinstalled device stops getting the previous user's alerts. */
export async function unregisterPushOnLogout() {
  if (!isNative()) return;
  const token = localStorage.getItem('ss_push_token');
  if (!token) return;
  try {
    await api.delete('/push/register', { data: { token } });
  } catch {
    // Best-effort — logout should never fail because of this.
  } finally {
    localStorage.removeItem('ss_push_token');
  }
}
