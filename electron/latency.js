const net = require('net');

const PING_PORT = 443;
const PING_TIMEOUT_MS = 3000;
const PING_SAMPLES = 3;
const PING_SAMPLE_GAP_MS = 200;
const MAX_CONCURRENT = 20;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Single TCP probe — returns RTT in ms, or null on timeout/error
function measureLatency(host) {
  return new Promise(resolve => {
    const start = Date.now();
    const socket = new net.Socket();

    const cleanup = (result) => {
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(PING_TIMEOUT_MS);
    socket.connect(PING_PORT, host, () => cleanup(Date.now() - start));
    socket.on('error', () => cleanup(null));
    socket.on('timeout', () => cleanup(null));
  });
}

// 3 samples per server, returns minimum RTT or Infinity if all fail
async function measureServer(host) {
  const samples = [];
  for (let i = 0; i < PING_SAMPLES; i++) {
    const rtt = await measureLatency(host);
    if (rtt !== null) samples.push(rtt);
    if (i < PING_SAMPLES - 1) await sleep(PING_SAMPLE_GAP_MS);
  }
  return samples.length > 0 ? Math.min(...samples) : Infinity;
}

// Measure all servers in parallel with a concurrency cap
// servers: Array<{ id: string, host: string }>
// returns: Record<string, number> — { serverId: latencyMs }
async function measureAll(servers) {
  const results = {};
  let active = 0;
  let index = 0;

  await new Promise(resolve => {
    function next() {
      while (active < MAX_CONCURRENT && index < servers.length) {
        const server = servers[index++];
        if (!server.host) {
          // No host to probe — skip
          if (active === 0 && index >= servers.length) resolve();
          continue;
        }
        active++;
        measureServer(server.host).then(latency => {
          if (latency !== Infinity) results[server.id] = latency;
          active--;
          if (active === 0 && index >= servers.length) resolve();
          else next();
        });
      }
      if (active === 0 && index >= servers.length) resolve();
    }
    next();
  });

  return results;
}

module.exports = { measureAll };
