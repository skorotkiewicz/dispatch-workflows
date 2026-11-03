export function createQuitController({ hasQueue, confirmClose, close, quit, onError = console.error }) {
  let ready = false;
  let closing = null;

  function request(confirm = true) {
    if (closing) return closing;
    closing = Promise.resolve().then(async () => {
      if (confirm && hasQueue() && !await confirmClose()) return;
      await close();
      ready = true;
      quit();
    }).catch(onError).finally(() => { closing = null; });
    return closing;
  }

  function handleEvent(event) {
    if (ready) return;
    event.response = { allow: false };
    void request();
  }
  return { request, handleEvent };
}
