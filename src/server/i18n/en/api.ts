// Errors the HTTP API answers with.

export const api = {
  badSessionIcon: 'Invalid session icon request',
  sessionIconsFull: (max: number) => `Up to ${max} session icons can be kept — reset some to the first letter first`,
};
