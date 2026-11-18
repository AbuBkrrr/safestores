import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import api from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import { Alert } from '../components/ui.jsx';

const TEMPLATE = 'Name,SKU,Barcode,Category,Brand,Supplier,Unit,Cost Price,Selling Price,Stock,Reorder Level,Units per carton\n'
  + 'Peak Milk 400g,PK400,6151234567890,Dairy,Peak,FrieslandCampina,tin,1200,1500,24,6,12\n';

async function parseFile(file) {
  const name = file.name.toLowerCase();
  if (name.endsWith('.xlsx')) {
    const { default: readXlsx } = await import('read-excel-file');
    const sheet = await readXlsx(file);
    const [header, ...body] = sheet;
    return body.filter((r) => r.some((c) => c !== null && c !== '')).map((r) => Object.fromEntries(header.map((h, i) => [String(h ?? ''), r[i] ?? ''])));
  }
  const Papa = (await import('papaparse')).default;
  const text = await file.text();
  const out = Papa.parse(text, { header: true, skipEmptyLines: 'greedy' });
  return out.data;
}

/** Bring a whole product list in from a spreadsheet (CSV or Excel .xlsx). */
export default function ImportProducts() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const [rows, setRows] = useState(null);
  const [fileName, setFileName] = useState('');
  const [check, setCheck] = useState(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const onFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(''); setCheck(null); setResult(null); setFileName(file.name);
    try {
      const parsed = await parseFile(file);
      if (!parsed.length) throw new Error(t('importPage.emptyFile'));
      setRows(parsed);
      setBusy(true);
      const { data } = await api.post(`/stores/${user.storeId}/products/import`, { rows: parsed, dryRun: true });
      setCheck(data);
    } catch (err) {
      setError(err.response?.data?.error || err.message || t('common.errorGeneric'));
    } finally { setBusy(false); }
  };

  const doImport = async () => {
    setBusy(true); setError('');
    try {
      const { data } = await api.post(`/stores/${user.storeId}/products/import`, { rows });
      setResult(data); setCheck(null);
    } catch (err) {
      setError(err.response?.data?.error || t('common.errorGeneric'));
    } finally { setBusy(false); }
  };

  const downloadTemplate = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([TEMPLATE], { type: 'text/csv' }));
    a.download = 'safestores-products-template.csv';
    document.body.appendChild(a); a.click(); a.remove();
  };

  const headers = rows?.length ? Object.keys(rows[0]) : [];

  return (
    <div>
      <div className="topbar"><div><h1>{t('importPage.title')}</h1><p className="muted">{t('importPage.subtitle')}</p></div><Link className="btn secondary small" to="/products">← {t('nav.products')}</Link></div>
      <Alert type="error">{error}</Alert>
      <div className="card">
        <ol className="muted" style={{ paddingLeft: 18, lineHeight: 1.7 }}>
          <li>{t('importPage.step1')} <button className="btn small secondary" onClick={downloadTemplate}>{t('importPage.template')}</button></li>
          <li>{t('importPage.step2')}</li>
          <li>{t('importPage.step3')}</li>
        </ol>
        <div className="form-group mt-1">
          <label htmlFor="import-file">{t('importPage.chooseFile')}</label>
          <input id="import-file" type="file" accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={onFile} />
          {fileName && <span className="help-text">{fileName} · {t('importPage.rowsFound', { count: rows?.length || 0 })}</span>}
        </div>
        {busy && <p className="muted">{t('common.loading')}</p>}
      </div>

      {check && (
        <div className="card">
          <h3>{t('importPage.checkTitle')}</h3>
          <p>{t('importPage.willCreate', { count: check.create })} · {t('importPage.willUpdate', { count: check.update })} · {t('importPage.skipped', { count: check.errors.length })}</p>
          {check.errors.length > 0 && (
            <div className="table-wrap" style={{ maxHeight: 200, overflowY: 'auto' }}>
              <table><thead><tr><th>{t('importPage.row')}</th><th>{t('importPage.problem')}</th></tr></thead>
                <tbody>{check.errors.map((e) => <tr key={e.row}><td>{e.row}</td><td>{e.error}</td></tr>)}</tbody></table>
            </div>
          )}
          <h4 className="mt-1">{t('importPage.preview')}</h4>
          <div className="table-wrap" style={{ maxHeight: 260, overflowY: 'auto' }}>
            <table><thead><tr>{headers.map((h) => <th key={h}>{h}</th>)}</tr></thead>
              <tbody>{rows.slice(0, 20).map((r, i) => <tr key={i}>{headers.map((h) => <td key={h}>{String(r[h] ?? '')}</td>)}</tr>)}</tbody></table>
          </div>
          <button className="btn mt-1" disabled={busy || check.create + check.update === 0} onClick={doImport}>{t('importPage.importNow', { count: check.create + check.update })}</button>
        </div>
      )}

      {result && (
        <Alert type="success">{t('importPage.done', { created: result.created, updated: result.updated })} <Link to="/products">{t('importPage.viewProducts')}</Link></Alert>
      )}
    </div>
  );
}
