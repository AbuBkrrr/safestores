import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import QRCode from 'qrcode';
import { Modal } from './ui.jsx';

// Draws a shareable invite card (store, name, role, code, QR) as a PNG.
async function drawCard({ storeName, invite, link, qrUrl }) {
  const W = 600; const H = 820;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, W, H);
  g.fillStyle = '#0f7180'; g.fillRect(0, 0, W, 120);
  g.fillStyle = '#ffffff'; g.textAlign = 'center';
  g.font = 'bold 30px system-ui, sans-serif'; g.fillText(storeName, W / 2, 58, W - 40);
  g.font = '18px system-ui, sans-serif'; g.fillText('You are invited to join on SAFE Stores', W / 2, 92);
  g.fillStyle = '#182026';
  g.font = 'bold 26px system-ui, sans-serif'; g.fillText(invite.name, W / 2, 175, W - 40);
  g.fillStyle = '#64717c'; g.font = '18px system-ui, sans-serif';
  g.fillText(`Role: ${String(invite.role).replace(/_/g, ' ')}`, W / 2, 205);
  const img = new Image();
  await new Promise((ok, fail) => { img.onload = ok; img.onerror = fail; img.src = qrUrl; });
  g.drawImage(img, (W - 380) / 2, 235, 380, 380);
  g.fillStyle = '#64717c'; g.font = '16px system-ui, sans-serif'; g.fillText('Scan to join, or enter this code:', W / 2, 650);
  g.fillStyle = '#182026'; g.font = 'bold 40px ui-monospace, monospace'; g.fillText(invite.code, W / 2, 705);
  g.fillStyle = '#0f7180'; g.font = '14px system-ui, sans-serif'; g.fillText(link, W / 2, 760, W - 40);
  return new Promise((ok) => c.toBlob(ok, 'image/png'));
}

/** Share one invite: QR code, download card, WhatsApp / email / SMS / copy / native share. */
export default function InviteShareModal({ invite, link, storeName, onClose, onShare }) {
  const { t } = useTranslation();
  const [qrUrl, setQrUrl] = useState('');
  useEffect(() => {
    QRCode.toDataURL(link, { width: 380, margin: 1, errorCorrectionLevel: 'M' }).then(setQrUrl).catch(() => setQrUrl(''));
  }, [link]);

  const fileName = `invite-${invite.name.replace(/[^\w-]+/g, '-').toLowerCase()}-${invite.code}.png`;
  const download = async () => {
    const blob = await drawCard({ storeName, invite, link, qrUrl });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = fileName; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  };
  // Phones: share the card image itself (WhatsApp, Telegram, Gmail…) when the browser allows files.
  const shareCard = async () => {
    try {
      const blob = await drawCard({ storeName, invite, link, qrUrl });
      const file = new File([blob], fileName, { type: 'image/png' });
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], title: 'SAFE Stores invite', text: `${storeName} invite code: ${invite.code}\n${link}` });
        return;
      }
    } catch { /* fall through to the text share */ }
    onShare('native');
  };

  return (
    <Modal title={t('inviteShare.title', { name: invite.name })} onClose={onClose}>
      <div style={{ textAlign: 'center' }}>
        {qrUrl ? <img src={qrUrl} alt={t('inviteShare.qrAlt')} style={{ width: 220, height: 220, background: '#fff', padding: 8, borderRadius: 12 }} /> : <div style={{ height: 220 }} />}
        <p className="muted" style={{ margin: '6px 0' }}>{t('inviteShare.scan')}</p>
        <div className="code-chip" style={{ fontSize: 22, display: 'inline-block', padding: '6px 14px' }}>{invite.code}</div>
        <p className="muted" style={{ fontSize: 12, wordBreak: 'break-all' }}>{link}</p>
      </div>
      <div className="flex" style={{ gap: 8, flexWrap: 'wrap', justifyContent: 'center', marginTop: 8 }}>
        <button className="btn small" style={{ background: '#25D366', borderColor: '#25D366' }} onClick={() => onShare('whatsapp')}>WhatsApp</button>
        <button className="btn small secondary" onClick={() => onShare('email')}>{t('invitesPage.emailAction')}</button>
        <button className="btn small secondary" onClick={() => onShare('sms')}>{t('invitesPage.smsAction')}</button>
        <button className="btn small secondary" onClick={() => onShare('copy')}>{t('invitesPage.copyAction')}</button>
        <button className="btn small secondary" disabled={!qrUrl} onClick={download}>⬇️ {t('inviteShare.download')}</button>
        {typeof navigator !== 'undefined' && navigator.share && <button className="btn small secondary" disabled={!qrUrl} onClick={shareCard}>📤 {t('inviteShare.more')}</button>}
      </div>
    </Modal>
  );
}
