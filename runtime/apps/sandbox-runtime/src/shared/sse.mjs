export function writeSseHeaders(res, extraHeaders = {}) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "x-accel-buffering": "no",
    ...extraHeaders
  });
  if (typeof res.flushHeaders === "function") res.flushHeaders();
}

export function writeSseEvent(res, { event, data, id } = {}) {
  if (!res || res.writableEnded) return;
  let payload = "";
  if (id !== undefined && id !== null) payload += `id: ${id}\n`;
  if (event) payload += `event: ${event}\n`;
  const body = typeof data === "string" ? data : JSON.stringify(data ?? {});
  for (const line of body.split("\n")) {
    payload += `data: ${line}\n`;
  }
  payload += "\n";
  res.write(payload);
}

export function writeSseHeartbeat(res) {
  if (!res || res.writableEnded) return;
  res.write(":keepalive\n\n");
}

export function closeSse(res) {
  if (!res || res.writableEnded) return;
  res.end();
}
