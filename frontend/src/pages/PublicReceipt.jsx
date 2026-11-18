import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import api from '../api/client.js';
import ReceiptView from '../components/ReceiptView.jsx';
import { BrandFooter } from '../components/ui.jsx';
import { printReceipt } from '../utils/receipt.js';

/** The page behind the QR code / link on a receipt — no login needed. */
export default function PublicReceipt() {
  const { t } = useTranslation();
  const { token } = useParams();
  const [r, setR] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get(`/public/receipts/${encodeURIComponent(token)}`)
      .then((res) => setR({ ...res.data, public_token: token }))
      .catch(() => setError(t('receipt.notFound')));
  }, [token]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="auth-screen">
      <div style={{ width: '100%', maxWidth: 520 }}>
        {error && <div className="card"><p>{error}</p></div>}
        {r && (
          <>
            <ReceiptView receipt={r} publicView />
            <div className="flex mt-1" style={{ justifyContent: 'center' }}>
              <button className="btn secondary small" onClick={() => printReceipt(r, { width: 'A4' })}>📄 {t('receipt.pdf')}</button>
            </div>
          </>
        )}
        <BrandFooter />
      </div>
    </div>
  );
}
