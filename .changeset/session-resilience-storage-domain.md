---
'@segment/analytics-next': patch
---

fix(conversion-collector): make the cookie-backed session survive blocked storage, subdomain hops and a missing activity stamp

- adds an in-memory tier so a page load keeps one `context.sessionId` when cookies and localStorage are both unavailable (Safari private/ITP, third-party iframe, CMP before consent) instead of minting a new id per event
- adds the optional `sessionCookieDomain` init option so the session survives subdomain navigation; the legacy host-only cookies are dropped once per page load, after the current session is read
- keeps a valid session id when only its `lastActivity` stamp is missing, instead of rotating
- validates the host-supplied `getSessionId` override against UUID v4 (the collector rejects anything else with `invalid_session_id`) and never lets it throw an event through without a session
