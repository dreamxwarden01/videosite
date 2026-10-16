# Client signing keys

VideoSite publishes its OIDC verification keys at `/.well-known/jwks.json`.
Successful GET responses use `Cache-Control: public, max-age=120, must-revalidate`.
Other methods, including HEAD, return 405 with `Allow: GET`; errors are not cached.
The endpoint requires no login or client certificate.

In SSO settings, **Rotate** schedules a new signing key. It is published first,
while the current key keeps signing. After at least five minutes, the next
signing or key-status request activates it. The UI shows the pending operation
and checks it with GET. A retry while pending returns the same operation; after
an uncertain response, check status before submitting another rotation.

The old public key remains available for 24 hours from activation. That overlap
covers current assertions/events, which last at most two minutes. It does not
make emergency revocation instantaneous: verifiers maintain their own caches.

## Persistence and deployment

Before the first explicit rotation, VideoSite uses its existing client-key file.
Scheduling imports that verified identity and the pending key into the dedicated
`oidc_client_signing_state` MariaDB row. The file is left unchanged, including
when mounted as a single file. Subsequent signing, status and publication reads
use the database directly. Database or decryption errors never fall back to the
old file. The state is encrypted with `SETTINGS_SECRET_ENCRYPTION_KEY`, with an
authenticated purpose and revision; back up this key together with the database.

Publication and the activation marker are committed separately. A restart after
publication recovers the same pending operation and gives it the full window.
Concurrent schedules and activations serialize on the singleton row. Database
UTC time defines deadlines independently of the client's time-zone settings.

Deploy the schema migration and staged implementation to every writer before
rotating. Returning to a file-only build after database authority is established
is not a supported signing-key rollback. Verify caches respect the origin's
120-second freshness and `must-revalidate`, including `Age` through any cache
hierarchy; drain older or overridden cache policies first. The five-minute
window includes the SSO's bounded key caches and refresh cooldown, not arbitrary
third-party caching. Inline JWKS registrations need separate operator updates.
