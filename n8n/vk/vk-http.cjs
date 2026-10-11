'use strict';

const publisher = require('./vk-publisher.cjs');

function classifyTransportError(error, phase) {
  const raw = String(error && (error.message || error.code) || error || '');
  const timedOut = /timeout|timed out|ETIMEDOUT|ESOCKETTIMEDOUT|aborted/i.test(raw);
  const wrapped = new Error(timedOut ? 'timeout' : 'network');
  wrapped.code = timedOut ? 'timeout' : 'network';
  wrapped.phase = phase;
  wrapped.uncertain = phase === 'publish';
  return wrapped;
}

function createHttpClient({ fetchImpl, apiBase, version } = {}) {
  const fetchFn = fetchImpl || globalThis.fetch;
  const base = apiBase || publisher.API_BASE;
  const apiVersion = version || publisher.API_VERSION;

  async function call(method, params, options) {
    const phase = options && options.phase || 'call';
    const token = options && options.token;
    const fields = Object.assign({ v: apiVersion }, params || {});
    const body = publisher.buildFormBody(fields);
    const url = base.replace(/\/$/, '') + '/' + method;
    let response;
    try {
      response = await fetchFn(url, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + token,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body
      });
    } catch (error) {
      throw classifyTransportError(error, phase);
    }
    const payload = await response.json();
    if (payload && payload.error) {
      const wrapped = new Error(payload.error.error_msg || 'VK API error');
      wrapped.code = payload.error.error_code;
      wrapped.phase = phase;
      throw wrapped;
    }
    return payload.response;
  }

  return { call };
}

function classifyTokenMaterial(token) {
  const value = String(token || '').trim();
  if (!value) return { present: false, type: 'missing' };
  if (/^vk[12]\./i.test(value)) return { present: true, type: 'vk_id' };
  return { present: true, type: 'opaque' };
}

function permissionNames(payload) {
  const list = (payload && (payload.permissions || payload.settings)) || [];
  if (!Array.isArray(list)) return [];
  return list.map((item) => (typeof item === 'string' ? item : item && item.name)).filter(Boolean);
}

async function probeAccess({ client, communityToken, userToken }) {
  const report = {
    community: classifyTokenMaterial(communityToken),
    user: classifyTokenMaterial(userToken)
  };
  if (communityToken) {
    try {
      const payload = await client.call('groups.getTokenPermissions', {}, { token: communityToken, phase: 'probe' });
      const names = permissionNames(payload);
      report.community = {
        present: true,
        type: 'community',
        permissions: names,
        hasWall: names.includes('wall'),
        hasPhotos: names.includes('photos')
      };
    } catch (error) {
      report.community = {
        present: true,
        type: error.code === 5 ? 'invalid' : 'unknown',
        error_code: error.code || null
      };
    }
  }
  if (userToken) {
    try {
      const maskPayload = await client.call('account.getAppPermissions', {}, { token: userToken, phase: 'probe' });
      const mask = typeof maskPayload === 'number' ? maskPayload : Number(maskPayload && maskPayload.mask);
      report.user = {
        present: true,
        type: 'user',
        hasPhotos: (mask & 4) === 4,
        hasWall: (mask & 8192) === 8192
      };
    } catch (error) {
      let type = 'unknown';
      if (error.code === 27) type = 'community_not_user';
      else if (error.code === 28) type = 'service';
      else if (error.code === 5) type = 'invalid';
      report.user = { present: true, type, error_code: error.code || null };
    }
  }
  return report;
}

module.exports = { createHttpClient, probeAccess, classifyTokenMaterial };
