// SPDX-License-Identifier: MIT
// Shared DNS & DNS-over-HTTPS (DoH / TRR) provider catalog and preference
// synchronization for Argon Onboarding and Native Settings.

export const DNS_PREFS = Object.freeze({
  provider: "argon.dns.provider",
  strict: "argon.dns.strict",
  customUri: "argon.dns.customUri",
  trrMode: "network.trr.mode",
  trrUri: "network.trr.uri",
  trrDefaultUri: "network.trr.default_provider_uri",
  trrCustomUri: "network.trr.custom_uri",
  trrFallbackChecked: "network.trr_ui.fallback_was_checked",
  dohDisableHeuristics: "doh-rollout.disable-heuristics",
});

export const TRR_MODE = Object.freeze({
  DEFAULT: 0,
  STANDARD_FALLBACK: 2,
  STRICT_ONLY: 3,
  OFF: 5,
});

export const DNS_PROVIDERS = Object.freeze([
  Object.freeze({
    id: "system",
    name: "System Default (OS / Router)",
    namePt: "Padrão do Sistema (SO / Roteador)",
    uri: "",
    category: "system",
    description:
      "Uses your operating system or local router DNS resolver without browser-level DoH encryption.",
    descriptionPt:
      "Usa o resolvedor DNS configurado no seu sistema operacional ou roteador local.",
  }),
  Object.freeze({
    id: "quad9",
    name: "Quad9 (Malware Blocking)",
    namePt: "Quad9 (Bloqueio de Malware)",
    uri: "https://dns.quad9.net/dns-query",
    category: "private",
    description:
      "Swiss non-profit no-log encrypted DNS with built-in malicious domain blocking.",
    descriptionPt:
      "DNS criptografado suíço sem registros (no-log) com proteção integrada contra domínios maliciosos.",
  }),
  Object.freeze({
    id: "quad9-unfiltered",
    name: "Quad9 (Unfiltered)",
    namePt: "Quad9 (Sem Filtro)",
    uri: "https://dns10.quad9.net/dns-query",
    category: "private",
    description:
      "Swiss non-profit no-log encrypted DNS without domain filtering or EDNS Client Subnet.",
    descriptionPt:
      "DNS criptografado suíço sem registros, sem filtragem de domínios e sem envio de sub-rede.",
  }),
  Object.freeze({
    id: "mullvad",
    name: "Mullvad DNS",
    namePt: "Mullvad DNS",
    uri: "https://dns.mullvad.net/dns-query",
    category: "private",
    description:
      "Audited Swedish privacy-first encrypted DNS resolver with strict zero-logging policy.",
    descriptionPt:
      "Resolvedor DNS criptografado sueco auditado com política estrita de zero registros.",
  }),
  Object.freeze({
    id: "mullvad-adblock",
    name: "Mullvad DNS (Ad & Tracker Blocking)",
    namePt: "Mullvad DNS (Bloqueio de Anúncios e Rastreadores)",
    uri: "https://adblock.dns.mullvad.net/dns-query",
    category: "private",
    description:
      "Audited Swedish no-log encrypted DNS that also blocks ad and tracker domains at the DNS layer.",
    descriptionPt:
      "DNS criptografado sueco sem registros que bloqueia domínios de anúncios e rastreadores na rede.",
  }),
  Object.freeze({
    id: "cloudflare",
    name: "Cloudflare (1.1.1.1)",
    namePt: "Cloudflare (1.1.1.1)",
    uri: "https://mozilla.cloudflare-dns.com/dns-query",
    category: "fast",
    description:
      "Fast global anycast DNS-over-HTTPS resolver operated by Cloudflare.",
    descriptionPt:
      "Resolvedor DNS sobre HTTPS global de baixa latência operado pela Cloudflare.",
  }),
  Object.freeze({
    id: "adguard",
    name: "AdGuard DNS",
    namePt: "AdGuard DNS",
    uri: "https://dns.adguard-dns.com/dns-query",
    category: "private",
    description:
      "Encrypted DNS-over-HTTPS resolver with network-level ad, tracker, and phishing protection.",
    descriptionPt:
      "Resolvedor DNS sobre HTTPS com bloqueio de anúncios, rastreadores e phishing em nível de rede.",
  }),
  Object.freeze({
    id: "wikimedia",
    name: "Wikimedia DNS",
    namePt: "Wikimedia DNS",
    uri: "https://wikimedia-dns.org/dns-query",
    category: "private",
    description:
      "Non-profit encrypted DNS resolver operated by the Wikimedia Foundation.",
    descriptionPt:
      "Resolvedor DNS criptografado sem fins lucrativos operado pela Fundação Wikimedia.",
  }),
  Object.freeze({
    id: "libredns",
    name: "LibreDNS",
    namePt: "LibreDNS",
    uri: "https://doh.libredns.gr/dns-query",
    category: "private",
    description:
      "Community-operated European encrypted DNS resolver with no logging.",
    descriptionPt:
      "Resolvedor DNS criptografado comunitário europeu sem coleta de registros.",
  }),
  Object.freeze({
    id: "custom",
    name: "Custom DNS-over-HTTPS URL",
    namePt: "URL DNS sobre HTTPS Personalizada",
    uri: "",
    category: "custom",
    description:
      "Specify your own HTTPS DoH endpoint (e.g. NextDNS, Control D, or self-hosted AdGuard Home / Technitium).",
    descriptionPt:
      "Informe seu próprio endpoint HTTPS DoH (ex.: NextDNS, Control D ou servidor próprio).",
  }),
]);

