import "server-only";
import { ClientAssertionCredential } from "@azure/identity";
import { getVercelOidcToken } from "@vercel/oidc";

export function createVercelOidcCredential(tenantId: string, clientId: string): ClientAssertionCredential {
  // Keep Vercel's default team audience; Entra validates issuer, subject and audience.
  return new ClientAssertionCredential(tenantId, clientId, () => getVercelOidcToken());
}
