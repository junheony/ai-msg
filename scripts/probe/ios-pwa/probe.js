// scripts/probe/ios-pwa/probe.js — 저장소 분리·persist·카메라·BarcodeDetector·푸시 지원을 한 화면에 적는다
const out = document.getElementById('out');
const log = (k, v) => { out.textContent += `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}\n`; };
const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
log('standalone', standalone);
log('BarcodeDetector', 'BarcodeDetector' in window);
log('PushManager', 'PushManager' in window);
navigator.serviceWorker?.register('sw.js').then(() => log('sw', 'ok'), (e) => log('sw', String(e)));
function idb() {
  return new Promise((res, rej) => { const r = indexedDB.open('probe', 1); r.onupgradeneeded = () => r.result.createObjectStore('kv'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
}
document.getElementById('write').onclick = async () => {
  const v = `${standalone ? 'pwa' : 'safari'}@${new Date().toISOString()}`;
  localStorage.setItem('probe', v);
  const db = await idb(); db.transaction('kv', 'readwrite').objectStore('kv').put(v, 'probe');
  log('wrote', v);
  log('persist', navigator.storage?.persist ? await navigator.storage.persist() : 'unsupported');
};
document.getElementById('read').onclick = async () => {
  log('localStorage', localStorage.getItem('probe'));
  const db = await idb();
  const r = db.transaction('kv').objectStore('kv').get('probe');
  r.onsuccess = () => log('indexedDB', r.result ?? null);
};
document.getElementById('camera').onclick = async () => {
  try { const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } }); log('camera', 'ok'); s.getTracks().forEach((t) => t.stop()); }
  catch (e) { log('camera', String(e)); }
};
document.getElementById('push').onclick = async () => {
  log('Notification.permission', typeof Notification === 'undefined' ? 'none' : Notification.permission);
};
