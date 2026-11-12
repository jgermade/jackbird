// A free port for the service's checks, chosen by the system, never one browsers refuse. The checks
// used to pick 4646 plus a random number below 1000 (and that plus 1000 for the mail sink): that
// range holds 5060 and 5061 (SIP's), and the sink's 6000 and 6566, which the Fetch standard lists
// as bad ports. Node's fetch and Chromium refuse them at once ("bad port"), so a check that drew
// one failed with "the service did not start" while the service ran (release.yml, 2026-11-12, on
// 5060). The system's ephemeral ports lie above that list; each is still checked against it, and
// kept only if it is free on ::1 too (or the machine has no ::1), since the service listens on
// both loopbacks and the checks reach it as `localhost`. Synchronous, so the checks keep their
// ports as constants. See RECORD/2026-08-11.musikmatch-rust-migration.WIP.md.

const { execFileSync } = require("node:child_process");

// The Fetch standard's bad ports (https://fetch.spec.whatwg.org/#bad-port).
const BAD = [1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080];

const PROBE = `
const BAD = new Set(${JSON.stringify(BAD)});
const net = require("node:net");
const once = () => new Promise((resolve) => {
  const v4 = net.createServer();
  v4.once("error", () => resolve(null));
  v4.listen(0, "127.0.0.1", () => {
    const port = v4.address().port;
    const v6 = net.createServer();
    v6.once("error", (error) => v4.close(() => resolve(error.code === "EADDRINUSE" ? null : port)));
    v6.listen(port, "::1", () => v6.close(() => v4.close(() => resolve(port))));
  });
});
(async () => {
  for (let tries = 0; tries < 20; tries += 1) {
    const port = await once();
    if (port && !BAD.has(port)) return process.stdout.write(String(port));
  }
  process.exit(1);
})();
`;

/** A port free on 127.0.0.1 and on ::1, chosen by the system. */
function freePort() {
  return Number(execFileSync(process.execPath, ["-e", PROBE], { encoding: "utf8" }).trim());
}

module.exports = { freePort };
