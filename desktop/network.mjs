import tls from 'node:tls';

// Cottontail 0.7.3 discovers these roots, but its default HTTPS path does not use them.
// Include configured extra roots too; certificate and hostname verification stay enabled.
const trustedCertificates = tls.getCACertificates?.('default') || tls.rootCertificates;

export function fetchGitHub(input, options = {}) {
  return fetch(input, { ...options, tls: { ca: trustedCertificates } });
}
