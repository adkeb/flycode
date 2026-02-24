(() => {
  const REQ = "flycode-debug-req";
  const RES = "flycode-debug-res";
  const pending = new Map();

  function call(action) {
    const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      window.postMessage({ channel: REQ, id, action }, "*");
      setTimeout(() => {
        const entry = pending.get(id);
        if (!entry) return;
        pending.delete(id);
        reject(new Error(`flycode debug timeout: ${action}`));
      }, 3000);
    });
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || !event.data || event.data.channel !== RES) {
      return;
    }
    const { id, ok, result, error } = event.data;
    const entry = pending.get(id);
    if (!entry) {
      return;
    }
    pending.delete(id);
    if (ok) {
      entry.resolve(result);
      return;
    }
    entry.reject(new Error(error || "unknown"));
  });

  window.__flycodeDebug = {
    getSettings: () => call("getSettings"),
    runScan: () => call("runScan"),
    runMask: () => call("runMask"),
    runResultMask: () => call("runResultMask"),
    getExecutionLedger: () => call("getExecutionLedger"),
    getLogs: () => call("getLogs"),
    clearLogs: () => call("clearLogs"),
    dump: async () => {
      const payload = await call("dump");
      console.log("[flycode-debug]", payload);
      return payload;
    }
  };
})();
