import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import api from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import { Modal, EmptyState, Toast } from '../components/ui.jsx';
import { useToast } from '../components/useToast.js';
import { useCurrency } from '../context/CurrencyContext.jsx';

const emptyForm = { name: '', phone: '', notes: '' };

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

  const load = () => {
    const q = search ? `?search=${encodeURIComponent(search)}` : '';
    api.get(`/stores/${user.storeId}/customers${q}`)
      .then((r) => setCustomers(r.data))
      .catch(() => setError(t('customersPage.loadError')));
  };
  useEffect(() => { load(); }, [user.storeId, search]);

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
