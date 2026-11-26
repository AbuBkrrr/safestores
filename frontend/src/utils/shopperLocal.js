// What the shopper app remembers on this phone (no account needed):
// favourite items and shops, shopping list, shops visited, items bought,
// orders placed (tracking links) and messages sent to shops.
const KEY = 'ss_shopper_v1';
const read = () => { try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { return {}; } };
const write = (d) => { try { localStorage.setItem(KEY, JSON.stringify(d)); } catch { /* storage full or blocked */ } window.dispatchEvent(new Event('ss-shopper')); };
const upd = (fn) => { const d = read(); fn(d); write(d); return d; };

export const shopper = {
  all: read,
  isFav: (kind, id) => !!(read()[kind] || {})[id],
  toggleFav: (kind, item) => upd((d) => { d[kind] = d[kind] || {}; if (d[kind][item.id]) delete d[kind][item.id]; else d[kind][item.id] = { ...item, at: Date.now() }; }),
  visitStore: (store) => upd((d) => { d.visits = d.visits || {}; const v = d.visits[store.id] || { ...store, n: 0 }; d.visits[store.id] = { ...v, ...store, n: v.n + 1, at: Date.now() }; }),
  frequentStores: () => Object.values(read().visits || {}).sort((a, b) => b.n - a.n || b.at - a.at).slice(0, 12),
  addOrder: (order) => upd((d) => { d.orders = [order, ...(d.orders || [])].slice(0, 50); for (const it of order.items || []) { d.bought = d.bought || {}; const b = d.bought[it.id] || { ...it, n: 0 }; d.bought[it.id] = { ...b, ...it, n: b.n + 1, at: Date.now() }; } }),
  orders: () => read().orders || [],
  buyAgain: () => Object.values(read().bought || {}).sort((a, b) => b.n - a.n || b.at - a.at).slice(0, 12),
  addMessage: (m) => upd((d) => { d.messages = [m, ...(d.messages || [])].slice(0, 50); }),
  messages: () => read().messages || [],
  list: () => read().list || [],
  addToList: (text) => upd((d) => { d.list = [...(d.list || []), { id: Date.now().toString(36), text: String(text).slice(0, 80), done: false }]; }),
  toggleList: (id) => upd((d) => { d.list = (d.list || []).map((x) => (x.id === id ? { ...x, done: !x.done } : x)); }),
  removeFromList: (id) => upd((d) => { d.list = (d.list || []).filter((x) => x.id !== id); }),
  profile: () => read().profile || {},
  saveProfile: (p) => upd((d) => { d.profile = { ...(d.profile || {}), ...p }; }),
};
