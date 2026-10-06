// Picking the port for Tandem's embedded server. Kept free of Electron so it can be tested on its own.

const net = require('node:net');

/** True when nothing is listening on this port on the loopback address. */
function portFree(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen(port, '127.0.0.1');
  });
}

/** Ask the operating system for a port nobody is using. */
function anyFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/** The wanted port if it is free, otherwise a free one, so a busy port never stops Tandem from starting. */
async function choosePort(wanted = 4317) {
  if (await portFree(wanted)) return wanted;
  for (let attempt = 0; attempt < 10; attempt++) {
    const port = await anyFreePort();
    if (await portFree(port)) return port;
  }
  throw new Error('Could not find a free local port for Tandem’s server.');
}

module.exports = { portFree, anyFreePort, choosePort };
