import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import api from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import { Modal, EmptyState, Toast } from '../components/ui.jsx';
import { useToast } from '../components/useToast.js';
import { useCurrency } from '../context/CurrencyContext.jsx';

const emptyForm = { name: '', phone: '', notes: '', email: '', birthday: '' };

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export default function Customers() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const { formatCurrency } = useCurrency();
  const [customers, setCustomers] = useState([]);
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [detail, setDetail] = useState(null);
  const [paymentAmount, setPaymentAmount] = useState('');
  const [paymentNote, setPaymentNote] = useState('');
  const [error, setError] = useState('');
  const [toast, showToast] = useToast();
  const [points, setPoints] = useState(null);
  const [birthdays, setBirthdays] = useState([]);

  const load = () => {
    const q = search ? `?search=${encodeURIComponent(search)}` : '';
    api.get(`/stores/${user.storeId}/customers${q}`)
      .then((r) => setCustomers(r.data))
      .catch(() => setError(t('customersPage.loadError')));
  };
  useEffect(() => { load(); }, [user.storeId, search]);
  useEffect(() => {
    api.get(`/stores/${user.storeId}/customers/birthdays`, { params: { days: 7 } }).then((r) => setBirthdays(Array.isArray(r.data) ? r.data : [])).catch(() => {});
  }, [user.storeId]);

  const submitCreate = async (e) => {
    e.preventDefault(); setError('');
    try {
      await api.post(`/stores/${user.storeId}/customers`, form);
      setCreating(false); setForm(emptyForm);
      showToast(t('customersPage.addedToast'), 'success');
      load();
    } catch (err) { setError(err.response?.data?.error || t('customersPage.addError')); }
  };

  const openDetail = async (c) => {
    const res = await api.get(`/stores/${user.storeId}/customers/${c.id}`);
    setDetail(res.data);
    setPoints(null);
    api.get(`/stores/${user.storeId}/customers/${c.id}/points`).then((r) => setPoints(r.data)).catch(() => {});
  };

  // Printable/PDF account statement — running balance, oldest first.
  const printStatement = (c) => {
    const rows = [...c.ledger].reverse();
    let running = 0;
    const body = rows.map((e) => {
      running += Number(e.amount);
      return `<tr><td>${new Date(e.created_at).toLocaleDateString()}</td><td>${escapeHtml(t(`customersPage.types.${e.type}`, { defaultValue: e.type }))}</td>
        <td>${escapeHtml(e.note || '')}</td><td style="text-align:right">${Number(e.amount) > 0 ? escapeHtml(formatCurrency(e.amount)) : ''}</td>
        <td style="text-align:right">${Number(e.amount) < 0 ? escapeHtml(formatCurrency(-e.amount)) : ''}</td><td style="text-align:right">${escapeHtml(formatCurrency(running))}</td></tr>`;
    }).join('');
    const win = window.open('', '_blank');
    if (!win) return;
    win.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(t('customersPage.statement'))} — ${escapeHtml(c.name)}</title>
      <style>body{font-family:Arial,sans-serif;padding:24px;color:#111} table{width:100%;border-collapse:collapse;font-size:13px} th,td{border-bottom:1px solid #ddd;padding:6px;text-align:left} h1{font-size:20px;margin:0} .tot{font-size:18px;font-weight:700;margin-top:12px}</style>
      </head><body><h1>${escapeHtml(user.storeName || '')}</h1><p>${escapeHtml(t('customersPage.statement'))} — <strong>${escapeHtml(c.name)}</strong>${c.phone ? ` · ${escapeHtml(c.phone)}` : ''}<br>${new Date().toLocaleDateString()}</p>
      <table><thead><tr><th>${escapeHtml(t('customersPage.date'))}</th><th>${escapeHtml(t('customersPage.type'))}</th><th>${escapeHtml(t('customersPage.note'))}</th><th>${escapeHtml(t('customersPage.charges'))}</th><th>${escapeHtml(t('customersPage.payments'))}</th><th>${escapeHtml(t('customersPage.balance'))}</th></tr></thead><tbody>${body}</tbody></table>
      <p class="tot">${escapeHtml(t('customersPage.balanceOwed', { amount: formatCurrency(c.balance) }))}</p></body></html>`);
    win.document.close();
    setTimeout(() => win.print(), 200);
  };

  const birthdayWish = (c) => {
    const phone = (c.phone || '').replace(/[^0-9]/g, '');
    window.open(`https://wa.me/${phone}?text=${encodeURIComponent(t('customersPage.birthdayMessage', { name: c.name, store: user.storeName || t('customersPage.us') }))}`, '_blank');
  };

  const submitPayment = async (e) => {
    e.preventDefault(); setError('');
    try {
      await api.post(`/stores/${user.storeId}/customers/${detail.id}/payments`, { amount: Number(paymentAmount), note: paymentNote });
      setPaymentAmount(''); setPaymentNote('');
      showToast(t('customersPage.paymentRecordedToast'), 'success');
      const res = await api.get(`/stores/${user.storeId}/customers/${detail.id}`);
      setDetail(res.data);
      load();
    } catch (err) { setError(err.response?.data?.error || t('customersPage.paymentError')); }
  };

  const remindViaWhatsApp = (c) => {
    const message = t('customersPage.whatsappReminder', { name: c.name, amount: formatCurrency(c.balance), store: user.storeName || t('customersPage.us') });
    const phone = (c.phone || '').replace(/[^0-9]/g, '');
    window.open(`https://wa.me/${phone}?text=${encodeURIComponent(message)}`, '_blank');
  };

  const totalOwed = customers.reduce((sum, c) => sum + Math.max(0, Number(c.balance)), 0);

  return (
    <div>
      <div className="topbar">
        <h1>{t('customersPage.title')}</h1>
        <button className="btn" onClick={() => { setForm(emptyForm); setCreating(true); }}>{t('customersPage.addCustomer')}</button>
      </div>

      {birthdays.length > 0 && (
        <div className="card mt-1">
          <strong>🎂 {t('customersPage.birthdaysSoon')}</strong>
          {birthdays.map((b) => (
            <div key={b.id} className="flex-between" style={{ padding: '4px 0' }}>
              <span>{b.name} · {b.inDays === 0 ? t('customersPage.today') : t('customersPage.inDays', { count: b.inDays })}</span>
              {b.phone && <button className="btn small secondary" onClick={() => birthdayWish(b)}>{t('customersPage.sendWish')}</button>}
            </div>
          ))}
        </div>
      )}

      <div className="card mt-1">
        <input placeholder={t('customersPage.searchPlaceholder')} value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>

      {customers.length > 0 && (
        <div className="card mt-1">
          <strong>{t('customersPage.totalOwed', { amount: formatCurrency(totalOwed) })}</strong>
        </div>
      )}

      <div className="card mt-1">
        {customers.length === 0 ? (
          <EmptyState>{t('customersPage.noCustomersYet')}</EmptyState>
        ) : (
          <table>
            <thead><tr><th>{t('customersPage.name')}</th><th>{t('customersPage.phone')}</th><th>{t('customersPage.balance')}</th><th></th></tr></thead>
            <tbody>
              {customers.map((c) => (
                <tr key={c.id}>
                  <td><a href="#" onClick={(e) => { e.preventDefault(); openDetail(c); }}>{c.name}</a></td>
                  <td>{c.phone || '—'}</td>
                  <td style={{ color: Number(c.balance) > 0 ? 'var(--danger, #c0392b)' : undefined }}>
                    {formatCurrency(c.balance)}
                  </td>
                  <td>
                    {Number(c.balance) > 0 && c.phone && (
                      <button className="btn small secondary" onClick={() => remindViaWhatsApp(c)}>{t('customersPage.remindViaWhatsApp')}</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {creating && (
        <Modal title={t('customersPage.addCustomerTitle')} onClose={() => setCreating(false)}>
          <form onSubmit={submitCreate}>
            {error && <div className="error mb-1">{error}</div>}
            <div className="form-group">
              <label htmlFor="cust-name">{t('customersPage.name')}</label>
              <input id="cust-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
            </div>
            <div className="form-group">
              <label htmlFor="cust-phone">{t('customersPage.phone')}</label>
              <input id="cust-phone" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder={t('customersPage.phonePlaceholder')} />
            </div>
            <div className="form-group">
              <label htmlFor="cust-email">{t('customersPage.email')}</label>
              <input id="cust-email" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
            </div>
            <div className="form-group">
              <label htmlFor="cust-bday">{t('customersPage.birthday')}</label>
              <input id="cust-bday" type="date" value={form.birthday} onChange={(e) => setForm({ ...form, birthday: e.target.value })} />
            </div>
            <div className="form-group">
              <label htmlFor="cust-notes">{t('customersPage.notes')}</label>
              <input id="cust-notes" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
            </div>
            <button className="btn" type="submit">{t('customersPage.save')}</button>
          </form>
        </Modal>
      )}

      {detail && (
        <Modal title={detail.name} onClose={() => setDetail(null)}>
          <p><strong>{t('customersPage.balanceOwed', { amount: formatCurrency(detail.balance) })}</strong></p>
          {points && Number(points.settings?.points_per_100) > 0 && (
            <p className="muted">⭐ {t('customersPage.pointsBalance', { points: points.available, value: formatCurrency(points.value) })}
              {points.expiringSoon > 0 && <> · {t('customersPage.pointsExpiring', { count: points.expiringSoon })}</>}</p>
          )}
          <div className="flex">
            <button className="btn small secondary" onClick={() => printStatement(detail)}>📄 {t('customersPage.statement')}</button>
            {Number(detail.balance) > 0 && detail.phone && <button className="btn small secondary" onClick={() => remindViaWhatsApp(detail)}>{t('customersPage.remindViaWhatsApp')}</button>}
          </div>

          <form onSubmit={submitPayment} className="mt-1">
            {error && <div className="error mb-1">{error}</div>}
            <div className="form-group">
              <label htmlFor="pay-amount">{t('customersPage.recordPaymentLabel')}</label>
              <input id="pay-amount" type="number" step="0.01" min="0.01" value={paymentAmount}
                onChange={(e) => setPaymentAmount(e.target.value)} placeholder={t('customersPage.amountPlaceholder')} required />
            </div>
            <div className="form-group">
              <input value={paymentNote} onChange={(e) => setPaymentNote(e.target.value)} placeholder={t('customersPage.notePlaceholder')} />
            </div>
            <button className="btn" type="submit">{t('customersPage.recordPayment')}</button>
          </form>

          <h3 className="mt-1">{t('customersPage.history')}</h3>
          <table>
            <thead><tr><th>{t('customersPage.date')}</th><th>{t('customersPage.type')}</th><th>{t('customersPage.amount')}</th><th>{t('customersPage.note')}</th></tr></thead>
            <tbody>
              {detail.ledger.map((entry) => (
                <tr key={entry.id}>
                  <td>{new Date(entry.created_at).toLocaleDateString()}</td>
                  <td>{t(`customersPage.types.${entry.type}`, { defaultValue: entry.type.replace('_', ' ') })}</td>
                  <td>{formatCurrency(Math.abs(entry.amount))}{Number(entry.amount) < 0 ? t('customersPage.paidSuffix') : ''}</td>
                  <td>{entry.note || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Modal>
      )}

      <Toast {...toast} />
    </div>
  );
}
