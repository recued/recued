// Playwright captures the address after the owned server binds its port and
// passes it to every worker. Collection imports specs without starting a
// server, so its fallback is an inert loopback address.
export const HARNESS_ORIGIN = process.env.WEBCLIENT_HARNESS_ORIGIN ?? 'http://127.0.0.1:0';
