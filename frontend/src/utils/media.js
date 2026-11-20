// Uploaded files are stored either as a full address (object storage) or
// site-relative ("/uploads/x.jpg", served next to the API but not under
// /api). Builds that talk to a remote server (the Android app) need the
// server's address in front of the relative ones.
export function mediaUrl(url) {
  if (!url) return '';
  if (/^(https?:|data:|blob:)/.test(url)) return url;
  const api = import.meta.env.VITE_API_URL;
  return api ? api.replace(/\/api\/?$/, '') + url : url;
}
