/**
 * The secret rail. A commit made in Extendo must never be able to carry a credential, so a path is
 * refused before it can be staged — with a reason the person can read, and one deliberate way past
 * it (an explicit, named confirmation) for the cases the list gets wrong.
 */
export interface SecretRule {
  /** Why Extendo refuses, in one sentence a person can act on. */
  reason: string;
  test: (path: string, name: string) => boolean;
}

const TEMPLATE = /^\.env\.(?:example|sample|template|dist)$/i;

const rules: SecretRule[] = [
  {
    reason: 'environment files hold credentials; only .env.example-style templates are allowed',
    test: (_path, name) => /^\.env(?:$|\.)/i.test(name) && !TEMPLATE.test(name),
  },
  {
    reason: 'this file stores registry or host credentials',
    test: (_path, name) => /^\.(?:npmrc|pypirc|netrc|git-credentials|htpasswd)$/i.test(name),
  },
  {
    reason: 'this is a private key',
    test: (_path, name) => /^id_(?:rsa|dsa|ecdsa|ed25519)$/i.test(name) || /\.(?:pem|key|p12|pfx|keystore|jks|asc)$/i.test(name),
  },
  {
    reason: 'this is a private certificate store or key directory',
    test: (path) => /(?:^|\/)(?:\.ssh|\.gnupg|\.aws|\.azure|\.kube)\//i.test(path),
  },
  {
    reason: 'this file holds provider credentials',
    test: (_path, name) => /^(?:credentials|service-account|serviceaccount)(?:[-_.].*)?\.json$/i.test(name) || /^secrets?\.(?:json|ya?ml|toml)$/i.test(name),
  },
  {
    reason: 'this is a database of secrets',
    test: (_path, name) => /\.(?:kdbx|keychain|keychain-db)$/i.test(name),
  },
];

/** The reason Extendo refuses to stage a path, or undefined when the path is safe. */
export function secretReason(path: string): string | undefined {
  const normalized = path.replaceAll('\\', '/');
  const name = normalized.split('/').at(-1) ?? normalized;
  return rules.find((rule) => rule.test(normalized, name))?.reason;
}
