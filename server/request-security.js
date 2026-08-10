import { isIP } from 'node:net';

const ALLOWED_BROWSER_FETCH_SITES = new Set(['same-origin', 'none']);
const WILDCARD_HOSTS = new Set(['0.0.0.0', '::']);
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'none'",
  "connect-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "frame-src 'none'",
  "img-src 'self' data:",
  "object-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
].join('; ');

function normalizeBareHostname(raw) {
  let hostname = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (hostname.startsWith('[') && hostname.endsWith(']')) hostname = hostname.slice(1, -1);
  if (hostname.startsWith('::ffff:') && isIP(hostname.slice(7)) === 4) hostname = hostname.slice(7);
  if (isIP(hostname)) return hostname;
  // DNS 绝对名最多只有一个末尾根点。若允许连续根点，后续再次
  // 归一化时可能把 localhost.. 逐步变成 localhost，误判为回环地址。
  if (hostname.endsWith('..')) return '';
  return hostname.replace(/\.$/u, '');
}

function parseHostAuthority(raw) {
  if (typeof raw !== 'string' || !raw.trim() || /[\s/@?#\\]/u.test(raw)) return null;
  try {
    const parsed = new URL(`http://${raw.trim()}`);
    const hostname = normalizeBareHostname(parsed.hostname);
    if (!hostname || parsed.username || parsed.password || parsed.pathname !== '/') return null;
    return { hostname, port: parsed.port };
  } catch {
    return null;
  }
}

function normalizeConfiguredHostname(raw) {
  const bare = normalizeBareHostname(raw);
  if (isIP(bare)) return bare;
  return parseHostAuthority(raw)?.hostname || bare;
}

export function normalizePublicOrigin(raw) {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) return '';
  try {
    const parsed = new URL(value);
    const hostname = normalizeBareHostname(parsed.hostname);
    if (!['http:', 'https:'].includes(parsed.protocol) || !hostname
      || parsed.username || parsed.password || parsed.pathname !== '/'
      || parsed.search || parsed.hash) {
      throw new Error('PUBLIC_ORIGIN_INVALID');
    }
    const authority = isIP(hostname) === 6 ? `[${hostname}]` : hostname;
    return `${parsed.protocol}//${authority}${parsed.port ? `:${parsed.port}` : ''}`;
  } catch {
    throw new Error('PUBLIC_ORIGIN_INVALID');
  }
}

export function isLoopbackHostname(rawHostname) {
  const hostname = normalizeBareHostname(rawHostname);
  if (hostname === 'localhost' || hostname === '::1') return true;
  return isIP(hostname) === 4 && hostname.split('.')[0] === '127';
}

export function isAllowedRequestHost(hostHeader, {
  listenHost = '127.0.0.1', localAddress = '', allowedHosts = '',
} = {}) {
  const request = parseHostAuthority(hostHeader);
  if (!request) return false;
  if (isLoopbackHostname(request.hostname)) return true;

  const configured = normalizeConfiguredHostname(listenHost);
  if (configured && !WILDCARD_HOSTS.has(configured) && request.hostname === configured) return true;

  const local = normalizeConfiguredHostname(localAddress);
  if (local && !WILDCARD_HOSTS.has(local) && request.hostname === local) return true;

  const explicit = String(allowedHosts || '')
    .split(',')
    .map(normalizeConfiguredHostname)
    .filter(Boolean);
  return explicit.includes(request.hostname);
}

export function isAllowedRequestOrigin(
  originHeader, hostHeader, requestProtocol = 'http', publicOrigin = '',
) {
  if (originHeader === undefined) return true;
  const host = parseHostAuthority(hostHeader);
  if (!host || typeof originHeader !== 'string' || originHeader === 'null') return false;
  try {
    const origin = new URL(originHeader);
    if (!['http:', 'https:'].includes(origin.protocol)) return false;
    if (origin.username || origin.password || origin.pathname !== '/'
      || origin.search || origin.hash) return false;
    if (normalizeBareHostname(origin.hostname) !== host.hostname
      || origin.port !== host.port) return false;
    if (origin.protocol === `${requestProtocol}:`) return true;

    // HTTPS 反向代理后的内部连接通常是 HTTP，不能仅用 req.protocol
    // 判断浏览器同源。只在管理员显式钉住完整公网 Origin 时接受该差异，
    // 不信任客户端可伪造的 X-Forwarded-Proto。
    let normalizedPublicOrigin;
    try { normalizedPublicOrigin = normalizePublicOrigin(publicOrigin); }
    catch { return false; }
    return Boolean(normalizedPublicOrigin)
      && normalizePublicOrigin(origin.origin) === normalizedPublicOrigin;
  } catch {
    return false;
  }
}

export function isAllowedBrowserFetchSite(fetchSiteHeader) {
  if (fetchSiteHeader === undefined) return true;
  if (typeof fetchSiteHeader !== 'string') return false;
  return ALLOWED_BROWSER_FETCH_SITES.has(fetchSiteHeader.trim().toLowerCase());
}

export function mountRequestSecurity(app, {
  listenHost = '127.0.0.1', allowedHosts = '', publicOrigin = '',
} = {}) {
  // 配置错误应在监听前明确失败，不能让部署看似启动成功却把全部 API
  // 静默拒绝。归一化只做一次，避免每个请求重复解释管理员输入。
  const normalizedPublicOrigin = normalizePublicOrigin(publicOrigin);
  app.use((req, res, next) => {
    // Express 默认路由不区分大小写；即使应用启用了严格匹配，安全边界也必须
    // 把 `/API/...` 等变体视为 API，避免配置变化后重新出现来源校验旁路。
    const normalizedPath = typeof req.path === 'string' ? req.path.toLowerCase() : '';
    const isApiRequest = normalizedPath === '/api' || normalizedPath.startsWith('/api/');
    // 不允许外站嵌入本机应用：iframe 内的相对 API 请求会被视为同源，
    // 仅靠 Origin / Sec-Fetch-Site 无法阻止点击劫持。
    res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'camera=(), geolocation=(), microphone=(), payment=(), usb=()');
    if (isApiRequest) res.setHeader('Cache-Control', 'no-store');

    const hostHeader = req.get('host');
    if (!isAllowedRequestHost(hostHeader, {
      listenHost,
      localAddress: req.socket?.localAddress,
      allowedHosts,
    })) {
      return res.status(403).json({ error: 'HOST_NOT_ALLOWED' });
    }

    // 健康检查的 GET/HEAD 不读取用户数据，需保留给启动器和外部存活探测。
    // 不能只按路径豁免：跨站页面可提交简单 POST 请求体，即使最终只会
    // 404，也会把健康检查变成绕过来源校验的本机请求体入口。
    // 其他 API 的 GET/HEAD 同样可能泄露作品或触发高成本扫描，不能只保护写操作。
    const isPublicHealthCheck = req.path === '/api/health'
      && (req.method === 'GET' || req.method === 'HEAD');
    if (isApiRequest && !isPublicHealthCheck) {
      if (!isAllowedBrowserFetchSite(req.get('sec-fetch-site'))
        || !isAllowedRequestOrigin(
          req.get('origin'), hostHeader, req.protocol, normalizedPublicOrigin,
        )) {
        return res.status(403).json({ error: 'ORIGIN_NOT_ALLOWED' });
      }
    }
    next();
  });
}
