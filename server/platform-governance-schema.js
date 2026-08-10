export const MAX_PLATFORM_CONFIRMATIONS = 20;
export const MAX_PLATFORM_NAME_CHARS = 80;
export const MAX_PLATFORM_REFERENCE_URL_CHARS = 2_048;
export const MAX_PLATFORM_CONTRACT_REFERENCE_CHARS = 500;
export const PLATFORM_CONFIRMATION_REVIEW_DAYS = 30;
export const PLATFORM_CONFIRMATION_ID_PATTERN = /^platform_[0-9a-f]{32}$/;
export const PLATFORM_API_STATUSES = Object.freeze([
  'not-found', 'not-authorized', 'authorized',
]);

export const PLATFORM_SYNC_POLICY = Object.freeze({
  mode: 'manual-only',
  automaticSyncAvailable: false,
  allowedIntegration: 'official-authorized-api-only',
  prohibitedMethods: Object.freeze([
    'login-automation', 'captcha-bypass', 'platform-restriction-bypass',
  ]),
});

function fail(code) { throw new Error(code); }

function boundedText(value, maxChars, code, { required = true } = {}) {
  if (typeof value !== 'string') return fail(code);
  const text = value.trim();
  if ((required && !text) || text.length > maxChars || /[\u0000-\u001f\u007f]/u.test(text)) {
    return fail(code);
  }
  return text;
}

function officialReferenceUrl(value, code, { required = true } = {}) {
  const text = boundedText(value ?? '', MAX_PLATFORM_REFERENCE_URL_CHARS, code, { required });
  if (!text) return '';
  let url;
  try { url = new URL(text); }
  catch { return fail(code); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return fail(code);
  return url.toString();
}

function validIsoDate(value) {
  return typeof value === 'string'
    && value.length <= 100
    && Number.isFinite(Date.parse(value));
}

export function normalizePlatformConfirmation(value, {
  errorCode = 'BAD_PLATFORM_CONFIRMATION',
} = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail(errorCode);
  if (typeof value.id !== 'string' || !PLATFORM_CONFIRMATION_ID_PATTERN.test(value.id)) {
    return fail(errorCode);
  }
  if (!validIsoDate(value.checkedAt)) return fail(errorCode);
  const officialApiStatus = PLATFORM_API_STATUSES.includes(value.officialApiStatus)
    ? value.officialApiStatus
    : fail(errorCode);
  const apiDocsUrl = officialReferenceUrl(value.apiDocsUrl ?? '', errorCode, {
    required: officialApiStatus === 'authorized',
  });
  const confirmations = value.confirmations;
  if (!confirmations || typeof confirmations !== 'object' || Array.isArray(confirmations)
    || confirmations.rules !== true
    || confirmations.aiPolicy !== true
    || confirmations.contract !== true
    || confirmations.noBypass !== true) return fail(errorCode);
  return {
    id: value.id,
    platform: boundedText(value.platform, MAX_PLATFORM_NAME_CHARS, errorCode),
    rulesUrl: officialReferenceUrl(value.rulesUrl, errorCode),
    aiPolicyUrl: officialReferenceUrl(value.aiPolicyUrl, errorCode),
    contractReference: boundedText(
      value.contractReference, MAX_PLATFORM_CONTRACT_REFERENCE_CHARS, errorCode,
    ),
    officialApiStatus,
    apiDocsUrl,
    confirmations: { rules: true, aiPolicy: true, contract: true, noBypass: true },
    checkedAt: value.checkedAt,
  };
}

export function normalizePlatformConfirmations(value, options = {}) {
  const errorCode = options.errorCode ?? 'BAD_PLATFORM_CONFIRMATION';
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_PLATFORM_CONFIRMATIONS) return fail(errorCode);
  const ids = new Set();
  const platforms = new Set();
  return value.map((item) => {
    const normalized = normalizePlatformConfirmation(item, { errorCode });
    const platformKey = normalized.platform.toLocaleLowerCase('zh-CN');
    if (ids.has(normalized.id) || platforms.has(platformKey)) return fail(errorCode);
    ids.add(normalized.id);
    platforms.add(platformKey);
    return normalized;
  });
}

export function normalizePlatformConfirmationInput(value, { id, checkedAt } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return fail('BAD_PLATFORM_CONFIRMATION');
  }
  return normalizePlatformConfirmation({
    ...value,
    id,
    checkedAt,
    confirmations: {
      rules: value.confirmRules,
      aiPolicy: value.confirmAiPolicy,
      contract: value.confirmContract,
      noBypass: value.confirmNoBypass,
    },
  });
}

export function platformConfirmationReviewState(record, now = new Date()) {
  const checkedAt = Date.parse(record.checkedAt);
  const expiresAt = checkedAt + PLATFORM_CONFIRMATION_REVIEW_DAYS * 24 * 60 * 60 * 1000;
  return {
    reviewStatus: now.getTime() <= expiresAt ? 'current' : 'stale',
    reviewAfter: new Date(expiresAt).toISOString(),
  };
}

export function platformSyncGate(record, now = new Date()) {
  const review = platformConfirmationReviewState(record, now);
  const eligibleForFutureIntegration = review.reviewStatus === 'current'
    && record.officialApiStatus === 'authorized'
    && Boolean(record.apiDocsUrl)
    && record.confirmations.noBypass === true;
  return {
    automaticSyncAvailable: false,
    eligibleForFutureIntegration,
    reason: eligibleForFutureIntegration
      ? 'OFFICIAL_API_REVIEW_REQUIRED_BEFORE_IMPLEMENTATION'
      : review.reviewStatus === 'stale'
        ? 'PLATFORM_CONFIRMATION_STALE'
        : record.officialApiStatus === 'not-found'
          ? 'OFFICIAL_API_NOT_FOUND'
          : record.officialApiStatus === 'not-authorized'
            ? 'OFFICIAL_API_NOT_AUTHORIZED'
            : 'OFFICIAL_API_EVIDENCE_INCOMPLETE',
  };
}

export function platformGovernanceView(records, now = new Date()) {
  const confirmations = normalizePlatformConfirmations(records).map((record) => ({
    ...record,
    ...platformConfirmationReviewState(record, now),
    syncGate: platformSyncGate(record, now),
  }));
  return {
    confirmations,
    syncPolicy: {
      ...PLATFORM_SYNC_POLICY,
      prohibitedMethods: [...PLATFORM_SYNC_POLICY.prohibitedMethods],
    },
  };
}
