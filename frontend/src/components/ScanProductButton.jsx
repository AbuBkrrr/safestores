import { useEffect, useRef, useState } from 'react';
import { BrowserMultiFormatReader } from '@zxing/browser';
import { useTranslation } from 'react-i18next';
import api from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import FullCamera from './FullCamera.jsx';

// Camera barcode/QR scan (or a USB scanner typing into the box) that picks a
// product from `products`. Calls onFound(product) on a match.
export default function ScanProductButton({ products, onFound, onNotFound }) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [msg, setMsg] = useState('');
  const [typed, setTyped] = useState('');
  const videoRef = useRef(null);

  const match = async (code) => {
    const c = String(code).trim();
    if (!c) return false;
    let p = products.find((x) => x.barcode === c || x.sku?.toLowerCase() === c.toLowerCase());
    if (!p) {
      try {
        const { data } = await api.get(`/stores/${user.storeId}/barcode-lookup`, { params: { code: c } });
        p = products.find((x) => x.id === data?.id);
      } catch { /* no match */ }
    }
    if (p) { onFound(p); setMsg(t('scanProduct.found', { name: p.name })); setOpen(false); return true; }
    if (onNotFound) { setOpen(false); onNotFound(c); return true; }
    setMsg(t('scanProduct.notFound', { code: c }));
    return false;
  };

  useEffect(() => {
    if (!open || !videoRef.current) return undefined;
    let stream; let controls;
    let busy = false;
    const reader = new BrowserMultiFormatReader();
    navigator.mediaDevices?.getUserMedia({ video: { facingMode: 'environment' } }).then((s) => {
      stream = s;
      if (!videoRef.current) return;
      videoRef.current.srcObject = s;
      controls = reader.decodeFromVideoElement(videoRef.current, async (result) => {
        if (!result || busy) return;
        busy = true;
        await match(result.getText());
        busy = false;
      }).catch(() => {});
    }).catch(() => setMsg(t('scanProduct.cameraError')));
    return () => { Promise.resolve(controls).then((c) => c?.stop()).catch(() => {}); stream?.getTracks().forEach((tr) => tr.stop()); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return (
    <div className="scan-product">
      <div className="flex" style={{ gap: 8, flexWrap: 'wrap' }}>
        <button type="button" className={`btn small ${open ? 'secondary' : ''}`} onClick={() => { setMsg(''); setOpen((o) => !o); }}>
          {open ? t('scanProduct.stop') : `📷 ${t('scanProduct.scan')}`}
        </button>
        <input
          aria-label={t('scanProduct.typeCode')}
          placeholder={t('scanProduct.typeCode')}
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={async (e) => { if (e.key === 'Enter') { e.preventDefault(); if (await match(typed)) setTyped(''); } }}
          style={{ flex: 1, minWidth: 160 }}
        />
      </div>
      {open && <FullCamera onClose={() => setOpen(false)}><video ref={videoRef} autoPlay playsInline muted /><div className="camera-guide" /></FullCamera>}
      {msg && <p className="muted" style={{ fontSize: 12, marginTop: 4 }} role="status">{msg}</p>}
    </div>
  );
}