export const DEFAULT_DNS_PROVIDER = "system";

function readStr(prefs, key, fallback = "") {
  if (!prefs?.getStringPref) return fallback;
  try {
    const val = prefs.getStringPref(key, fallback);
    return val !== undefined && val !== null ? String(val) : fallback;
  } catch {
    try {
      return String(prefs.getStringPref(key));
    } catch {
      return fallback;
    }
  }
}

function writeStr(prefs, key, value) {
  if (!prefs?.setStringPref) return;
  try {
    prefs.setStringPref(key, String(value ?? ""));
  } catch {}
}

function readBool(prefs, key, fallback = false) {
  if (!prefs?.getBoolPref) return fallback;
  try {
    return Boolean(prefs.getBoolPref(key, fallback));
  } catch {
    try {
      return Boolean(prefs.getBoolPref(key));
    } catch {
      return fallback;
    }
  }
}

function writeBool(prefs, key, value) {
  if (!prefs?.setBoolPref) return;
  try {
    prefs.setBoolPref(key, Boolean(value));
  } catch {}
}

function readInt(prefs, key, fallback = TRR_MODE.OFF) {
  if (typeof prefs?.getIntPref === "function") {
    try {
      return Number(prefs.getIntPref(key, fallback));
    } catch {
      try {
        return Number(prefs.getIntPref(key));
      } catch {}
    }
  }
  const asStr = readStr(prefs, key, "");
  if (asStr !== "" && Number.isFinite(Number(asStr))) {
    return Number(asStr);
  }
  return fallback;
}

function writeInt(prefs, key, value) {
  const intVal = Math.trunc(Number(value));
  if (typeof prefs?.setIntPref === "function") {
    try {
      prefs.setIntPref(key, intVal);
      return;
    } catch {}
  }
  writeStr(prefs, key, String(intVal));
}

export function normalizeDnsProviderId(providerId) {
  const normalized = String(providerId || "").trim().toLowerCase();
  return DNS_PROVIDERS.some((p) => p.id === normalized)
    ? normalized
    : DEFAULT_DNS_PROVIDER;
}

export function isValidDohUri(uri) {
  const trimmed = String(uri || "").trim();
  if (!trimmed.startsWith("https://")) return false;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === "https:" && Boolean(parsed.hostname) &&
      !parsed.username && !parsed.password && !parsed.hash;
  } catch {
    return false;
  }
}

export function findDnsProviderByUri(uri) {
  const clean = String(uri || "").trim().toLowerCase();
  if (!clean) return null;
  return (
    DNS_PROVIDERS.find(
      (p) => p.uri && p.uri.toLowerCase() === clean
    ) ?? null
  );
}

export function getDnsProviderDescriptor(providerId) {
  const id = normalizeDnsProviderId(providerId);
  return DNS_PROVIDERS.find((p) => p.id === id) ?? DNS_PROVIDERS[0];
}

