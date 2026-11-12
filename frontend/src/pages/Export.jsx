import { useTranslation } from 'react-i18next';
import { useAuth } from '../context/AuthContext.jsx';
import api from '../api/client.js';
import { Alert } from '../components/ui.jsx';

function download(url, filename) {
  api.get(url, { responseType: 'blob' }).then((res) => {
    const blobUrl = window.URL.createObjectURL(new Blob([res.data]));
    const link = document.createElement('a');
    link.href = blobUrl; link.setAttribute('download', filename);
    document.body.appendChild(link); link.click(); link.remove();
  });
}

export default function Export() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const base = `/stores/${user.storeId}/export`;

  if (user.role !== 'admin') {
    return (
      <div>
        <div className="topbar"><h1>{t('exportPage.title')}</h1></div>
        <Alert type="error">{t('exportPage.adminOnly')}</Alert>
      </div>
    );
  }

  return (
    <div>
      <div className="topbar"><h1>{t('exportPage.title')}</h1></div>

      <div className="grid grid-2">
        <div className="card">
          <h3 style={{ marginBottom: 12 }}>{t('exportPage.csvExports')}</h3>
          <div className="flex" style={{ flexWrap: 'wrap' }}>
            <button className="btn secondary" onClick={() => download(`${base}/csv?type=products`, 'products.csv')}>{t('exportPage.productsCsv')}</button>
            <button className="btn secondary" onClick={() => download(`${base}/csv?type=movements`, 'movements.csv')}>{t('exportPage.movementsCsv')}</button>
            <button className="btn secondary" onClick={() => download(`${base}/csv?type=audits`, 'audits.csv')}>{t('exportPage.auditsCsv')}</button>
            <button className="btn" onClick={() => download(`${base}/csv?type=full`, 'full-export.csv')}>{t('exportPage.fullExportCsv')}</button>
          </div>
        </div>

        <div className="card">
          <h3 style={{ marginBottom: 12 }}>{t('exportPage.jsonBackup')}</h3>
          <p className="muted mt-1">{t('exportPage.jsonBackupDesc')}</p>
          <button className="btn mt-1" onClick={() => download(`${base}/json`, 'safestores-backup.json')}>{t('exportPage.downloadJsonBackup')}</button>
        </div>
      </div>
    </div>
  );
}
