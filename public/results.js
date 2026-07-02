// Rendu partagé des résultats (page permalien votant ET page d'admin) :
// une liste complète classée par score, chaque option avec image, note et
// jauge bidirectionnelle. Garantit un affichage identique des deux côtés.
(function () {
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  window.vvRenderResults = function (el, data) {
    if (!el) return;
    const opts = data.options || [];
    let maxAbs = 1;
    opts.forEach((o) => { if (Math.abs(o.total) > maxAbs) maxAbs = Math.abs(o.total); });
    const rankCount = {};
    opts.forEach((o) => { rankCount[o.rank] = (rankCount[o.rank] || 0) + 1; });
    const fmt = (t) => (t > 0 ? '+' + t : String(t));
    const cls = (t) => (t > 0 ? 'pos' : (t < 0 ? 'neg' : ''));
    const half = (t) => (Math.abs(t) / maxAbs * 50).toFixed(1);
    let html = '<div class="res-list">';
    for (const o of opts) {
      const thumb = o.has_image ? '<img class="res-thumb" src="/options/' + o.id + '/image" alt="">' : '';
      const tie = rankCount[o.rank] > 1 ? '<span class="tie">ex æquo</span>' : '';
      const desc = o.description ? '<div class="muted res-desc">' + escapeHtml(o.description) + '</div>' : '';
      const name = o.label ? escapeHtml(o.label) : '(image)';
      const gcls = o.total < 0 ? 'neg' : 'pos';
      html += '<div class="res-row"><div class="res-head">' +
                '<span class="res-rank">' + o.rank + '</span>' +
                '<div class="res-main">' + thumb + '<div><div class="res-name">' + name + tie + '</div>' + desc + '</div></div>' +
                '<span class="res-score total ' + cls(o.total) + '">' + fmt(o.total) + '</span>' +
              '</div>' +
              '<div class="gauge"><div class="gauge-fill ' + gcls + '" style="width:' + half(o.total) + '%"></div><div class="gauge-center"></div></div></div>';
    }
    const n = data.ballotCount || 0;
    html += '</div><p class="muted" style="font-size:13px;margin-top:12px">Basé sur ' + n + ' bulletin' + (n > 1 ? 's' : '') +
            '. Jauge centrée sur 0 : vert vers la droite (soutien), rouge vers la gauche (rejet). Somme des notes −2…+2 ; égalités au même rang.</p>';
    el.innerHTML = html;
  };

  window.vvStartLive = function (o) {
    const el = document.getElementById(o.containerId);
    if (!el) return;
    async function refresh() {
      try { const r = await fetch(o.url); if (!r.ok) return; window.vvRenderResults(el, await r.json()); } catch (e) { /* silencieux */ }
    }
    setInterval(refresh, o.interval || 5000);
  };
})();