export function getDnsConfig(prefs) {
  const trrMode = readInt(prefs, DNS_PREFS.trrMode, TRR_MODE.OFF);
  const trrUri = readStr(prefs, DNS_PREFS.trrUri, "").trim();
  const savedCustom =
    readStr(prefs, DNS_PREFS.customUri, "").trim() ||
    readStr(prefs, DNS_PREFS.trrCustomUri, "").trim();
  const explicitProvider = readStr(prefs, DNS_PREFS.provider, "").trim().toLowerCase();

  let providerId = DEFAULT_DNS_PROVIDER;
  if (trrMode === TRR_MODE.STANDARD_FALLBACK || trrMode === TRR_MODE.STRICT_ONLY) {
    const matched = findDnsProviderByUri(trrUri);
    if (matched) {
      providerId = matched.id;
    } else if (trrUri) {
      providerId = "custom";
    } else if (explicitProvider && DNS_PROVIDERS.some((p) => p.id === explicitProvider)) {
      providerId = explicitProvider;
    }
  } else if (explicitProvider && DNS_PROVIDERS.some((p) => p.id === explicitProvider)) {
    // Only trust explicit non-system provider when trrMode hasn't been explicitly turned off
    if (explicitProvider === "system") {
      providerId = "system";
    }
  }

  // Retain a custom endpoint draft while the previously active resolver remains in use.
  if (explicitProvider === "custom" && !isValidDohUri(savedCustom)) {
    providerId = "custom";
  }

  const strict = trrMode === TRR_MODE.STRICT_ONLY ? true
    : trrMode === TRR_MODE.STANDARD_FALLBACK ? false
    : readBool(prefs, DNS_PREFS.strict, false);

  const customUri =
    providerId === "custom" && trrUri && !(explicitProvider === "custom" && !isValidDohUri(savedCustom))
      ? trrUri
      : savedCustom;

  return {
    providerId,
    strict,
    customUri,
    mode: trrMode,
    activeUri: providerId === "system" ? "" : (trrUri || getDnsProviderDescriptor(providerId).uri || customUri),
  };
}

export function applyDnsConfig(
  prefs,
  { providerId = DEFAULT_DNS_PROVIDER, strict = false, customUri = undefined } = {}
) {
  const normalizedId = normalizeDnsProviderId(providerId);
  const descriptor = getDnsProviderDescriptor(normalizedId);
  const isStrict = Boolean(strict);

  const existingCustom =
    customUri !== undefined
      ? String(customUri || "").trim()
      : readStr(prefs, DNS_PREFS.customUri, "").trim() ||
        readStr(prefs, DNS_PREFS.trrCustomUri, "").trim();

  writeStr(prefs, DNS_PREFS.provider, normalizedId);
  writeBool(prefs, DNS_PREFS.strict, isStrict);
  if (customUri !== undefined) {
    writeStr(prefs, DNS_PREFS.customUri, existingCustom);
  }

  if (normalizedId === "system") {
    writeInt(prefs, DNS_PREFS.trrMode, TRR_MODE.OFF);
    writeBool(prefs, DNS_PREFS.trrFallbackChecked, false);
    return {
      providerId: "system",
      strict: isStrict,
      customUri: existingCustom,
      mode: TRR_MODE.OFF,
      activeUri: "",
    };
  }

  let resolvedUri = descriptor.uri;
  if (normalizedId === "custom") {
    if (isValidDohUri(existingCustom)) {
      resolvedUri = existingCustom;
    } else {
      // Keep custom selected in UI state, wait until valid HTTPS URI before switching trrUri
      writeStr(prefs, DNS_PREFS.trrCustomUri, existingCustom);
      return {
        providerId: "custom",
        strict: isStrict,
        customUri: existingCustom,
        mode: readInt(prefs, DNS_PREFS.trrMode, TRR_MODE.OFF),
        activeUri: existingCustom,
      };
    }
  }

  const targetMode = isStrict ? TRR_MODE.STRICT_ONLY : TRR_MODE.STANDARD_FALLBACK;
  writeInt(prefs, DNS_PREFS.trrMode, targetMode);
  writeStr(prefs, DNS_PREFS.trrUri, resolvedUri);
  writeStr(prefs, DNS_PREFS.trrDefaultUri, resolvedUri);
  if (normalizedId === "custom") {
    writeStr(prefs, DNS_PREFS.trrCustomUri, resolvedUri);
  }
  writeBool(prefs, DNS_PREFS.trrFallbackChecked, isStrict);
  writeBool(prefs, DNS_PREFS.dohDisableHeuristics, true);

  return {
    providerId: normalizedId,
    strict: isStrict,
    customUri: existingCustom,
    mode: targetMode,
    activeUri: resolvedUri,
  };
}
