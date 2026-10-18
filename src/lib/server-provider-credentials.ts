import "server-only";
import { EnvironmentCredential, ManagedIdentityCredential, WorkloadIdentityCredential } from "@azure/identity";
import { SecretClient } from "@azure/keyvault-secrets";
import type { CommunicationChannel, CredentialProvider } from "@/types/communications";

type Provider = CredentialProvider;
interface SecretStore {
  getSecret(name: string): Promise<{ value?: string; properties: { enabled?: boolean } }>;
  setSecret(name: string, value: string): Promise<unknown>;
}

export class CredentialStoreError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}

const unavailable = () => new CredentialStoreError(503, "Credential storage is unavailable. An administrator must verify Azure Key Vault configuration and access.");
const references = {
  email: "subtracker-acs-email",
  sms: "subtracker-acs-sms",
} as const;

function reference(provider: Provider, channel: CommunicationChannel): string {
  if (provider === "microsoft_365" && channel === "email") return "subtracker-microsoft-365-email";
  if (provider !== "azure_communication_services" || (channel !== "email" && channel !== "sms")) {
    throw new CredentialStoreError(400, "Unsupported credential provider or channel.");
  }
  return references[channel];
}

function validateCredential(provider: Provider, value: unknown): asserts value is string {
  if (provider === "microsoft_365") {
    if (typeof value !== "string" || !value.trim() || value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value)) {
      throw new CredentialStoreError(400, "Enter a Microsoft 365 application client secret (maximum 4096 characters).");
    }
    return;
  }
  if (typeof value !== "string" || value.length > 4096 ||
      !/^endpoint=https:\/\/[a-z0-9.-]+(?::443)?\/?;accesskey=[a-z0-9+/]+=*;?$/i.test(value)) {
    throw new CredentialStoreError(400, "Enter a valid ACS connection string.");
  }
  const endpoint = new URL(value.slice(value.indexOf("=") + 1, value.indexOf(";")));
  if (!["communication.azure.com", "communication.azure.us", "communication.azure.cn"].some((suffix) => endpoint.hostname.endsWith(`.${suffix}`))) {
    throw new CredentialStoreError(400, "Enter a valid ACS connection string.");
  }
}

function secretMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "SecretNotFound";
}

// The factory allows isolated tests without Azure identities or network access.
export function createCredentialProvider(store: SecretStore) {
  async function read(provider: Provider, channel: CommunicationChannel): Promise<string | null> {
    const name = reference(provider, channel);
    try {
      const secret = await store.getSecret(name);
      if (secret.properties.enabled === false) throw unavailable();
      if (!secret.value) throw unavailable();
      return secret.value;
    } catch (error) {
      if (secretMissing(error)) return null;
      throw unavailable();
    }
  }
  return {
    async getProviderCredential(provider: Provider, channel: CommunicationChannel): Promise<string> {
      const value = await read(provider, channel);
      if (!value) throw new CredentialStoreError(409, "No credential is configured for this channel.");
      return value;
    },
    async setProviderCredential(provider: Provider, channel: CommunicationChannel, credential: unknown): Promise<void> {
      const name = reference(provider, channel);
      validateCredential(provider, credential);
      try { await store.setSecret(name, credential); }
      catch { throw unavailable(); }
    },
    async getProviderCredentialStatus(provider: Provider, channel: CommunicationChannel): Promise<boolean> {
      return (await read(provider, channel)) !== null;
    },
  };
}

function deploymentProvider() {
  const url = process.env.AZURE_KEY_VAULT_URL;
  // Explicit operator release gate; provisioning alone must not enable credential writes.
  if (process.env.SUBTRACKER_KEY_VAULT_ENABLED !== "true" || !url) throw unavailable();
  let vault: URL;
  try { vault = new URL(url); } catch { throw unavailable(); }
  if (vault.protocol !== "https:" || vault.username || vault.password || vault.search || vault.hash ||
      vault.port || vault.pathname !== "/" || !/^[a-z0-9-]+\.vault\.azure\.net$/i.test(vault.hostname)) throw unavailable();
  const mode = process.env.AZURE_KEY_VAULT_AUTH_MODE;
  const credential = mode === "environment" ? new EnvironmentCredential()
    : mode === "workload_identity" ? new WorkloadIdentityCredential()
    : mode === "managed_identity" ? new ManagedIdentityCredential({ clientId: process.env.AZURE_CLIENT_ID })
    : null;
  if (!credential) throw unavailable();
  return createCredentialProvider(new SecretClient(vault.origin, credential, { retryOptions: { maxRetries: 1 } }));
}

export async function getProviderCredential(provider: Provider, channel: CommunicationChannel): Promise<string> {
  try { return await deploymentProvider().getProviderCredential(provider, channel); }
  catch (error) { if (error instanceof CredentialStoreError) throw error; throw unavailable(); }
}
export async function setProviderCredential(provider: Provider, channel: CommunicationChannel, credential: unknown): Promise<void> {
  try { await deploymentProvider().setProviderCredential(provider, channel, credential); }
  catch (error) { if (error instanceof CredentialStoreError) throw error; throw unavailable(); }
}
export async function getProviderCredentialStatus(provider: Provider, channel: CommunicationChannel): Promise<boolean> {
  try { return await deploymentProvider().getProviderCredentialStatus(provider, channel); }
  catch (error) { if (error instanceof CredentialStoreError) throw error; throw unavailable(); }
}
