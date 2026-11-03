import type { ElectrobunConfig } from 'electrobun';

export default {
  app: {
    name: 'Dispatch',
    identifier: 'app.dispatch.workflows',
    version: process.env.DISPATCH_VERSION || '1.0.0',
    description: 'Run GitHub Actions workflows in order.',
  },
  build: {
    mainProcess: 'cottontail',
    cottontail: { entrypoint: 'desktop/main.ts', minify: true },
    copy: { public: 'public' },
    watch: ['desktop', 'lib', 'server.mjs', 'public'],
    buildFolder: 'build',
    artifactFolder: 'dist/electrobun',
    mac: { bundleCEF: false, bundleWGPU: false, defaultRenderer: 'native' },
    win: { bundleCEF: false, bundleWGPU: false, defaultRenderer: 'native' },
    linux: { bundleCEF: false, bundleWGPU: false, defaultRenderer: 'native' },
  },
  // The main process drains the queue before allowing the application to quit.
  runtime: { exitOnLastWindowClosed: false },
} satisfies ElectrobunConfig;
