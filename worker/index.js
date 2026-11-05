/**
 * ====================================================================
 *            MAVIS PANEL — CLOUDFLARE WORKER RUNTIME
 * ====================================================================
 * High-performance Serverless VLESS over WebSocket Proxy & Web Panel
 * Developed by Arash Seyfi & 4rsh14
 * Built with Cloudflare Workers TCP Sockets (cloudflare:sockets)
 * ====================================================================
 */

import { connect } from 'cloudflare:sockets';
import { EMBEDDED_ASSETS } from './assets.js';

const DEFAULT_UUID = 'd342d11e-d424-4583-b36e-524ab1f0afa4';
const DEFAULT_CLEAN_IPS = [
  '104.16.0.0',
  '162.159.0.0',
  'icook.hk',
  'speed.cloudflare.com',
  'visa.com',
  'www.csgo.com.cn'
];

const DEFAULT_PANEL_PATH = 'wp_panel';
const DEFAULT_REDIRECT_URL = 'https://www.youtube.com';
const WORKER_START_TIME = Date.now();

function uuidToBytes(uuidStr) {
  const clean = (uuidStr || '').replace(/-/g, '').toLowerCase();
  if (clean.length !== 32) return null;
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    bytes[i] = parseInt(clean.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function compareBytes(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function yamlSafeQuote(str) {
  return `"${String(str).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function getCookie(request, name) {
  const cookieStr = request.headers.get('Cookie') || '';
  const cookies = cookieStr.split(';');
  for (const c of cookies) {
    const parts = c.trim().split('=');
    if (parts[0] === name) return decodeURIComponent(parts.slice(1).join('=') || '');
  }
  return null;
}

function renderLoginHtml(panelPath, error = false) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Portal Access</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: #111; color: #ccc; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; padding: 20px; }
    .card { background: #1a1a1a; padding: 32px 28px; border-radius: 8px; border: 1px solid #282828; width: 100%; max-width: 360px; box-shadow: 0 8px 32px rgba(0,0,0,0.6); }
    h2 { font-size: 16px; font-weight: 600; margin-bottom: 20px; text-align: center; color: #eee; letter-spacing: -0.01em; }
    input { width: 100%; padding: 10px 12px; background: #111; border: 1px solid #333; border-radius: 4px; color: #fff; font-size: 13px; margin-bottom: 16px; outline: none; }
    input:focus { border-color: #555; }
    button { width: 100%; padding: 10px; background: #222; border: 1px solid #3a3a3a; border-radius: 4px; color: #eee; font-size: 13px; font-weight: 600; cursor: pointer; transition: background .15s; }
    button:hover { background: #2c2c2c; }
    .err { color: #e57373; font-size: 12px; margin-bottom: 14px; text-align: center; }
  </style>
</head>
<body>
  <div class="card">
    <h2>Dashboard Authentication</h2>
    ${error ? '<div class="err">Invalid credentials provided.</div>' : ''}
    <form method="POST" action="/${panelPath}">
      <input type="password" name="password" placeholder="Access Key" autofocus required autocomplete="current-password" />
      <button type="submit">Continue</button>
    </form>
  </div>
</body>
</html>`;
}

function buildNodes(host, uuid, prefix, cleanIps, wsPath) {
  const nodes = [];

  // 1. TLS Direct (Port 443)
  const tlsDirectName = `${prefix}TLS Direct`;
  const tlsDirectUri = `vless://${uuid}@${host}:443?encryption=none&security=tls&sni=${host}&type=ws&host=${host}&path=${encodeURIComponent(wsPath)}#${encodeURIComponent(tlsDirectName)}`;
  nodes.push({
    name: tlsDirectName,
    type: 'VLESS-WS-TLS',
    compat: true,
    server: host,
    port: 443,
    tls: true,
    sni: host,
    uri: tlsDirectUri,
    note: 'Cloudflare Edge CDN (TLS 443 Direct)'
  });

  // 2. HTTP (Port 80)
  const httpName = `${prefix}HTTP 80`;
  const httpUri = `vless://${uuid}@${host}:80?encryption=none&security=none&type=ws&host=${host}&path=${encodeURIComponent(wsPath)}#${encodeURIComponent(httpName)}`;
  nodes.push({
    name: httpName,
    type: 'VLESS-WS',
    compat: true,
    server: host,
    port: 80,
    tls: false,
    sni: '',
    uri: httpUri,
    note: 'Cloudflare Edge CDN (Non-TLS Port 80)'
  });

  // 3. Clean IPs (TLS with Clean IPs and Worker SNI)
  for (const ip of cleanIps) {
    const cleanName = `${prefix}Clean (${ip})`;
    const cleanUri = `vless://${uuid}@${ip}:443?encryption=none&security=tls&sni=${host}&type=ws&host=${host}&path=${encodeURIComponent(wsPath)}#${encodeURIComponent(cleanName)}`;
    nodes.push({
      name: cleanName,
      type: 'VLESS-WS-TLS',
      compat: true,
      server: ip,
      port: 443,
      tls: true,
      sni: host,
      uri: cleanUri,
      note: `Clean IP: ${ip} via ${host}`
    });
  }

  return nodes;
}

function buildClashYaml(nodes) {
  const proxyLines = [];
  const proxyNames = [];

  for (const n of nodes) {
    proxyNames.push(n.name);
    proxyLines.push(`  - name: ${yamlSafeQuote(n.name)}`);
    proxyLines.push(`    type: vless`);
    proxyLines.push(`    server: ${yamlSafeQuote(n.server)}`);
    proxyLines.push(`    port: ${n.port}`);
    proxyLines.push(`    uuid: ${yamlSafeQuote(n.uri.split('//')[1].split('@')[0])}`);
    proxyLines.push(`    network: ws`);
    proxyLines.push(`    tls: ${n.tls}`);
    proxyLines.push(`    udp: true`);
    if (n.tls && n.sni) {
      proxyLines.push(`    servername: ${yamlSafeQuote(n.sni)}`);
    }
    proxyLines.push(`    ws-opts:`);
    proxyLines.push(`      path: ${yamlSafeQuote('/mavis-ws')}`);
    proxyLines.push(`      headers:`);
    proxyLines.push(`        Host: ${yamlSafeQuote(n.sni || n.server)}`);
  }

  const proxiesBlock = proxyLines.join('\n');
  const proxyListStr = proxyNames.map(name => `      - ${yamlSafeQuote(name)}`).join('\n');

  return `# Mavis Panel - Clash Meta (Mihomo) Subscription
port: 7890
socks-port: 7891
allow-lan: true
mode: rule
log-level: info

proxies:
${proxiesBlock}

proxy-groups:
  - name: "🦇 Mavis Panel"
    type: select
    proxies:
      - "⚡ Auto Select"
${proxyListStr}

  - name: "⚡ Auto Select"
    type: url-test
    url: http://www.gstatic.com/generate_204
    interval: 300
    tolerance: 50
    proxies:
${proxyListStr}

rules:
  - MATCH,"🦇 Mavis Panel"
`;
}

function buildSingBoxJson(nodes) {
  const outbounds = [];
  const proxyTags = [];

  for (const n of nodes) {
    proxyTags.push(n.name);
    const ob = {
      type: 'vless',
      tag: n.name,
      server: n.server,
      server_port: n.port,
      uuid: n.uri.split('//')[1].split('@')[0],
      transport: {
        type: 'ws',
        path: '/mavis-ws',
        headers: {
          Host: n.sni || n.server
        }
      }
    };
    if (n.tls) {
      ob.tls = {
        enabled: true,
        server_name: n.sni
      };
    }
    outbounds.push(ob);
  }

  const clientConfig = {
    outbounds: [
      {
        type: 'selector',
        tag: 'select',
        outbounds: ['auto', ...proxyTags]
      },
      {
        type: 'urltest',
        tag: 'auto',
        outbounds: proxyTags,
        url: 'http://www.gstatic.com/generate_204',
        interval: '3m'
      },
      ...outbounds
    ]
  };

  return JSON.stringify(clientConfig, null, 2);
}

// --- VLESS WebSocket Connection Handler ---
async function handleVlessWebSocket(request, env) {
  const webSocketPair = new WebSocketPair();
  const [clientWs, serverWs] = Object.values(webSocketPair);
  serverWs.accept();

  const targetUuidBytes = uuidToBytes(env.UUID || DEFAULT_UUID);
  const proxyIp = (env.PROXY_IP || '').trim();

  let remoteSocket = null;
  let socketWriter = null;
  let isHandshakeDone = false;

  serverWs.addEventListener('message', async (event) => {
    try {
      const data = event.data;
      const buffer = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer);

      if (!isHandshakeDone) {
        if (buffer.length < 22) {
          serverWs.close(1002, 'Protocol error: header too short');
          return;
        }

        const clientUuidBytes = buffer.subarray(1, 17);
        if (!compareBytes(clientUuidBytes, targetUuidBytes)) {
          serverWs.close(1008, 'Unauthorized UUID');
          return;
        }

        const addonsLen = buffer[17];
        const cmdOffset = 18 + addonsLen;
        if (buffer.length < cmdOffset + 4) {
          serverWs.close(1002, 'Protocol error: invalid addons/command');
          return;
        }

        const command = buffer[cmdOffset];
        // 1 = TCP, 2 = UDP
        if (command !== 1) {
          serverWs.close(1003, 'Unsupported command (TCP only)');
          return;
        }

        const port = (buffer[cmdOffset + 1] << 8) | buffer[cmdOffset + 2];
        const addrType = buffer[cmdOffset + 3];
        let address = '';
        let payloadOffset = 0;

        if (addrType === 1) {
          if (buffer.length < cmdOffset + 8) {
            serverWs.close(1002, 'Invalid IPv4 header');
            return;
          }
          address = buffer.subarray(cmdOffset + 4, cmdOffset + 8).join('.');
          payloadOffset = cmdOffset + 8;
        } else if (addrType === 2) {
          const domainLen = buffer[cmdOffset + 4];
          if (buffer.length < cmdOffset + 5 + domainLen) {
            serverWs.close(1002, 'Invalid domain header');
            return;
          }
          address = new TextDecoder().decode(buffer.subarray(cmdOffset + 5, cmdOffset + 5 + domainLen));
          payloadOffset = cmdOffset + 5 + domainLen;
        } else if (addrType === 3) {
          if (buffer.length < cmdOffset + 20) {
            serverWs.close(1002, 'Invalid IPv6 header');
            return;
          }
          const ipv6 = [];
          for (let i = 0; i < 8; i++) {
            const idx = cmdOffset + 4 + i * 2;
            ipv6.push(((buffer[idx] << 8) | buffer[idx + 1]).toString(16));
          }
          address = ipv6.join(':');
          payloadOffset = cmdOffset + 20;
        } else {
          serverWs.close(1002, 'Unknown address type');
          return;
        }

        const targetHost = proxyIp || address;
        const targetPort = proxyIp ? 443 : port;

        try {
          remoteSocket = connect({
            hostname: targetHost,
            port: targetPort
          });
        } catch (err) {
          serverWs.close(1011, 'Cannot connect: ' + err.message);
          return;
        }

        socketWriter = remoteSocket.writable.getWriter();
        isHandshakeDone = true;

        const initialPayload = buffer.subarray(payloadOffset);
        if (initialPayload.length > 0) {
          await socketWriter.write(initialPayload);
        }

        pipeRemoteToWs(remoteSocket, serverWs);
      } else {
        if (socketWriter) {
          await socketWriter.write(buffer);
        }
      }
    } catch (err) {
      if (remoteSocket) try { remoteSocket.close(); } catch {}
      try { serverWs.close(); } catch {}
    }
  });

  serverWs.addEventListener('close', () => {
    if (socketWriter) try { socketWriter.releaseLock(); } catch {}
    if (remoteSocket) try { remoteSocket.close(); } catch {}
  });

  serverWs.addEventListener('error', () => {
    if (socketWriter) try { socketWriter.releaseLock(); } catch {}
    if (remoteSocket) try { remoteSocket.close(); } catch {}
  });

  return new Response(null, {
    status: 101,
    webSocket: clientWs
  });
}

async function pipeRemoteToWs(socket, ws) {
  let isFirst = true;
  const reader = socket.readable.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value && value.length > 0) {
        if (isFirst) {
          isFirst = false;
          const resp = new Uint8Array(2 + value.length);
          resp[0] = 0; // version
          resp[1] = 0; // addons len
          resp.set(value, 2);
          ws.send(resp);
        } else {
          ws.send(value);
        }
      }
    }
  } catch (err) {
    // Socket ended
  } finally {
    try { reader.releaseLock(); } catch {}
    try { socket.close(); } catch {}
    try { ws.close(); } catch {}
  }
}

