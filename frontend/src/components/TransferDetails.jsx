import { useTranslation } from 'react-i18next';

/** The store's bank account, shown to a shopper who chose to pay by transfer. */
export default function TransferDetails({ transfer, amount, reference }) {
  const { t } = useTranslation();
  if (!transfer?.accountNumber) return null;
  const copy = () => navigator.clipboard?.writeText(transfer.accountNumber);
  return (
    <div className="alert info mt-1" style={{ textAlign: 'left' }}>
      <strong>🏦 {t('storefrontPage.transferTitle', { amount })}</strong>
      <div className="mt-1">{transfer.bankName}</div>
      <div style={{ fontSize: 20, fontWeight: 700, letterSpacing: 1 }}>
        {transfer.accountNumber} <button type="button" className="btn secondary small" onClick={copy}>{t('storefrontPage.copy')}</button>
      </div>
      <div>{transfer.accountName}</div>
      {reference && <div className="small mt-1">{t('storefrontPage.transferRef', { ref: reference })}</div>}
      {transfer.note && <div className="small muted mt-1">{transfer.note}</div>}
    </div>
  );
}
