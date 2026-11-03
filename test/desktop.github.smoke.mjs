// Opt-in public GitHub connectivity check, with no credentials or workflow dispatches.
process.env.DISPATCH_TEST_LIVE_GITHUB = '1';
await import('./desktop.smoke.mjs');
