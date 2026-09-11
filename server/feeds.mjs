const phases = {
  investigating: "正在排查",
  identified: "已定位",
  monitoring: "观察中",
  resolved: "已恢复",
  scheduled: "维护计划",
  in_progress: "维护中",
  completed: "维护完成",
  cancelled: "维护取消",
};

function escapeXML(value) {
  return (
    String(value)
      // XML 1.0 forbids these control characters even when escaped.
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;")
  );
}

export function feedEntries(incidents) {
  return incidents
    .flatMap((incident) => {
      const updates = incident.updates?.length
        ? incident.updates
        : [
            {
              id: incident.id,
              phase: incident.phase,
              message: incident.message,
              createdAt: incident.updatedAt,
            },
          ];
      const first = [...updates].sort(
        (a, b) =>
          new Date(a.createdAt) - new Date(b.createdAt) ||
          a.id.localeCompare(b.id),
      )[0];
      return updates.map((update) => ({
        // Preserve the original incident identity for its first entry.
        id:
          update.id === first.id && update.createdAt === incident.startedAt
            ? incident.id
            : update.id,
        incidentId: incident.id,
        title: `${incident.title} · ${phases[update.phase] || "状态更新"}`,
        message: update.message,
        updatedAt: update.createdAt,
      }));
    })
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
    .slice(0, 50);
}

export function renderFeed(format, origin, entries, fallbackUpdated) {
  const updated = entries[0]?.updatedAt || fallbackUpdated;
  const root = escapeXML(origin);
  const link = (entry) =>
    `${root}/incidents/${encodeURIComponent(entry.incidentId)}`;
  const body =
    format === "rss"
      ? `<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom"><channel><title>LaZy Campus Status</title><link>${root}</link><description>服务故障与维护通知</description><language>zh-CN</language><atom:link href="${root}/feed.rss" rel="self" type="application/rss+xml"/><lastBuildDate>${new Date(updated).toUTCString()}</lastBuildDate>${entries.map((entry) => `<item><guid isPermaLink="false">${escapeXML(entry.id)}</guid><title>${escapeXML(entry.title)}</title><description>${escapeXML(escapeXML(entry.message))}</description><link>${link(entry)}</link><pubDate>${new Date(entry.updatedAt).toUTCString()}</pubDate></item>`).join("")}</channel></rss>`
      : `<feed xmlns="http://www.w3.org/2005/Atom" xml:lang="zh-CN"><id>${root}</id><title>LaZy Campus Status</title><subtitle>服务故障与维护通知</subtitle><author><name>Lazy Campus</name></author><updated>${updated}</updated><link href="${root}/feed.atom" rel="self" type="application/atom+xml"/><link href="${root}" rel="alternate" type="text/html"/>${entries.map((entry) => `<entry><id>urn:uuid:${escapeXML(entry.id)}</id><title>${escapeXML(entry.title)}</title><updated>${entry.updatedAt}</updated><link href="${link(entry)}" rel="alternate" type="text/html"/><content type="text">${escapeXML(entry.message)}</content></entry>`).join("")}</feed>`;
  return '<?xml version="1.0" encoding="utf-8"?>' + body;
}
