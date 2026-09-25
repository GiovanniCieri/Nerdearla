const EXTENSION_ID_PATTERN = /^[a-p]{32}$/u;

export function configuredCaptureExtensionOrigin(extensionId) {
  const normalized = String(extensionId || '').trim().toLowerCase();
  return EXTENSION_ID_PATTERN.test(normalized) ? `chrome-extension://${normalized}` : null;
}

export function isCaptureExtensionOrigin(origin, extensionId) {
  const expected = configuredCaptureExtensionOrigin(extensionId);
  return Boolean(expected && String(origin || '').toLowerCase() === expected);
}

export function isSameHostOrigin(origin, requestHost) {
  try {
    return new URL(origin).host.toLowerCase() === String(requestHost || '').toLowerCase();
  } catch {
    return false;
  }
}