// --- Main Worker Fetch Handler ---
export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      const pathname = url.pathname;
      const host = url.host;

      // WebSocket Upgrade -> VLESS Proxy
      if (request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
        return handleVlessWebSocket(request, env);
      }

      const panelPath = (env.PANEL_PATH || DEFAULT_PANEL_PATH).replace(/^\//, '').replace(/\/+$/, '') || 'wp_panel';
      const redirectTarget = env.REDIRECT_URL || DEFAULT_REDIRECT_URL;
      const targetToken = (env.PANEL_TOKEN || env.PASSWORD || '').trim();

      // Check if path is targeting the secret panel
      const isPanelRoot = pathname === `/${panelPath}` || pathname === `/${panelPath}/`;
      const isPanelSub = pathname.startsWith(`/${panelPath}/`);

      if (!isPanelRoot && !isPanelSub) {
        // Any other route (including `/`, `/health`, etc.) redirects to YouTube
        return Response.redirect(redirectTarget, 302);
      }

      // Authentication helper
      const checkAuth = () => {
        if (!targetToken) return { ok: true, setCookie: false };

        const authHeader = request.headers.get('Authorization') || '';
        const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;
        if (bearer === targetToken) return { ok: true, setCookie: false };

        const queryToken = url.searchParams.get('token') || url.searchParams.get('pwd') || url.searchParams.get('password');
        if (queryToken === targetToken) return { ok: true, setCookie: true };

        const cookieToken = getCookie(request, 'wp_auth');
        if (cookieToken === targetToken) return { ok: true, setCookie: false };

        return { ok: false, setCookie: false };
      };

      const auth = checkAuth();

      // Handle Panel login POST
      if (isPanelRoot && request.method === 'POST') {
        const formData = await request.formData().catch(() => null);
        const submitted = formData ? (formData.get('password') || formData.get('token') || '') : '';
        if (submitted && submitted === targetToken) {
          return new Response(null, {
            status: 302,
            headers: {
              'Location': `/${panelPath}`,
              'Set-Cookie': `wp_auth=${encodeURIComponent(targetToken)}; Path=/${panelPath}; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`
            }
          });
        }
        return new Response(renderLoginHtml(panelPath, true), {
          status: 401,
          headers: { 'Content-Type': 'text/html; charset=utf-8' }
        });
      }

      // Asset endpoints (under /${panelPath}/assets/...)
      if (
        pathname === `/${panelPath}/assets/app.css` ||
        pathname === `/${panelPath}/app.css`
      ) {
        return new Response(EMBEDDED_ASSETS.appCss, {
          headers: {
            'Content-Type': 'text/css; charset=utf-8',
            'Cache-Control': 'public, max-age=86400'
          }
        });
      }

      if (
        pathname === `/${panelPath}/assets/app.js` ||
        pathname === `/${panelPath}/app.js`
      ) {
        return new Response(EMBEDDED_ASSETS.appJs, {
          headers: {
            'Content-Type': 'application/javascript; charset=utf-8',
            'Cache-Control': 'public, max-age=86400'
          }
        });
      }

      if (
        pathname === `/${panelPath}/assets/logo.svg` ||
        pathname === `/${panelPath}/logo.svg`
      ) {
        return new Response(EMBEDDED_ASSETS.logoSvg, {
          headers: {
            'Content-Type': 'image/svg+xml',
            'Cache-Control': 'public, max-age=86400'
          }
        });
      }

      // Panel HTML root GET
      if (isPanelRoot) {
        if (!auth.ok) {
          return new Response(renderLoginHtml(panelPath, false), {
            status: 200,
            headers: { 'Content-Type': 'text/html; charset=utf-8' }
          });
        }

        const headers = { 'Content-Type': 'text/html; charset=utf-8' };
        if (auth.setCookie) {
          headers['Set-Cookie'] = `wp_auth=${encodeURIComponent(targetToken)}; Path=/${panelPath}; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`;
        }
        return new Response(EMBEDDED_ASSETS.indexHtml, { headers });
      }

      // If accessing other endpoints without auth, return 404
      if (!auth.ok) {
        return new Response('Not Found', { status: 404 });
      }

      const uuid = (env.UUID || DEFAULT_UUID).trim();
      const prefix = env.NODE_PREFIX || 'mavis-worker - ';
      const cleanIps = env.CLEAN_IPS
        ? env.CLEAN_IPS.split(',').map(s => s.trim()).filter(Boolean)
        : DEFAULT_CLEAN_IPS;

      // Health endpoint (for app.js and status checks)
      if (pathname === `/${panelPath}/health`) {
        const nodes = buildNodes(host, uuid, prefix, cleanIps, '/mavis-ws');
        const healthData = {
          ok: true,
          brand: 'Mavis Panel',
          product: 'Cloudflare Worker Edge',
          uptime: Math.floor((Date.now() - WORKER_START_TIME) / 1000),
          publicPort: 443,
          host: host,
          domain: host,
          forceHost: host,
          publicBaseUrl: `https://${host}`,
          subBase: `https://${host}`,
          forceHttps: true,
          location: `Cloudflare Edge (${request.cf?.colo || request.cf?.country || 'Global'})`,
          engines: {
            worker: true,
            vless_ws: true
          },
          nodes: nodes.map(n => ({
            name: n.name,
            type: n.type,
            compat: n.compat,
            uri: n.uri,
            note: n.note
          }))
        };
        return new Response(JSON.stringify(healthData, null, 2), {
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Access-Control-Allow-Origin': '*'
          }
        });
      }

      // Subscription: Universal Base64 and Raw
      if (
        pathname === `/${panelPath}/base64` ||
        pathname === `/${panelPath}/raw` ||
        pathname === `/${panelPath}/sub`
      ) {
        const isBase64 = pathname.endsWith('/base64') || pathname.endsWith('/sub');
        const nodes = buildNodes(host, uuid, prefix, cleanIps, '/mavis-ws');
        const text = nodes.map(n => n.uri).join('\n');

        const body = isBase64 ? btoa(text) : text;
        return new Response(body, {
          headers: {
            'Access-Control-Allow-Origin': '*',
            'Content-Type': 'text/plain; charset=utf-8',
            'Content-Disposition': 'attachment; filename="mavis-worker.txt"',
            'Profile-Update-Interval': '24',
            'Subscription-Userinfo': 'upload=0; download=0; total=0; expire=0'
          }
        });
      }

      // Subscription: Clash Meta (Mihomo)
      if (
        pathname === `/${panelPath}/clash` ||
        pathname === `/${panelPath}/clash.yaml`
      ) {
        const nodes = buildNodes(host, uuid, prefix, cleanIps, '/mavis-ws');
        const yaml = buildClashYaml(nodes);
        return new Response(yaml, {
          headers: {
            'Access-Control-Allow-Origin': '*',
            'Content-Type': 'text/yaml; charset=utf-8',
            'Content-Disposition': 'inline; filename="mavis-clash.yaml"',
            'Profile-Update-Interval': '24'
          }
        });
      }

      // Subscription: Sing-box client JSON
      if (
        pathname === `/${panelPath}/sb` ||
        pathname === `/${panelPath}/sb/raw`
      ) {
        const nodes = buildNodes(host, uuid, prefix, cleanIps, '/mavis-ws');
        const jsonStr = buildSingBoxJson(nodes);
        return new Response(jsonStr, {
          headers: {
            'Access-Control-Allow-Origin': '*',
            'Content-Type': 'application/json; charset=utf-8',
            'Profile-Update-Interval': '24'
          }
        });
      }

      return new Response('Not Found', { status: 404 });
    } catch (err) {
      return new Response('Error: ' + (err.stack || err.message), {
        status: 500,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' }
      });
    }
  }
};
