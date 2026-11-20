// Rendu partagé des résultats (page permalien votant ET page d'admin) :
// une liste complète classée par score, chaque option avec image, note et
// jauge bidirectionnelle. Garantit un affichage identique des deux côtés.
(function () {
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  window.vvRenderResults = function (el, data) {
    if (!el) return;
    const count = function (n) { return '<p class="voter-count"><strong>' + n + '</strong> votant' + (n > 1 ? 's' : '') + '</p>'; };
    if (data.hidden) {
      const t = data.threshold || 0, n = data.ballotCount || 0;
      el.innerHTML = count(n) + '<div class="results-hidden"><p style="margin:0"><strong>Résultats masqués</strong> : il faut au moins ' + t +
        ' votant' + (t > 1 ? 's' : '') + ' pour les afficher (' + n + ' pour l\'instant).</p><p class="muted" style="font-size:13px;margin:6px 0 0">' +
        'Avec si peu de bulletins, les totaux révéleraient comment chacun a voté. Ils s\'afficheront ici automatiquement une fois le seuil atteint.</p></div>';
      return;
    }
    const opts = data.options || [];
    let maxAbs = 1;
    opts.forEach((o) => { if (!o.pending && Math.abs(o.total) > maxAbs) maxAbs = Math.abs(o.total); });
    const rankCount = {};
    opts.forEach((o) => { if (!o.pending) rankCount[o.rank] = (rankCount[o.rank] || 0) + 1; });
    const fmt = (t) => (t > 0 ? '+' + t : String(t));
    const cls = (t) => (t > 0 ? 'pos' : (t < 0 ? 'neg' : ''));
    const half = (t) => (Math.abs(t) / maxAbs * 50).toFixed(1);
    let html = count(data.ballotCount || 0) + '<div class="res-list">';
    for (const o of opts) {
      if (o.pending) {
        const img = o.has_image ? '<img class="res-thumb" src="/options/' + o.id + '/image" alt="">' : '';
        html += '<div class="res-row"><div class="res-head"><span class="res-rank">–</span><div class="res-main">' + img +
          '<div><div class="res-name">' + (o.label ? escapeHtml(o.label) : '(image)') + '</div><div class="res-pending">Choix ajouté récemment : résultat masqué jusqu\'à ' +
          (data.threshold || 0) + ' notes (' + (o.votes_count || 0) + ' pour l\'instant).</div></div></div></div></div>';
        continue;
      }
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
      try { const r = await fetch(o.url); if (!r.ok) return; window.vvRenderResults(el, await r.json()); } catch { /* silencieux */ }
    }
    setInterval(refresh, o.interval || 5000);
  };
})();
