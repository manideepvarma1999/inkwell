/**
 * npm run loadtest -- [clients=50] [seconds=10] [strokesPerSecond=5]
 *
 * Starts an in-process server, connects N editors to one board, has each draw
 * strokes at a steady rate, and measures fan-out latency: the time from one client
 * writing a stroke until each other client has it.
 */
import { createBoard, connect, start } from "../tests/helpers";
import { LIMITS } from "../shared/schema";

const clients = Math.min(Number(process.argv[2] ?? 50), LIMITS.maxConnectionsPerBoard);
const seconds = Number(process.argv[3] ?? 10);
const rate = Number(process.argv[4] ?? 5);

const server = await start(undefined, { connectionsPerIp: 1000 });
const board = await createBoard(server);
const peers = await Promise.all(Array.from({ length: clients }, () => connect(server, board.id, board.editKey)));

const sentAt = new Map<string, number>();
const latencies: number[] = [];
for (const peer of peers) {
  peer.elements.observe((event) => {
    if (event.transaction.local) return;
    const now = performance.now();
    for (const key of event.keysChanged) {
      const t = sentAt.get(key);
      if (t !== undefined) latencies.push(now - t);
    }
  });
}

console.log(`${clients} clients, ${rate} strokes/s each, for ${seconds}s...`);
let n = 0;
const timers = peers.map((peer, i) =>
  setInterval(() => {
    const id = `load${i.toString().padStart(3, "0")}${(n++).toString(36).padStart(6, "0")}`.slice(0, 32);
    sentAt.set(id, performance.now());
    peer.elements.set(id, { id, type: "stroke", color: "#2563eb", width: 3, points: [i, n % 500, i + 40, (n % 500) + 40], z: Date.now() });
  }, 1000 / rate),
);

await new Promise((r) => setTimeout(r, seconds * 1000));
timers.forEach(clearInterval);
await new Promise((r) => setTimeout(r, 1000)); // let in-flight updates arrive

latencies.sort((a, b) => a - b);
const pct = (p: number) => latencies[Math.floor((latencies.length - 1) * p)]?.toFixed(1) ?? "n/a";
const expected = sentAt.size * (clients - 1);
console.log(`strokes sent: ${sentAt.size}, deliveries: ${latencies.length} of ${expected} expected`);
console.log(`fan-out latency (ms): p50 ${pct(0.5)}  p95 ${pct(0.95)}  p99 ${pct(0.99)}  max ${pct(1)}`);

peers.forEach((p) => p.close());
await server.stop();
process.exit(0);
