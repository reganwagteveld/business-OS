// Public API of the identity module (architecture §5.2, §7.1). Routes and other modules import
// only from here; nothing outside this module touches Better Auth or the bos_auth client.
export { getCurrentUser, getSessionToken, requireUser, UnauthenticatedError } from './server/session';
export type { CurrentUser } from './server/session';
export { classifyAuthRequest, handleAuthRequest } from './server/handler';
export type { AuthRequestMode } from './server/handler';
export { authorizeDesktop, confirmDesktop, exchangeDesktopCode } from './server/desktop';
