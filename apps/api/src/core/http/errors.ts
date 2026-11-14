import 'server-only';
// Errors a service may throw on purpose. The route wrappers turn each into one generic, stable
// response, so no service builds HTTP responses and no detail leaks (architecture §7.3).

/** The record does not exist in this business (or is not visible to it): always 404. */
export class RecordNotFoundError extends Error {
  readonly status = 404;
  constructor() {
    super('not_found');
    this.name = 'RecordNotFoundError';
  }
}

/** The request is well-formed but not allowed in the record's current state (e.g. editing an archived customer): 409. */
export class StateConflictError extends Error {
  readonly status = 409;
  constructor(readonly code: 'archived' | 'not_archived' | 'archived_reference' | 'not_open' | 'not_closed') {
    super(code);
    this.name = 'StateConflictError';
  }
}

/** A business rule the contract schema cannot express was broken: 400 with a safe, human message. */
export class RuleViolationError extends Error {
  readonly status = 400;
  constructor(readonly code: string, readonly detail: string) {
    super(code);
    this.name = 'RuleViolationError';
  }
}
