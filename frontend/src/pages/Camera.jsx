import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BrowserMultiFormatReader } from '@zxing/browser';
import api from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useRealtimeEvents } from '../context/SocketContext.jsx';
import { Alert, Toast } from '../components/ui.jsx';
import { useToast } from '../components/useToast.js';

const SYNC_EVENTS = ['image:uploaded', 'image:deleted'];
const SCAN_COOLDOWN_MS = 2500; // avoid re-triggering a lookup on every frame for the same code

export default function Camera() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const videoRef = useRef();
  const canvasRef = useRef();
  const streamRef = useRef();
  const readerRef = useRef();
  const lastScanRef = useRef({ code: null, at: 0 });

  const [cameraOn, setCameraOn] = useState(false);
  const [liveScan, setLiveScan] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [gallery, setGallery] = useState([]);
  const [barcodeInput, setBarcodeInput] = useState('');
  const [lookupResult, setLookupResult] = useState(null);
  const [error, setError] = useState('');
  const [products, setProducts] = useState([]);
  const [manualSearch, setManualSearch] = useState('');
  const [manualProductId, setManualProductId] = useState('');
  const [manualQty, setManualQty] = useState('1');
  const [toast, showToast] = useToast();

  const loadGallery = () => api.get(`/stores/${user.storeId}/images`).then((r) => setGallery(r.data));
  useEffect(() => {
    loadGallery();
    api.get(`/stores/${user.storeId}/products`).then((r) => setProducts(r.data));
    return () => stopCamera();
  }, [user.storeId]);
  useRealtimeEvents(SYNC_EVENTS, () => loadGallery());

  const startCamera = async () => {
    setError('');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      streamRef.current = stream;
      videoRef.current.srcObject = stream;
      setCameraOn(true);
    } catch (err) {
      setError(t('cameraPage.cameraError'));
    }
  };

  const stopCamera = () => {
    readerRef.current?.reset();
    streamRef.current?.getTracks().forEach((t) => t.stop());
    setCameraOn(false);
    setScanning(false);
  };

  // Continuously decodes barcodes/QR codes straight from the live video feed
  // using ZXing (UPC/EAN/Code128/QR/etc. all supported out of the box) — no
  // manual typing required. Debounces repeat hits on the same code so it
  // doesn't fire a lookup on every single frame.
  useEffect(() => {
    if (!cameraOn || !liveScan || !videoRef.current) return undefined;

    const codeReader = new BrowserMultiFormatReader();
    readerRef.current = codeReader;
    setScanning(true);

    codeReader.decodeFromVideoElement(videoRef.current, (result) => {
      if (!result) return; // fires continuously with null while nothing is found — that's normal
      const code = result.getText();
      const now = Date.now();
      const isRepeat = lastScanRef.current.code === code && now - lastScanRef.current.at < SCAN_COOLDOWN_MS;
      if (!isRepeat) {
        lastScanRef.current = { code, at: now };
        handleDetectedCode(code);
      }
    }).catch(() => {
      // decodeFromVideoElement rejects if the video element goes away mid-scan
      // (e.g. camera stopped); nothing to do, cleanup below handles it.
    });

    return () => { codeReader.reset(); setScanning(false); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cameraOn, liveScan]);

  const handleDetectedCode = async (code) => {
    setBarcodeInput(code);
    setError(''); setLookupResult(null);
    // Check the already-loaded product list first (it's populated on mount
    // from a CACHEABLE_READ, so this works offline) before ever hitting the
    // network — /barcode-lookup itself isn't a cacheable/queueable route,
    // so without this a scan while offline would otherwise fail outright.
    const localMatch = products.find((p) => p.sku === code);
    if (localMatch) {
      setLookupResult(localMatch);
      showToast(t('cameraPage.scannedToast', { name: localMatch.name }), 'success');
      return;
    }
    try {
      const { data } = await api.get(`/stores/${user.storeId}/barcode-lookup`, { params: { code } });
      setLookupResult(data);
      showToast(t('cameraPage.scannedToast', { name: data.name }), 'success');
    } catch (err) {
      setError(
        !err.response
          ? t('cameraPage.offlineNoMatch', { code })
          : t('cameraPage.noMatchCode', { code })
      );
    }
  };

  const capturePhoto = async () => {
    const video = videoRef.current, canvas = canvasRef.current;
    canvas.width = video.videoWidth; canvas.height = video.videoHeight;
    canvas.getContext('2d').drawImage(video, 0, 0);
    canvas.toBlob(async (blob) => {
      const fd = new FormData();
      fd.append('photo', blob, `capture-${Date.now()}.jpg`);
      await api.post(`/stores/${user.storeId}/images`, fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      showToast(t('cameraPage.photoSaved'), 'success');
      loadGallery();
    }, 'image/jpeg', 0.9);
  };

  const deleteImage = async (id) => {
    try {
      await api.delete(`/stores/${user.storeId}/images/${id}`);
      loadGallery();
    } catch (err) {
      showToast(err.response?.data?.error || t('cameraPage.deletePhotoFailed'), 'error');
    }
  };

  const lookupBarcode = async (e) => {
    e.preventDefault();
    setLookupResult(null); setError('');
    const localMatch = products.find((p) => p.sku === barcodeInput);
    if (localMatch) { setLookupResult(localMatch); return; }
    try {
      const { data } = await api.get(`/stores/${user.storeId}/barcode-lookup`, { params: { code: barcodeInput } });
      setLookupResult(data);
    } catch (err) {
      setError(
        !err.response
          ? t('cameraPage.offlineLookup')
          : (err.response?.data?.error || t('cameraPage.productNotFound'))
      );
    }
  };

  const addScannedToStock = async () => {
    if (!lookupResult) return;
    await api.post(`/stores/${user.storeId}/arrivals`, { productId: lookupResult.id, quantity: 1 });
    showToast(t('cameraPage.addedToBackroom', { count: 1, name: lookupResult.name }), 'success');
  };

  // Fallback for items with no barcode at all (loose produce, unlabeled
  // stock, etc.) — count by hand instead of scanning, still logged as a
  // real stock arrival so it's identical to a scanned one in every report.
  const addManualCount = async () => {
    const qty = Number(manualQty);
    if (!manualProductId || !qty || qty <= 0) return;
    const product = products.find((p) => p.id === manualProductId);
    await api.post(`/stores/${user.storeId}/arrivals`, {
      productId: manualProductId, quantity: qty, invoiceNumber: 'Manual count (no barcode)',
    });
    showToast(t('cameraPage.addedToBackroom', { count: qty, name: product?.name || t('reportsPage.product') }), 'success');
    setManualProductId(''); setManualQty('1'); setManualSearch('');
  };

  const filteredProducts = manualSearch
    ? products.filter((p) => p.name.toLowerCase().includes(manualSearch.toLowerCase()) || p.sku.toLowerCase().includes(manualSearch.toLowerCase()))
    : products;

  return (
    <div>
      <div className="topbar"><h1>{t('cameraPage.title')}</h1></div>
      <Alert type="error">{error}</Alert>

      <div className="grid grid-2">
        <div className="card">
          <h3 style={{ marginBottom: 12 }}>{t('cameraPage.liveCamera')} {scanning && liveScan && <span className="muted" style={{ fontWeight: 400, fontSize: 13 }}>· {t('cameraPage.scanning')}</span>}</h3>
          <video ref={videoRef} autoPlay playsInline style={{ width: '100%', background: '#000', borderRadius: 8, maxHeight: 260, objectFit: 'cover' }} />
          <canvas ref={canvasRef} style={{ display: 'none' }} />
          <div className="flex mt-1">
            {!cameraOn ? (
              <button className="btn" onClick={startCamera}>{t('cameraPage.startCamera')}</button>
            ) : (
              <>
                <button className="btn" onClick={capturePhoto}>{t('cameraPage.capture')}</button>
                <button className="btn secondary" onClick={stopCamera}>{t('cameraPage.stopCamera')}</button>
              </>
            )}
          </div>
          {cameraOn && (
            <label className="flex mt-1" style={{ alignItems: 'center', gap: 8, fontSize: 14 }}>
              <input type="checkbox" style={{ width: 'auto' }} checked={liveScan} onChange={(e) => setLiveScan(e.target.checked)} />
              {t('cameraPage.autoScan')}
            </label>
          )}
        </div>

        <div className="card">
          <h3 style={{ marginBottom: 12 }}>{t('cameraPage.barcodeLookup')}</h3>
          <p className="muted mt-1">
            {t('cameraPage.lookupHelp')}
          </p>
          <form onSubmit={lookupBarcode} className="flex mt-1">
            <input placeholder={t('cameraPage.placeholderSku')} value={barcodeInput} onChange={(e) => setBarcodeInput(e.target.value)} />
            <button className="btn">{t('cameraPage.lookUp')}</button>
          </form>
          {lookupResult && (
            <div className="card mt-1" style={{ background: 'var(--bg)' }}>
              <strong>{lookupResult.name}</strong>
              <p className="muted">{t('cameraPage.sku')}: {lookupResult.sku} · {t('cameraPage.backroom')}: {lookupResult.backroom_qty} · {t('cameraPage.shelf')}: {lookupResult.shelf_qty}</p>
              <button className="btn small mt-1" onClick={addScannedToStock}>{t('cameraPage.addOneToBackroom')}</button>
            </div>
          )}

          {error && (
            <div className="card mt-1" style={{ background: 'var(--bg)' }}>
              <strong>{t('cameraPage.noBarcodeTitle')}</strong>
              <p className="muted mt-1">{t('cameraPage.noBarcodeHelp')}</p>
              <input
                placeholder={t('cameraPage.searchPlaceholder')}
                value={manualSearch}
                onChange={(e) => { setManualSearch(e.target.value); setManualProductId(''); }}
                className="mt-1"
              />
              {manualSearch && !manualProductId && (
                <div style={{ maxHeight: 150, overflowY: 'auto', marginTop: 6 }}>
                  {filteredProducts.slice(0, 8).map((p) => (
                    <div
                      key={p.id}
                      style={{ padding: '6px 8px', cursor: 'pointer', borderRadius: 4 }}
                      onClick={() => { setManualProductId(p.id); setManualSearch(p.name); }}
                    >
                      {p.name} <span className="muted">({p.sku})</span>
                    </div>
                  ))}
                  {filteredProducts.length === 0 && <p className="muted" style={{ padding: '6px 8px' }}>{t('cameraPage.noMatchingProducts')}</p>}
                </div>
              )}
              {manualProductId && (
                <div className="flex mt-1" style={{ alignItems: 'center', gap: 8 }}>
                  <input type="number" min="1" value={manualQty} onChange={(e) => setManualQty(e.target.value)} style={{ width: 80 }} />
                  <button className="btn small" onClick={addManualCount}>{t('cameraPage.addToBackroom')}</button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="card">
        <h3 style={{ marginBottom: 12 }}>{t('cameraPage.photoGallery')}</h3>
        {gallery.length === 0 ? <p className="muted">{t('cameraPage.noPhotos')}</p> : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 12 }}>
            {gallery.map((img) => (
              <div key={img.id}>
                <img src={img.url} alt={img.label || 'capture'} style={{ width: '100%', borderRadius: 8, aspectRatio: '1', objectFit: 'cover' }} />
                <button className="btn danger small mt-1" style={{ width: '100%' }} onClick={() => deleteImage(img.id)}>{t('cameraPage.delete')}</button>
              </div>
            ))}
          </div>
        )}
      </div>
      <Toast {...(toast || {})} />
    </div>
  );
}
