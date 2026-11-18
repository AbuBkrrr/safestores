import { useEffect, useState } from 'react';
import api from '../../api/client.js';
import { Badge, Toast } from '../../components/ui.jsx';
import { useToast } from '../../components/useToast.js';
import { useCurrency } from '../../context/CurrencyContext.jsx';
import { CURRENCIES } from '../../utils/currency.js';

const ALL_METHODS = [
  { value: 'ussd', label: 'USSD' },
  { value: 'bank_transfer', label: 'Bank Transfer' },
  { value: 'cash', label: 'Cash' },
  { value: 'card', label: 'Card' },
];

export default function Subscriptions() {
  const { currency, setCurrency } = useCurrency();
  const [currencyCode, setCurrencyCode] = useState(currency.code);
  const [tiers, setTiers] = useState([]);
  const [codes, setCodes] = useState([]);
  const [intendedTier, setIntendedTier] = useState('');
  const [expiresInDays, setExpiresInDays] = useState(30);
  const [tierEdit, setTierEdit] = useState(null); // { tier, label, maxProducts, maxUsers }
  const [settings, setSettings] = useState(null);
  const [toast, showToast] = useToast();

  const load = () => {
    api.get('/super/tiers').then((r) => setTiers(r.data));
    api.get('/super/access-codes').then((r) => setCodes(r.data));
    api.get('/settings/payment-instructions').then((r) => setSettings(r.data));
  };
  useEffect(() => { load(); }, []);
  useEffect(() => { setCurrencyCode(currency.code); }, [currency.code]);

  const saveCurrency = async () => {
    const picked = CURRENCIES.find((c) => c.code === currencyCode);
    try {
      const r = await api.patch('/super/currency', { code: picked.code, symbol: picked.symbol });
      setCurrency(r.data); // updates every page using useCurrency() immediately, app-wide
      showToast('Currency updated', 'success');
    } catch (err) {
      showToast(err.response?.data?.error || 'Failed to update currency', 'error');
    }
  };

  const toggleMethod = (value) => {
    setSettings((s) => {
      const methods = s.methods.includes(value) ? s.methods.filter((m) => m !== value) : [...s.methods, value];
      return { ...s, methods };
    });
  };

  const saveSettings = async () => {
    await api.patch('/super/payment-settings', {
      accountNumber: settings.account_number,
      accountName: settings.account_name,
      bankOrProvider: settings.bank_or_provider,
      methods: settings.methods,
      instructions: settings.instructions,
      gatewayProvider: settings.gateway_provider,
      gatewayEnabled: settings.gateway_enabled,
    });
    showToast('Payment settings saved', 'success');
    load();
  };

  const generate = async () => {
    try {
      await api.post('/super/access-codes', { ...(intendedTier ? { intendedTier } : {}), expiresInDays: Number(expiresInDays) });
      showToast('Access code generated', 'success');
      load();
    } catch (err) {
      showToast(err.response?.data?.error || 'Failed to generate code', 'error');
    }
  };

  const saveTier = async () => {
    try {
      await api.put(`/super/tiers/${tierEdit.tier}`, {
        label: tierEdit.label, maxProducts: tierEdit.maxProducts, maxUsers: tierEdit.maxUsers,
      });
      showToast('Tier limits saved — they apply to every store on this tier', 'success');
      setTierEdit(null);
      load();
    } catch (err) {
      showToast(err.response?.data?.error || 'Failed to save tier', 'error');
    }
  };

  const revoke = async (id) => {
    await api.patch(`/super/access-codes/${id}/revoke`);
    load();
  };

  return (
    <div>
      <div className="topbar"><h1>💳 Store Tiers & Access Codes</h1></div>

      <div className="card">
        <h3 style={{ marginBottom: 12 }}>Currency</h3>
        <p className="muted mt-1">Applies across the whole app — store screens, receipts, and the public storefront. Switching currency only changes the symbol/code shown going forward; it doesn't convert historical amounts.</p>
        <div className="flex mt-1">
          <select value={currencyCode} onChange={(e) => setCurrencyCode(e.target.value)} style={{ maxWidth: 260 }}>
            {CURRENCIES.map((c) => <option key={c.code} value={c.code}>{c.name} ({c.symbol})</option>)}
          </select>
          <button className="btn" onClick={saveCurrency}>Save Currency</button>
        </div>
      </div>

      {settings && (
        <div className="card">
          <h3 style={{ marginBottom: 12 }}>Payment Collection Settings</h3>
          <p className="muted mt-1">Shown to every store admin on their Billing screen.</p>
          <div className="grid grid-2 mt-1">
            <div className="form-group">
              <label>Bank / Provider</label>
              <input value={settings.bank_or_provider || ''} onChange={(e) => setSettings({ ...settings, bank_or_provider: e.target.value })} placeholder="e.g. OPAY" />
            </div>
            <div className="form-group">
              <label>Account Number</label>
              <input value={settings.account_number || ''} onChange={(e) => setSettings({ ...settings, account_number: e.target.value })} placeholder="e.g. 8032540215" />
            </div>
            <div className="form-group">
              <label>Account Name</label>
              <input value={settings.account_name || ''} onChange={(e) => setSettings({ ...settings, account_name: e.target.value })} />
            </div>
          </div>
          <div className="form-group">
            <label>Accepted Methods</label>
            <div className="flex">
              {ALL_METHODS.map((m) => (
                <label key={m.value} className="flex" style={{ alignItems: 'center', gap: 6 }}>
                  <input type="checkbox" checked={settings.methods.includes(m.value)} onChange={() => toggleMethod(m.value)} />
                  {m.label}
                </label>
              ))}
            </div>
          </div>
          <div className="form-group">
            <label>Instructions shown to store admins</label>
            <textarea value={settings.instructions || ''} onChange={(e) => setSettings({ ...settings, instructions: e.target.value })} rows={3} />
          </div>
          <button className="btn" onClick={saveSettings}>Save Payment Settings</button>
        </div>
      )}

      {settings && (
        <div className="card">
          <h3 style={{ marginBottom: 12 }}>
            Payment Gateway {settings.gateway_provider === 'paystack'
              ? <span className="badge active">Paystack Live</span>
              : <span className="badge pending">Coming Soon</span>}
          </h3>
          <p className="muted mt-1">
            Every store can still collect payment manually — a store admin transfers via the details above and
            marks it paid, then you confirm it landed. Paystack is the one gateway actually wired up: select it,
            turn it on below, and set <code>PAYSTACK_SECRET_KEY</code> in this server's environment (see
            .env.example) to let store admins pay online instantly instead of by hand. Flutterwave and Stripe are
            selectable here for planning purposes only — no integration code exists for them yet.
          </p>
          <div className="form-group mt-1">
            <label htmlFor="gateway-provider">Provider</label>
            <select id="gateway-provider" value={settings.gateway_provider || 'none'} onChange={(e) => setSettings({ ...settings, gateway_provider: e.target.value, gateway_enabled: e.target.value === 'paystack' ? settings.gateway_enabled : false })}>
              <option value="none">None selected</option>
              <option value="paystack">Paystack</option>
              <option value="flutterwave">Flutterwave (not yet integrated)</option>
              <option value="stripe">Stripe (not yet integrated)</option>
            </select>
          </div>
          <label className="flex" style={{ alignItems: 'center', gap: 6 }}>
            <input
              type="checkbox"
              checked={settings.gateway_provider === 'paystack' && !!settings.gateway_enabled}
              disabled={settings.gateway_provider !== 'paystack'}
              title={settings.gateway_provider !== 'paystack' ? 'Only Paystack is integrated so far' : ''}
              onChange={(e) => setSettings({ ...settings, gateway_enabled: e.target.checked })}
            />
            Enable online payment for stores
          </label>
          {settings.gateway_provider === 'paystack' && settings.gateway_key_present === false && (
            <div className="alert error mt-1" role="alert">
              Paystack's secret key isn't set on the server, so stores still can't take online payments.
              Add <code>PAYSTACK_SECRET_KEY=sk_live_…</code> (from your Paystack dashboard → Settings → API Keys)
              to the server's <code>.env</code> and restart the backend.
            </div>
          )}
          <button className="btn mt-1" onClick={saveSettings}>Save Gateway Selection</button>
        </div>
      )}

      <div className="card">
        <h3 style={{ marginBottom: 12 }}>Store Size Tiers</h3>
        <p className="muted mt-1">
          Store size (Mini/Midi/Mega) and billing (daily % or custom) are assigned per store
          from Manage Stores — these limits apply automatically based on the tier assigned.
          Leave a limit blank for unlimited.
        </p>
        <table>
          <thead><tr><th>Tier</th><th>Max Products</th><th>Max Users</th><th></th></tr></thead>
          <tbody>
            {tiers.map((t) => (tierEdit?.tier === t.tier ? (
              <tr key={t.tier}>
                <td><input value={tierEdit.label} onChange={(e) => setTierEdit({ ...tierEdit, label: e.target.value })} aria-label="Tier name" /></td>
                <td><input type="number" min="1" placeholder="Unlimited" value={tierEdit.maxProducts}
                  onChange={(e) => setTierEdit({ ...tierEdit, maxProducts: e.target.value })} aria-label="Max products" /></td>
                <td><input type="number" min="1" placeholder="Unlimited" value={tierEdit.maxUsers}
                  onChange={(e) => setTierEdit({ ...tierEdit, maxUsers: e.target.value })} aria-label="Max users" /></td>
                <td className="flex" style={{ gap: 6 }}>
                  <button className="btn small" onClick={saveTier}>Save</button>
                  <button className="btn small secondary" onClick={() => setTierEdit(null)}>Cancel</button>
                </td>
              </tr>
            ) : (
              <tr key={t.tier}>
                <td>{t.label}</td>
                <td>{t.max_products ?? 'Unlimited'}</td>
                <td>{t.max_users ?? 'Unlimited'}</td>
                <td>
                  <button className="btn small secondary" onClick={() => setTierEdit({
                    tier: t.tier, label: t.label, maxProducts: t.max_products ?? '', maxUsers: t.max_users ?? '',
                  })}>Edit</button>
                </td>
              </tr>
            )))}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h3 style={{ marginBottom: 12 }}>Generate Access Code</h3>
        <p className="muted">Optionally pre-assign the tier this code activates a store into — otherwise it's set when you activate the store directly.</p>
        <div className="flex mt-1">
          <select value={intendedTier} onChange={(e) => setIntendedTier(e.target.value)} style={{ maxWidth: 220 }}>
            <option value="">No pre-assigned tier</option>
            <option value="mini">Mini Store</option>
            <option value="midi">Midi Store</option>
            <option value="mega">Mega Store</option>
          </select>
          <label style={{ margin: 0 }}>Valid for</label>
          <input type="number" min="1" max="365" value={expiresInDays} onChange={(e) => setExpiresInDays(e.target.value)}
            style={{ width: 80 }} aria-label="Days until the code expires" />
          <span className="muted">days</span>
          <button className="btn" onClick={generate}>Generate Code</button>
        </div>
      </div>

      <div className="card">
        <h3 style={{ marginBottom: 12 }}>All Access Codes</h3>
        <table>
          <thead><tr><th>Code</th><th>Intended Tier</th><th>Status</th><th>Store</th><th>Expires</th><th></th></tr></thead>
          <tbody>
            {codes.map((c) => (
              <tr key={c.id}>
                <td><span className="code-chip">{c.code}</span></td><td>{c.intended_tier || '—'}</td>
                <td><Badge status={c.status} /></td><td>{c.store_name || '—'}</td>
                <td>{new Date(c.expires_at).toLocaleDateString()}</td>
                <td>{c.status === 'active' && <button className="btn danger small" onClick={() => revoke(c.id)}>Revoke</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Toast {...(toast || {})} />
    </div>
  );
}
