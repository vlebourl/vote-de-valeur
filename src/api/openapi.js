// Spécification OpenAPI 3.1 de l'API des organisateurs, servie sur
// /api/v1/openapi.json et lue par la page /api/docs.
const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema, description) => ({ description, content: { 'application/json': { schema } } });
const error = (description) => ({ description, content: { 'application/json': { schema: ref('Error') } } });

const pollId = { name: 'pollId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } };
const optionId = { name: 'optionId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } };

const common = {
  401: error('Jeton absent, invalide ou révoqué.'),
  429: error('Limite de débit atteinte.'),
};
const forPoll = { ...common, 404: error('Scrutin introuvable (ou appartenant à un autre organisateur).') };
const writes = {
  403: error('Jeton en lecture seule.'),
  415: error('Content-Type non pris en charge (JSON attendu).'),
};

export function openapi(baseUrl) {
  return {
    openapi: '3.1.0',
    info: {
      title: 'Vote de valeur — API',
      version: '1.0.0',
      description: [
        'Créer et gérer des **votes de valeur** (chaque option notée de −2 à +2, classement à la somme) depuis un script.',
        '',
        '**Authentification** : créez un jeton dans votre compte (menu *API*) puis envoyez-le dans l’en-tête',
        '`Authorization: Bearer vdv_…`. Un jeton `read` ne peut que lire (GET, HEAD) ; un jeton `write` peut tout faire.',
        'Les corps de requête sont en JSON (`Content-Type: application/json`), sauf les images d’options (multipart).',
        '',
        '**Vote** : l’API ne permet pas de voter. Chaque votant vote par son lien personnel, reçu par email',
        '(voir `POST /polls/{pollId}/invitations`) ou obtenu sur la page du vote : un email = un vote, et le',
        'secret du bulletin est préservé.',
        '',
        '**Erreurs** : réponse JSON `{ "error": { "code", "message" } }`.',
        '**Limites** : 600 requêtes par 15 minutes et par jeton ; 100 destinataires par envoi d’invitations et',
        '500 invitations par heure et par organisateur, tous jetons confondus.',
      ].join('\n'),
      license: { name: 'MIT', url: 'https://opensource.org/licenses/MIT' },
    },
    servers: [{ url: `${baseUrl || ''}/api/v1` }],
    security: [{ bearer: [] }],
    tags: [
      { name: 'Compte' }, { name: 'Scrutins' }, { name: 'Options' }, { name: 'Résultats' }, { name: 'Votants' },
    ],
    paths: {
      '/me': {
        get: {
          tags: ['Compte'], summary: 'Organisateur et portée du jeton', operationId: 'getMe',
          responses: { 200: json(ref('Me'), 'Organisateur authentifié.'), ...common },
        },
      },
      '/polls': {
        get: {
          tags: ['Scrutins'], summary: 'Lister ses scrutins', operationId: 'listPolls',
          responses: {
            200: json({ type: 'object', required: ['polls'], properties: { polls: { type: 'array', items: ref('Poll') } } }, 'Scrutins, du plus récent au plus ancien.'),
            ...common,
          },
        },
        post: {
          tags: ['Scrutins'], summary: 'Créer un scrutin', operationId: 'createPoll',
          requestBody: { required: true, content: { 'application/json': { schema: ref('PollCreate') } } },
          responses: {
            201: json(ref('PollDetail'), 'Scrutin créé (en-tête Location).'),
            400: error('Données invalides.'), 413: error('Corps trop volumineux (100 Ko).'), ...writes, ...common,
          },
        },
      },
      '/polls/{pollId}': {
        parameters: [pollId],
        get: {
          tags: ['Scrutins'], summary: 'Détail d’un scrutin', operationId: 'getPoll',
          responses: { 200: json(ref('PollDetail'), 'Scrutin, options et participation.'), ...forPoll },
        },
        patch: {
          tags: ['Scrutins'], summary: 'Modifier, clôturer ou rouvrir un scrutin', operationId: 'updatePoll',
          requestBody: { required: true, content: { 'application/json': { schema: ref('PollUpdate') } } },
          responses: { 200: json(ref('PollDetail'), 'Scrutin modifié.'), 400: error('Données invalides.'), ...writes, ...forPoll },
        },
        delete: {
          tags: ['Scrutins'], summary: 'Supprimer un scrutin et tous ses bulletins', operationId: 'deletePoll',
          responses: { 204: { description: 'Supprimé.' }, ...writes, ...forPoll },
        },
      },
      '/polls/{pollId}/options': {
        parameters: [pollId],
        post: {
          tags: ['Options'], summary: 'Ajouter une option', operationId: 'addOption',
          description: 'JSON pour une option texte ; multipart/form-data pour joindre une image (PNG, JPEG, WebP, GIF ; 3 Mo).',
          requestBody: {
            required: true,
            content: {
              'application/json': { schema: ref('OptionInput') },
              'multipart/form-data': {
                schema: {
                  type: 'object',
                  properties: {
                    label: { type: 'string', maxLength: 200 },
                    description: { type: 'string', maxLength: 1000 },
                    image: { type: 'string', format: 'binary' },
                  },
                },
              },
            },
          },
          responses: {
            201: json(ref('Option'), 'Option ajoutée.'),
            400: error('Données invalides.'), 409: error('Nombre maximal d’options atteint (50).'),
            413: error('Image trop volumineuse.'), ...writes, ...forPoll,
          },
        },
      },
      '/polls/{pollId}/options/{optionId}': {
        parameters: [pollId, optionId],
        patch: {
          tags: ['Options'], summary: 'Modifier le texte d’une option', operationId: 'updateOption',
          requestBody: { required: true, content: { 'application/json': { schema: ref('OptionInput') } } },
          responses: { 200: json(ref('Option'), 'Option modifiée.'), 400: error('Données invalides.'), ...writes, ...forPoll },
        },
        delete: {
          tags: ['Options'], summary: 'Supprimer une option (ses notes sont retirées des bulletins)', operationId: 'deleteOption',
          responses: { 204: { description: 'Supprimée.' }, 409: error('Un scrutin garde au moins 2 options.'), ...writes, ...forPoll },
        },
      },
      '/polls/{pollId}/options/{optionId}/image': {
        parameters: [pollId, optionId],
        put: {
          tags: ['Options'], summary: 'Ajouter ou remplacer l’image d’une option', operationId: 'setOptionImage',
          requestBody: {
            required: true,
            content: { 'multipart/form-data': { schema: { type: 'object', required: ['image'], properties: { image: { type: 'string', format: 'binary', description: 'PNG, JPEG, WebP ou GIF ; 3 Mo au plus.' } } } } },
          },
          responses: {
            200: json(ref('Option'), 'Image enregistrée.'),
            400: error('Image absente ou format non pris en charge.'), 413: error('Image trop volumineuse.'),
            ...writes, ...forPoll,
          },
        },
      },
      '/polls/{pollId}/results': {
        parameters: [pollId],
        get: {
          tags: ['Résultats'], summary: 'Résultats en temps réel', operationId: 'getResults',
          responses: { 200: json(ref('Results'), 'Classement à la somme des notes, ex æquo au même rang.'), ...forPoll },
        },
      },
      '/polls/{pollId}/participants': {
        parameters: [pollId],
        get: {
          tags: ['Votants'], summary: 'Participants et votes individuels (scrutin nominatif)', operationId: 'listParticipants',
          responses: {
            200: json({ type: 'object', required: ['participants'], properties: { participants: { type: 'array', items: ref('Participant') } } }, 'Participants.'),
            409: error('Scrutin secret : aucun détail individuel.'), ...forPoll,
          },
        },
      },
      '/polls/{pollId}/notifications': {
        parameters: [pollId],
        post: {
          tags: ['Votants'], summary: 'Prévenir les votants des choix ajoutés depuis leur vote', operationId: 'notifyVoters',
          description: 'Envoie un avis aux votants qui ont coché « Prévenez-moi si un choix est ajouté » et qui ont au moins un choix ajouté depuis leur vote, pas encore signalé. Chacun reçoit un lien personnel supplémentaire (son lien précédent reste valable) pour noter ces choix ; ses autres notes restent inchangées. La réponse ne contient que des nombres, jamais d’adresse. Corps : objet JSON vide.',
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', additionalProperties: false } } } },
          responses: {
            200: json({ type: 'object', properties: { eligible: { type: 'integer' }, sent: { type: 'integer' }, failed: { type: 'integer' }, remaining: { type: 'integer', description: 'Votants encore à prévenir (quota atteint, échec d’envoi) : relancer plus tard.' } } }, 'Avis envoyés.'),
            409: error('Vote clôturé.'), ...writes, ...forPoll,
          },
        },
      },
      '/polls/{pollId}/invitations': {
        parameters: [pollId],
        post: {
          tags: ['Votants'], summary: 'Envoyer leur lien de vote à des votants', operationId: 'sendInvitations',
          description: 'Scrutin « email » ouvert uniquement. Chaque envoi crée un nouveau lien qui remplace le précédent (sauf échec d’envoi). Adresses nues uniquement (pas de « Nom <adresse> »). 100 destinataires par requête.',
          requestBody: { required: true, content: { 'application/json': { schema: ref('InvitationRequest') } } },
          responses: {
            200: json(ref('InvitationResult'), 'Au moins une invitation envoyée. Une personne ayant déjà voté n’est pas relancée (raison already_voted).'),
            422: json(ref('InvitationResult'), 'Aucune invitation envoyée.'),
            400: error('Données invalides.'), 409: error('Scrutin clôturé ou en mode « nom ».'), ...writes, ...forPoll,
          },
        },
      },
    },
    components: {
      securitySchemes: { bearer: { type: 'http', scheme: 'bearer', description: 'Jeton « vdv_… » créé dans le menu API.' } },
      schemas: {
        Error: {
          type: 'object', required: ['error'],
          properties: { error: { type: 'object', required: ['code', 'message'], properties: { code: { type: 'string' }, message: { type: 'string' } } } },
        },
        Me: {
          type: 'object',
          properties: {
            user: { type: 'object', properties: { id: { type: 'string', format: 'uuid' }, email: { type: 'string' } } },
            token: { type: 'object', properties: { scope: { enum: ['read', 'write'] } } },
          },
        },
        Poll: {
          type: 'object',
          required: ['id', 'title', 'status', 'is_closed', 'auth_mode', 'vote_url'],
          properties: {
            id: { type: 'string', format: 'uuid' },
            title: { type: 'string' },
            description: { type: 'string' },
            status: { enum: ['open', 'closed'], description: 'Statut choisi par l’organisateur.' },
            is_closed: { type: 'boolean', description: 'Clos par statut ou par date de clôture dépassée.' },
            is_private: { type: 'boolean' },
            is_nominative: { type: 'boolean' },
            auth_mode: { enum: ['email', 'name'] },
            close_at: { type: ['string', 'null'], format: 'date-time' },
            min_ballots_for_results: { type: 'integer', description: 'Résultats masqués tant que le scrutin compte moins de bulletins (0 = toujours visibles).' },
            created_at: { type: 'string', format: 'date-time' },
            vote_url: { type: 'string', format: 'uri', description: 'Lien à diffuser aux votants.' },
            manage_url: { type: 'string', format: 'uri' },
            ballot_count: { type: 'integer' },
          },
        },
        PollDetail: {
          allOf: [ref('Poll'), {
            type: 'object',
            properties: {
              options: { type: 'array', items: ref('Option') },
              participation: ref('Participation'),
            },
          }],
        },
        PollCreate: {
          type: 'object', required: ['title', 'options'], additionalProperties: false,
          properties: {
            title: { type: 'string', maxLength: 200 },
            description: { type: 'string', maxLength: 5000 },
            options: {
              type: 'array', minItems: 2, maxItems: 50,
              items: { oneOf: [{ type: 'string', maxLength: 200 }, ref('OptionInput')] },
              description: 'Intitulés, ou objets { label, description }. Les images s’ajoutent ensuite par PUT /polls/{pollId}/options/{optionId}/image.',
            },
            auth_mode: { enum: ['email', 'name'], default: 'email' },
            is_private: { type: 'boolean', default: false },
            password: { type: 'string', minLength: 4, maxLength: 200, description: 'Obligatoire si is_private.' },
            is_nominative: { type: 'boolean', default: false },
            close_at: { type: ['string', 'null'], format: 'date-time', description: 'ISO 8601 avec fuseau.' },
            min_ballots_for_results: {
              type: 'integer', minimum: 0, maximum: 10000, default: 5,
              description: 'Résultats masqués (votants comme organisateur) tant que le scrutin compte moins de bulletins : avec 1 ou 2 bulletins, les totaux révéleraient ces votes. En scrutin nominatif, le seuil ne vaut que pour les votants.',
            },
          },
          example: {
            title: 'Destination du séminaire',
            options: ['Annecy', 'Lyon', { label: 'Bordeaux', description: 'Vignobles, océan à 1 h' }],
            close_at: '2026-12-15T18:00:00+01:00',
          },
        },
        PollUpdate: {
          type: 'object', additionalProperties: false,
          properties: {
            title: { type: 'string', maxLength: 200 },
            description: { type: 'string', maxLength: 5000 },
            close_at: { type: ['string', 'null'], format: 'date-time', description: 'null pour retirer la clôture automatique.' },
            status: { enum: ['open', 'closed'] },
            is_nominative: { type: 'boolean', description: 'Passer en nominatif ne dé-anonymise pas les bulletins déjà déposés.' },
            min_ballots_for_results: { type: 'integer', minimum: 0, maximum: 10000 },
          },
        },
        Option: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            label: { type: 'string' },
            description: { type: 'string' },
            position: { type: 'integer' },
            has_image: { type: 'boolean' },
            image_url: { type: ['string', 'null'], format: 'uri' },
          },
        },
        OptionInput: {
          type: 'object', additionalProperties: false,
          properties: { label: { type: 'string', maxLength: 200 }, description: { type: 'string', maxLength: 1000 } },
        },
        Participation: {
          type: 'object',
          properties: {
            requested: { type: 'integer', description: 'Votants inscrits (lien demandé ou envoyé).' },
            voted: { type: 'integer' },
          },
        },
        Results: {
          type: 'object',
          properties: {
            poll_id: { type: 'string', format: 'uuid' },
            is_closed: { type: 'boolean' },
            ballot_count: { type: 'integer' },
            results_hidden: { type: 'boolean', description: 'Seuil de publication non atteint : options vide.' },
            min_ballots_for_results: { type: 'integer' },
            participation: ref('Participation'),
            options: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string', format: 'uuid' },
                  label: { type: 'string' },
                  description: { type: 'string' },
                  total: { type: ['integer', 'null'], description: 'Somme des notes (−2…+2), abstention = 0 ; null si pending.' },
                  rank: { type: ['integer', 'null'], description: 'Rang « 1224 » : ex æquo au même rang ; null si pending.' },
                  ballots: { type: 'integer', description: 'Bulletins portant une note pour cette option.' },
                  has_image: { type: 'boolean' },
                  pending: { type: 'boolean', description: 'Choix noté par moins de votants que le seuil (ajouté après des votes) : total et rang masqués (null).' },
                },
              },
            },
          },
        },
        Participant: {
          type: 'object',
          properties: {
            email: { type: ['string', 'null'] },
            name: { type: ['string', 'null'] },
            voted: { type: 'boolean' },
            anonymous: { type: 'boolean', description: 'A voté avant le passage en nominatif : bulletin non relié.' },
            scores: { type: ['object', 'null'], additionalProperties: { type: 'integer' }, description: 'Note par identifiant d’option.' },
          },
        },
        InvitationRequest: {
          type: 'object', required: ['recipients'], additionalProperties: false,
          properties: {
            recipients: {
              type: 'array', minItems: 1, maxItems: 100,
              items: {
                oneOf: [
                  { type: 'string', format: 'email' },
                  { type: 'object', required: ['email'], properties: { email: { type: 'string', format: 'email' }, name: { type: 'string', description: 'Conservé seulement en scrutin nominatif.' } } },
                ],
              },
            },
          },
          example: { recipients: ['alice@example.org', { email: 'bob@example.org', name: 'Bob' }] },
        },
        InvitationResult: {
          type: 'object',
          properties: {
            sent: { type: 'array', items: { type: 'string' } },
            rejected: {
              type: 'array',
              items: { type: 'object', properties: { email: { type: ['string', 'null'] }, reason: { enum: ['invalid_email', 'duplicate', 'already_voted', 'send_failed'] } } },
            },
          },
        },
      },
    },
  };
}
