// Erreur métier : un code stable (utilisé par l'API), un message lisible
// (affiché dans les pages) et le statut HTTP correspondant.
export class ServiceError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export const notFound = (message = 'Vote introuvable.') => new ServiceError('not_found', message, 404);
export const forbidden = (message = 'Accès refusé.') => new ServiceError('forbidden', message, 403);
export const invalid = (message) => new ServiceError('validation_error', message, 400);
export const conflict = (message) => new ServiceError('conflict', message, 409);
