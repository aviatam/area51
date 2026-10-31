// DEMO ONLY: the "attacker" endpoint. It records what the payload sent so the demo can
// show exactly what leaked, and nothing else.
const http = require('http');
const fs = require('fs');
const out = process.env.SINK_LOG || '/sink/received.jsonl';
http
  .createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      fs.appendFileSync(out, JSON.stringify({ at: new Date().toISOString(), path: req.url, body }) + '\n');
      res.end('ok');
    });
  })
  .listen(9999);
