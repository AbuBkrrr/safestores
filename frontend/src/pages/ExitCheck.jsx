import { useEffect, useRef, useState } from 'react';
import { BrowserMultiFormatReader } from '@zxing/browser';
import { useTranslation } from 'react-i18next';
import api from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useCurrency } from '../context/CurrencyContext.jsx';
import FullCamera from '../components/FullCamera.jsx';

// Security post. Exit: scan the receipt, tick every item against the goods
// going out, then let out (or report a mismatch to the manager).
// Return: scan the receipt, record what physically came back, so the cashier
// can refund it. Each receipt passes the exit once.
export default function ExitCheck() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const { formatCurrency } = useCurrency();
  const [mode, setMode] = useState('exit'); // exit | return
  const [code, setCode] = useState('');
  const [receipt, setReceipt] = useState(null);
  const [verdict, setVerdict] = useState(null); // { tone: ok|warn|bad, text }
  const [ticked, setTicked] = useState({});
  const [back, setBack] = useState({});
  const [note, setNote] = useState('');
  const [mismatch, setMismatch] = useState(false);
  const [camera, setCamera] = useState(false);
  const [busy, setBusy] = useState(false);
  const videoRef = useRef(null);
  const inputRef = useRef(null);
  const base = `/stores/${user.storeId}/exit-check`;

  const reset = () => {
    setReceipt(null); setVerdict(null); setCode(''); setTicked({}); setBack({}); setNote(''); setMismatch(false);
    setTimeout(() => inputRef.current?.focus(), 50);
  };
  const switchMode = (m) => { setMode(m); reset(); };

  const check = async (raw) => {
    const c = String(raw || '').trim();
    if (!c) return;
    setBusy(true); setVerdict(null); setReceipt(null); setTicked({}); setBack({}); setMismatch(false); setNote('');
    try {
      const { data } = await api.get(base, { params: { code: c } });
      setReceipt(data);
      if (data.status !== 'paid') setVerdict({ tone: 'bad', text: t('exitCheck.notPaid') });
      else if (mode === 'return') setVerdict({ tone: 'ok', text: t('exitCheck.returnFound') });
      else if (data.exit_checked_at) setVerdict({ tone: 'warn', text: t('exitCheck.alreadyUsed', { time: new Date(data.exit_checked_at).toLocaleTimeString(), name: data.checked_by_name || '—' }) });
      else if (Number(data.refunded_total) > 0) setVerdict({ tone: 'warn', text: t('exitCheck.partlyRefunded', { amount: formatCurrency(data.refunded_total) }) });
      else setVerdict({ tone: 'ok', text: t('exitCheck.paid') });
    } catch (err) {
      setVerdict({ tone: 'bad', text: err.response?.data?.error || t('exitCheck.notFound') });
    } finally { setBusy(false); }
  };

  const finishExit = async (result) => {
    setBusy(true);
    try {
      await api.post(`${base}/${receipt.id}`, { result, note: result === 'mismatch' ? note : undefined });
      setVerdict(result === 'mismatch' ? { tone: 'warn', text: t('exitCheck.mismatchSent') } : { tone: 'ok', text: t('exitCheck.letOut') });
      setTimeout(reset, result === 'mismatch' ? 3000 : 1500);
    } catch (err) {
      setVerdict({ tone: 'bad', text: err.response?.data?.error || t('exitCheck.notFound') });
    } finally { setBusy(false); }
  };

  const confirmReturn = async () => {
    const items = Object.entries(back).map(([orderItemId, q]) => ({ orderItemId, quantity: parseInt(q, 10) || 0 })).filter((i) => i.quantity > 0);
    setBusy(true);
    try {
      await api.post(`${base}/${receipt.id}/returns`, { items, note });
      setVerdict({ tone: 'ok', text: t('exitCheck.returnSaved') });
      setTimeout(reset, 2500);
    } catch (err) {
      setVerdict({ tone: 'bad', text: err.response?.data?.error || t('exitCheck.notFound') });
    } finally { setBusy(false); }
  };

  useEffect(() => {
    if (!camera || !videoRef.current) return undefined;
    let stream; let done = false; let controls;
    const reader = new BrowserMultiFormatReader();
    navigator.mediaDevices?.getUserMedia({ video: { facingMode: 'environment' } }).then((s) => {
      stream = s;
      if (!videoRef.current) return;
      videoRef.current.srcObject = s;
      controls = reader.decodeFromVideoElement(videoRef.current, (result) => {
        if (!result || done) return;
        done = true; setCamera(false); setCode(result.getText()); check(result.getText());
      }).catch(() => {});
    }).catch(() => { setCamera(false); setVerdict({ tone: 'bad', text: t('exitCheck.cameraError') }); });
    return () => { Promise.resolve(controls).then((c) => c?.stop()).catch(() => {}); stream?.getTracks().forEach((tr) => tr.stop()); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camera]);

  const tones = { ok: 'success', warn: 'warning', bad: 'error' };
  const items = receipt?.items || [];
  const allTicked = items.length > 0 && items.every((i) => ticked[i.id]);
  const canExit = receipt?.status === 'paid' && !receipt.exit_checked_at && mode === 'exit';
  const canReturn = receipt?.status === 'paid' && mode === 'return';
  const anyBack = Object.values(back).some((q) => parseInt(q, 10) > 0);

  return (
    <div>
      <div className="topbar"><div className="page-title"><h1>🛡️ {t('exitCheck.title')}</h1><div className="sub">{mode === 'exit' ? t('exitCheck.sub') : t('exitCheck.subReturn')}</div></div></div>
      <div className="flex" role="tablist" style={{ gap: 8, marginBottom: 12 }}>
        <button type="button" role="tab" aria-selected={mode === 'exit'} className={`btn ${mode === 'exit' ? '' : 'secondary'}`} onClick={() => switchMode('exit')}>🚪 {t('exitCheck.modeExit')}</button>
        <button type="button" role="tab" aria-selected={mode === 'return'} className={`btn ${mode === 'return' ? '' : 'secondary'}`} onClick={() => switchMode('return')}>↩️ {t('exitCheck.modeReturn')}</button>
      </div>
      <div className="card">
        <div className="flex" style={{ gap: 8, flexWrap: 'wrap' }}>
          <button type="button" className={`btn ${camera ? 'secondary' : ''}`} onClick={() => setCamera((c) => !c)}>{camera ? t('exitCheck.stopCamera') : `📷 ${t('exitCheck.scan')}`}</button>
          <form onSubmit={(e) => { e.preventDefault(); check(code); }} className="flex" style={{ gap: 8, flex: 1, minWidth: 220 }}>
            <input ref={inputRef} id="exit-code" autoFocus aria-label={t('exitCheck.typeCode')} placeholder={t('exitCheck.typeCode')} value={code} onChange={(e) => setCode(e.target.value)} style={{ flex: 1 }} />
            <button className="btn secondary" disabled={busy || !code.trim()}>{t('exitCheck.check')}</button>
          </form>
        </div>
        {camera && <FullCamera onClose={() => setCamera(false)}><video ref={videoRef} autoPlay playsInline muted /><div className="camera-guide" /></FullCamera>}
      </div>

      {verdict && (
        <div className={`alert ${tones[verdict.tone]}`} role="status" style={{ fontSize: 20, fontWeight: 700, textAlign: 'center', padding: 18 }}>
          {verdict.tone === 'ok' ? '✅' : verdict.tone === 'warn' ? '⚠️' : '⛔'} {verdict.text}
        </div>
      )}

      {receipt && (
        <div className="card">
          <div className="flex" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
            <strong>{receipt.receipt_number}</strong>
            <span className="muted">{receipt.paid_at ? new Date(receipt.paid_at).toLocaleString() : '—'} · {t('exitCheck.cashier')}: {receipt.cashier_name || '—'}</span>
          </div>
          {canExit && <p className="muted" style={{ margin: '8px 0 0' }}>{t('exitCheck.tickHelp')}</p>}
          {canReturn && <p className="muted" style={{ margin: '8px 0 0' }}>{t('exitCheck.returnHelp')}</p>}
          <div style={{ overflowX: 'auto' }}>
            <table className="mt-1">
              <thead><tr>
                <th>{t('exitCheck.item')}</th><th style={{ textAlign: 'right' }}>{t('exitCheck.qty')}</th>
                {canExit && <th style={{ textAlign: 'center' }}>{t('exitCheck.seen')}</th>}
                {canReturn && <><th style={{ textAlign: 'right' }}>{t('exitCheck.alreadyBack')}</th><th>{t('exitCheck.backNow')}</th></>}
              </tr></thead>
              <tbody>{items.map((i) => {
                const left = i.quantity - i.returned_qty;
                return (
                  <tr key={i.id} style={canExit && ticked[i.id] ? { background: 'var(--online-bg)' } : undefined}>
                    <td>{i.name}</td>
                    <td style={{ textAlign: 'right', fontWeight: 700, fontSize: 20 }}>{i.quantity}</td>
                    {canExit && (
                      <td style={{ textAlign: 'center' }}>
                        <input type="checkbox" aria-label={t('exitCheck.seenItem', { name: i.name })} checked={!!ticked[i.id]} onChange={(e) => setTicked({ ...ticked, [i.id]: e.target.checked })} style={{ width: 26, height: 26 }} />
                      </td>
                    )}
                    {canReturn && <>
                      <td style={{ textAlign: 'right' }}>{i.returned_qty}</td>
                      <td><input type="number" min="0" max={left} disabled={left <= 0} aria-label={t('exitCheck.backNowItem', { name: i.name })} value={back[i.id] ?? ''} placeholder="0" onChange={(e) => setBack({ ...back, [i.id]: e.target.value })} style={{ width: 80 }} /></td>
                    </>}
                  </tr>
                );
              })}</tbody>
            </table>
          </div>
          <p className="mt-1"><strong>{t('exitCheck.total')}: {formatCurrency(receipt.total)}</strong> · {receipt.payment_method || '—'}</p>

          {canExit && !mismatch && (
            <div className="flex mt-1" style={{ gap: 8, flexWrap: 'wrap' }}>
              <button className="btn" disabled={busy || !allTicked} onClick={() => finishExit('passed')}>✅ {t('exitCheck.confirmLetOut')}</button>
              <button className="btn secondary" disabled={busy} onClick={() => setMismatch(true)}>⚠️ {t('exitCheck.reportMismatch')}</button>
              <button className="btn secondary" onClick={reset}>{t('exitCheck.next')}</button>
            </div>
          )}
          {canExit && mismatch && (
            <div className="mt-1">
              <div className="form-group"><label htmlFor="mm-note">{t('exitCheck.whatDiffers')}</label>
                <textarea id="mm-note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder={t('exitCheck.mismatchPh')} /></div>
              <div className="flex" style={{ gap: 8 }}>
                <button className="btn danger" disabled={busy || !note.trim()} onClick={() => finishExit('mismatch')}>{t('exitCheck.sendMismatch')}</button>
                <button className="btn secondary" onClick={() => setMismatch(false)}>{t('common.cancel', { defaultValue: 'Cancel' })}</button>
              </div>
            </div>
          )}
          {canReturn && (
            <div className="mt-1">
              <div className="form-group"><label htmlFor="ret-note">{t('exitCheck.returnNote')}</label>
                <input id="ret-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder={t('exitCheck.returnNotePh')} /></div>
              <div className="flex" style={{ gap: 8 }}>
                <button className="btn" disabled={busy || !anyBack} onClick={confirmReturn}>↩️ {t('exitCheck.confirmReturn')}</button>
                <button className="btn secondary" onClick={reset}>{t('exitCheck.next')}</button>
              </div>
            </div>
          )}
          {!canExit && !canReturn && <button className="btn secondary mt-1" onClick={reset}>{t('exitCheck.next')}</button>}
        </div>
      )}
    </div>
  );
}
