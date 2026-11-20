// Page « API » de l'organisateur : création et révocation de ses jetons.
import { Router } from 'express';
import { requireAuth } from '../auth.js';
import { config } from '../config.js';
import { requireUuidParam } from '../security.js';
import { ServiceError } from '../services/errors.js';
import { createApiToken, listApiTokens, revokeApiToken } from '../services/apiTokens.js';

const router = Router();
router.param('tokenId', requireUuidParam);

async function render(req, res, extra = {}) {
  res.status(extra.status || 200).render('api_tokens', {
    tokens: await listApiTokens(req.user.id),
    apiBase: `${config.baseUrl}/api/v1`,
    created: null, error: null, notice: null,
    ...extra,
  });
}

router.get('/account/api', requireAuth, (req, res) => render(req, res, {
  notice: req.query.revoked === '1' ? 'Jeton révoqué.' : null,
}));

router.post('/account/api/tokens', requireAuth, async (req, res) => {
  try {
    const created = await createApiToken(req.user.id, { name: req.body.name, scope: req.body.scope });
    // Page jamais mise en cache : elle affiche le jeton en clair, une seule fois.
    res.set('Cache-Control', 'no-store');
    await render(req, res, { created, status: 201 });
  } catch (err) {
    if (!(err instanceof ServiceError)) throw err;
    await render(req, res, { error: err.message, status: err.status });
  }
});

router.post('/account/api/tokens/:tokenId/revoke', requireAuth, async (req, res) => {
  await revokeApiToken(req.user.id, req.params.tokenId);
  res.redirect('/account/api?revoked=1');
});

export default router;
