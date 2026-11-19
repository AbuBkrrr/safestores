// ------------------------------------------------------------
// Direct thermal-printer output from the browser — no driver, no app,
// no licence. Uses standard web APIs (Chrome/Edge on desktop & Android):
//   • Web Serial    — USB printers that appear as a serial/COM port
//   • WebUSB        — USB printers with a raw "printer class" interface
//   • Web Bluetooth — common BLE receipt printers
//   • Wi-Fi / network — printers on the shop Wi-Fi (raw port 9100), sent
//     through the shop computer, so any phone or tablet in the shop can use it
// The chosen connection type is remembered; the browser itself remembers
// which device the user allowed, so later prints need no picker.
// Anything unsupported falls back to the normal print dialog.
// ------------------------------------------------------------

import api from '../api/client.js';

const PREF_KEY = 'ss_printer';
const ADDR_KEY = 'ss_printer_addr';
const isShopComputer = import.meta.env.VITE_EDITION === 'desktop';
// Service/characteristic pairs used by the most common BLE receipt printers.
const BLE_SERVICES = [
  ['000018f0-0000-1000-8000-00805f9b34fb', '00002af1-0000-1000-8000-00805f9b34fb'],
  ['e7810a71-73ae-499d-8c15-faa9aef0c3f2', 'bef8d6c9-9c21-4c9e-b632-bd58c1009f9f'],
  ['49535343-fe7d-4ae5-8fa9-9fafd205e455', '49535343-8841-43f4-a8d4-ecbe34729bb3'],
];

export function printerSupport() {
  const n = typeof navigator !== 'undefined' ? navigator : {};
  return { serial: !!n.serial, usb: !!n.usb, bluetooth: !!n.bluetooth, network: isShopComputer };
}

export function savedPrinterType() {
  try { return localStorage.getItem(PREF_KEY) || ''; } catch { return ''; }
}
export function savePrinterType(t) {
  try { if (t) localStorage.setItem(PREF_KEY, t); else localStorage.removeItem(PREF_KEY); } catch { /* storage blocked */ }
}

export function savedPrinterAddress() {
  try { return localStorage.getItem(ADDR_KEY) || ''; } catch { return ''; }
}
export function savePrinterAddress(a) {
  try { localStorage.setItem(ADDR_KEY, String(a || '').trim()); } catch { /* storage blocked */ }
}

function toBase64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

async function viaNetwork(bytes) {
  const [host, port] = savedPrinterAddress().split(':');
  if (!host) throw new Error('Enter the printer\'s IP address first (find it on the printer\'s self-test page)');
  try {
    await api.post('/print/network', { host, port: port ? Number(port) : 9100, data: toBase64(bytes) });
  } catch (err) {
    throw new Error(err.response?.data?.error || err.message);
  }
}

async function viaSerial(bytes, ask) {
  let [port] = await navigator.serial.getPorts();
  if (!port || ask) port = await navigator.serial.requestPort();
  await port.open({ baudRate: 9600 }).catch((e) => { if (!/already open/i.test(e.message)) throw e; });
  const writer = port.writable.getWriter();
  try { await writer.write(bytes); } finally { writer.releaseLock(); await port.close().catch(() => {}); }
}

async function viaUsb(bytes, ask) {
  let [device] = await navigator.usb.getDevices();
  if (!device || ask) device = await navigator.usb.requestDevice({ filters: [{ classCode: 7 }] }); // 7 = printer class
  await device.open();
  if (device.configuration === null) await device.selectConfiguration(1);
  const iface = device.configuration.interfaces.find((i) => i.alternates.some((a) => a.endpoints.some((e) => e.direction === 'out')));
  if (!iface) throw new Error('This USB device has no output endpoint');
  await device.claimInterface(iface.interfaceNumber);
  const ep = iface.alternates[0].endpoints.find((e) => e.direction === 'out');
  try { await device.transferOut(ep.endpointNumber, bytes); } finally { await device.close().catch(() => {}); }
}

let bleChar = null;
async function viaBluetooth(bytes, ask) {
  if (!bleChar || ask || !bleChar.service.device.gatt.connected) {
    const device = await navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: BLE_SERVICES.map(([s]) => s) });
    const server = await device.gatt.connect();
    bleChar = null;
    for (const [svc, chr] of BLE_SERVICES) {
      try { bleChar = await (await server.getPrimaryService(svc)).getCharacteristic(chr); break; } catch { /* try the next pair */ }
    }
    if (!bleChar) throw new Error('No supported printer service found on this Bluetooth device');
  }
  // BLE packets are small; send in chunks, with a short pause so budget
  // printers with tiny buffers don't drop lines.
  for (let i = 0; i < bytes.length; i += 100) {
    const chunk = bytes.slice(i, i + 100);
    // eslint-disable-next-line no-await-in-loop
    await bleChar.writeValueWithoutResponse(chunk).catch(() => bleChar.writeValue(chunk));
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** Sends raw ESC/POS bytes. type: 'serial' | 'usb' | 'bluetooth' | 'network'. `ask` forces the device picker. */
export async function printRaw(bytes, type = savedPrinterType(), { ask = false } = {}) {
  if (type === 'serial' && navigator.serial) return viaSerial(bytes, ask);
  if (type === 'usb' && navigator.usb) return viaUsb(bytes, ask);
  if (type === 'bluetooth' && navigator.bluetooth) return viaBluetooth(bytes, ask);
  if (type === 'network' && isShopComputer) return viaNetwork(bytes);
  throw new Error('No receipt printer connection chosen, or this browser does not support it');
}
