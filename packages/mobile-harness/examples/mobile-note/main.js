cindy.onHostMessage(async function (msg) {
  if (msg.type !== 'tool-call' || msg.tool !== 'save_note') return;
  const saved = await cindy.fs({ root: 'workdir', callId: msg.callId, path: 'note.txt', content: String(msg.args.text) });
  await cindy.send({ type: 'tool-result', callId: msg.callId, ok: saved.ok, result: saved.ok ? { path: 'note.txt' } : saved });
});
