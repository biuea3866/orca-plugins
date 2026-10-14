// Keep mounted nodes, focus, selection and inner scroll positions across snapshots.
function hydratePanelData(data) {
  if (!data || data.compact !== 1 || !Array.isArray(data.snapshot?.sessions) || !data.details) return data;
  const sessions = new Map(data.snapshot.sessions.map(session => [session.id, session]));
  const details = {};
  for (const [id, entry] of Object.entries(data.details)) {
    const session = entry.session || {...sessions.get(id), ...entry.sessionOverrides};
    details[id] = {...entry, session, requests: entry.requests || session.requests, llmUsage: entry.llmUsage || session.llmUsage};
  }
  return {...data, details};
}

function liveNodeKey(node) {
  if (node.nodeType !== 1) return null;
  if (node.classList.contains('terminal-navigation')) return 'terminal:' + node.dataset.sessionId + ':' + (node.dataset.terminal || '');
  for (const name of ['liveKey', 'disclosureKey', 'sessionId', 'requestId', 'field']) {
    if (node.dataset[name]) return name + ':' + node.dataset[name];
  }
  if (node.classList.contains('panel')) return 'panel:' + (node.querySelector('.panel-head h3')?.textContent || node.className);
  return null;
}
function reconcileChildren(parent, incoming) {
  const old = [...parent.childNodes], used = new Set();
  const keyed = new Map(old.map(node => [liveNodeKey(node), node]).filter(([key]) => key !== null));
  const compatible = (a, b) => a.nodeType === b.nodeType && a.nodeName === b.nodeName;
  for (let index = 0; index < incoming.length; index++) {
    const fresh = incoming[index], key = liveNodeKey(fresh);
    let current = key !== null ? keyed.get(key) : old.find(node => !used.has(node) && liveNodeKey(node) === null && compatible(node, fresh));
    if (!current || used.has(current) || !compatible(current, fresh)) current = fresh;
    used.add(current);
    if (current !== fresh) {
      if (current.nodeType === 1) {
        for (const attr of [...current.attributes]) if (!fresh.hasAttribute(attr.name)) current.removeAttribute(attr.name);
        for (const attr of fresh.attributes) if (current.getAttribute(attr.name) !== attr.value) current.setAttribute(attr.name, attr.value);
        reconcileChildren(current, [...fresh.childNodes]);
      } else if (current.nodeValue !== fresh.nodeValue) current.nodeValue = fresh.nodeValue;
    }
    if (parent.childNodes[index] !== current) parent.insertBefore(current, parent.childNodes[index] || null);
  }
  for (const node of old) if (!used.has(node)) node.remove();
}
