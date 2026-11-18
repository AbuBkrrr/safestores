import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

// Built-in help: short, task-focused answers with a link to the screen.
// Topics are keyed into the help.* translation namespace.
const TOPICS = [
  { key: 'firstSteps', to: '/' },
  { key: 'importProducts', to: '/products/import' },
  { key: 'receiveStock', to: '/stock-arrival' },
  { key: 'moveToShelf', to: '/movements' },
  { key: 'sell', to: '/checkout' },
  { key: 'shift', to: '/checkout' },
  { key: 'discount', to: '/checkout' },
  { key: 'splitPay', to: '/checkout' },
  { key: 'refund', to: '/sales' },
  { key: 'receipts', to: '/sales' },
  { key: 'thermal', to: '/checkout' },
  { key: 'labels', to: '/labels' },
  { key: 'credit', to: '/customers' },
  { key: 'loyalty', to: '/settings' },
  { key: 'tax', to: '/settings' },
  { key: 'staff', to: '/invites' },
  { key: 'offline', to: '/' },
  { key: 'endOfDay', to: '/daily-report' },
  { key: 'insights', to: '/insights' },
  { key: 'reorder', to: '/replenishment' },
  { key: 'security', to: '/account' },
  { key: 'export', to: '/export' },
  { key: 'settlements', to: '/settlements' },
  { key: 'support', to: '/support' },
];

export default function Help() {
  const { t } = useTranslation();
  const [q, setQ] = useState('');
  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    return TOPICS.filter((x) => !s || `${t(`help.${x.key}.q`)} ${t(`help.${x.key}.a`)}`.toLowerCase().includes(s));
  }, [q, t]);

  return (
    <div>
      <div className="topbar"><div><h1>{t('help.title')}</h1><p className="muted">{t('help.subtitle')}</p></div></div>
      <div className="card">
        <input aria-label={t('common.search')} placeholder={t('help.searchPlaceholder')} value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 420 }} />
      </div>
      <div className="card">
        {list.length === 0 && <p className="muted">{t('help.noMatch')} <Link to="/support">{t('help.askSupport')}</Link></p>}
        {list.map((x) => (
          <details key={x.key} className="help-item">
            <summary>{t(`help.${x.key}.q`)}</summary>
            <p>{t(`help.${x.key}.a`)}</p>
            <Link to={x.to}>{t('help.goThere')} →</Link>
          </details>
        ))}
      </div>
      <div className="card">
        <h3>⌨️ {t('help.shortcutsTitle')}</h3>
        <p className="muted">{t('checkout.shortcutsHint')}</p>
      </div>
    </div>
  );
}
