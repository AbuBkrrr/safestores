import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import api from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useCurrency } from '../context/CurrencyContext.jsx';
import { Toast } from '../components/ui.jsx';
import { useToast } from '../components/useToast.js';

export default function Reports() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const { formatCurrency } = useCurrency();
  const [summary, setSummary] = useState(null);
  const [products, setProducts] = useState([]);
  const [sending, setSending] = useState(false);
  const [toast, showToast] = useToast();

  useEffect(() => {
    api.get(`/stores/${user.storeId}/analytics/summary`).then((r) => setSummary(r.data));
    api.get(`/stores/${user.storeId}/products`).then((r) => setProducts(r.data));
  }, [user.storeId]);

  const openMailtoFallback = () => {
    const body = `${t('reportsPage.emailSubject')} — ${new Date().toLocaleDateString()}\n\n` +
      `${t('reportsPage.totalProductsLine')}: ${summary?.totalProducts}\n` +
      `${t('reportsPage.totalStockValueLine')}: ${formatCurrency(summary?.totalStockValue || 0)}\n` +
      `${t('reportsPage.lowStockItemsLine')}: ${summary?.lowStockCount}\n`;
    window.location.href = `mailto:?subject=${encodeURIComponent(t('reportsPage.emailSubject'))}&body=${encodeURIComponent(body)}`;
  };

  // Admin/manager get a real, server-sent email (CSV attached, via
  // whatever SMTP the store has configured — see backend's
  // exportController.emailReport). Everyone else, and any environment
  // where that endpoint isn't there or isn't configured (currently true
  // for every desktop install, which has no SMTP capability at all),
  // falls back to the mailto: link that just opens the user's own mail
  // app — the original behavior, not an error state.
  const emailReport = async () => {
    if (user.role !== 'admin' && user.role !== 'manager') { openMailtoFallback(); return; }
    setSending(true);
    try {
      const { data } = await api.post(`/stores/${user.storeId}/reports/email`, {});
      showToast(t('reportsPage.emailedTo', { email: data.to }), 'success');
    } catch (err) {
      openMailtoFallback();
    } finally {
      setSending(false);
    }
  };

  return (
    <div>
      <div className="topbar">
        <h1>{t('reportsPage.title')}</h1>
        <div className="flex">
          <button className="btn secondary" onClick={() => window.print()}>{t('reportsPage.printReport')}</button>
          <button className="btn" onClick={emailReport} disabled={sending}>{sending ? t('reportsPage.sending') : t('reportsPage.emailReport')}</button>
        </div>
      </div>

      <div className="grid grid-4">
        <div className="card metric"><div className="value">{summary?.totalProducts ?? '—'}</div><div className="label">{t('reportsPage.products')}</div></div>
        <div className="card metric"><div className="value">{formatCurrency(summary?.totalStockValue || 0)}</div><div className="label">{t('reportsPage.stockValue')}</div></div>
        <div className="card metric"><div className="value">{summary?.lowStockCount ?? '—'}</div><div className="label">{t('reportsPage.lowStock')}</div></div>
        <div className="card metric"><div className="value">{products.reduce((s, p) => s + p.sold_qty, 0)}</div><div className="label">{t('reportsPage.totalUnitsSold')}</div></div>
      </div>

      <div className="card">
        <h3 style={{ marginBottom: 12 }}>{t('reportsPage.fullInventorySnapshot')}</h3>
        <table>
          <thead><tr><th>{t('reportsPage.product')}</th><th>{t('cameraPage.sku')}</th><th>{t('cameraPage.backroom')}</th><th>{t('cameraPage.shelf')}</th><th>{t('reportsPage.sold')}</th><th>{t('reportsPage.damaged')}</th><th>{t('reportsPage.stockValue')}</th></tr></thead>
          <tbody>
            {products.map((p) => (
              <tr key={p.id}>
                <td>{p.name}</td><td>{p.sku}</td><td>{p.backroom_qty}</td><td>{p.shelf_qty}</td>
                <td>{p.sold_qty}</td><td>{p.damaged_qty}</td><td>{formatCurrency(p.stock_value)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Toast {...(toast || {})} />
    </div>
  );
}
