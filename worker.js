// Image processing off the main thread so the viewfinder keeps running during batch scans.
importScripts('imaging.js');
const IMG = self.SnapdocImaging;
self.onmessage = async e => {
  const m = e.data, reply = { id: m.id };
  try {
    const fn = IMG.tasks[m.cmd];
    if (!fn) throw new Error('unknown task ' + m.cmd);
    Object.assign(reply, await fn(m));
    reply.ok = true;
  } catch (err) {
    reply.ok = false; reply.error = String((err && err.message) || err);
  }
  self.postMessage(reply);
};
