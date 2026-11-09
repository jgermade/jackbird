// A minimal SMTP server for checks (S3): it accepts every email, sends none, and appends each
// to a file as a line of JSON ({ to, subject, text }), so a check can read the codes.
//
//   node scripts/smtp-sink.mjs <port> <file>
//
// Plain SMTP only (the service's "none" security), on 127.0.0.1.

import { appendFileSync } from "node:fs";
import { createServer } from "node:net";

const [port = "2525", file = "smtp-sink.jsonl"] = process.argv.slice(2);

/** The subject and the text of a message as sent (headers, a blank line, the body). */
export function parseMessage(data) {
  const [head, ...body] = data.split(/\r?\n\r?\n/);
  const subject = /^Subject: (.*)$/im.exec(head)?.[1] ?? "";
  const decoded = /^Subject: =\?utf-8\?b\?(.*)\?=$/im.exec(head);
  const text = body.join("\n\n");
  return {
    subject: decoded ? Buffer.from(decoded[1], "base64").toString("utf8") : subject,
    text: /quoted-printable/i.test(head)
      ? text.replace(/=\r?\n/g, "").replace(/=([0-9A-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
      : text,
  };
}

createServer((socket) => {
  let buffer = "";
  let data = null;
  let to = [];
  socket.write("220 smtp-sink\r\n");
  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let at;
    while ((at = buffer.indexOf("\r\n")) >= 0) {
      const line = buffer.slice(0, at);
      buffer = buffer.slice(at + 2);
      if (data !== null) {
        if (line === ".") {
          const message = parseMessage(data.join("\r\n"));
          appendFileSync(file, JSON.stringify({ to, ...message }) + "\n");
          data = null;
          to = [];
          socket.write("250 kept\r\n");
        } else {
          data.push(line.startsWith("..") ? line.slice(1) : line);
        }
        continue;
      }
      const verb = line.slice(0, 4).toUpperCase();
      if (verb === "EHLO" || verb === "HELO") socket.write("250 smtp-sink\r\n");
      else if (verb === "RCPT") {
        to.push(/<(.*)>/.exec(line)?.[1] ?? "");
        socket.write("250 ok\r\n");
      } else if (verb === "DATA") {
        data = [];
        socket.write("354 go on\r\n");
      } else if (verb === "QUIT") {
        socket.end("221 bye\r\n");
      } else socket.write("250 ok\r\n");
    }
  });
}).listen(Number(port), "127.0.0.1", () => console.log(`smtp-sink: 127.0.0.1:${port} → ${file}`));
