// Make video's waiting line. At most `slots` AI versions run at once on our provider account (it bounds how much of
// our money can be in flight); when it's full, higher plans go first, then first come, first served
// (docs/PRICING-PLAN.md, "Queue when busy"). Jobs on a customer's own key don't use our slots (jobs.js lane()).
export function makeQueue({ slots = 6 } = {}) {
  let running = 0, seq = 0;
  const waiting = [];
  function next() {
    while (running < slots && waiting.length) {
      waiting.sort((a, b) => b.priority - a.priority || a.seq - b.seq);
      const w = waiting.shift();
      running++;
      Promise.resolve().then(w.fn).then(w.resolve, w.reject).finally(() => { running--; next(); });
    }
  }
  return {
    /** Run fn when a slot is free. Resolves with fn's result. */
    run(priority, fn) {
      return new Promise((resolve, reject) => { waiting.push({ priority: Number(priority) || 0, seq: seq++, fn, resolve, reject }); next(); });
    },
    get busy() { return running >= slots; },
    get running() { return running; },
    get waiting() { return waiting.length; },
  };
}
