/** One SSE block from a `text/event-stream` buffer. Incomplete trailing bytes stay in `rest`. */
export function takeSse(buf: string): { events: { event: string; data: string }[]; rest: string } {
  const events: { event: string; data: string }[] = [];
  let rest = buf.replace(/\r\n/g, '\n');
  for (;;) {
    const i = rest.indexOf('\n\n');
    if (i < 0) break;
    const block = rest.slice(0, i);
    rest = rest.slice(i + 2);
    let event = 'message';
    const data: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
    if (data.length) events.push({ event, data: data.join('\n') });
  }
  return { events, rest };
}
