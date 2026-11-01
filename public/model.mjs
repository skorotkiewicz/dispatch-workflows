export function recency(date, now = Date.now()) {
  if (!date || !Number.isFinite(Date.parse(date))) return 'never';
  const age = Math.max(0, now - Date.parse(date));
  if (age < 3_600_000) return 'hour';
  if (age < 86_400_000) return 'day';
  if (age <= 604_800_000) return 'week';
  return 'stale';
}

export function relativeTime(date, now = Date.now()) {
  if (!date || !Number.isFinite(Date.parse(date))) return 'Never run';
  const seconds = Math.max(0, (now - Date.parse(date)) / 1000);
  if (seconds < 60) return 'Just now';
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'always' });
  for (const [unit, scale] of [['day', 86400], ['hour', 3600], ['minute', 60]]) {
    if (seconds >= scale) return formatter.format(-Math.floor(seconds / scale), unit);
  }
}

export function escapeHTML(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

export function runDate(run) {
  return run?.startedAt || run?.createdAt;
}

export function filteredWorkflows(workflows, { search = '', filter = 'all', sort = 'name' } = {}) {
  const query = search.trim().toLocaleLowerCase();
  return workflows.filter(workflow =>
    `${workflow.name} ${workflow.path}`.toLocaleLowerCase().includes(query) &&
    (filter === 'all' || recency(runDate(workflow.lastRun)) === filter)
  ).sort((a, b) => {
    if (sort === 'name') return a.name.localeCompare(b.name);
    const difference = (Date.parse(runDate(a.lastRun)) || 0) - (Date.parse(runDate(b.lastRun)) || 0);
    return (sort === 'recent' ? -difference : difference) || a.name.localeCompare(b.name);
  });
}
