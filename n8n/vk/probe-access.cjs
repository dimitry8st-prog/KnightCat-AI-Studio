'use strict';

const { probeAccess, createHttpClient, classifyTokenMaterial } = require('./vk-http.cjs');
const { normalizeGroupId } = require('./vk-publisher.cjs');

function readEnv(name) {
  return String(process.env[name] || '').trim();
}

async function main() {
  const communityToken = readEnv('KNIGHTCAT_VK_COMMUNITY_TOKEN');
  const userToken = readEnv('KNIGHTCAT_VK_USER_TOKEN');
  const groupId = normalizeGroupId(readEnv('KNIGHTCAT_VK_GROUP_ID'));
  const report = {
    real_api: 'not_called',
    group_id_present: Boolean(groupId),
    community: classifyTokenMaterial(communityToken),
    user: classifyTokenMaterial(userToken)
  };
  if (!communityToken && !userToken) {
    console.log(JSON.stringify(report));
    return;
  }
  report.real_api = 'read_only_probe';
  const probed = await probeAccess({
    client: createHttpClient(),
    communityToken,
    userToken
  });
  report.community = probed.community;
  report.user = probed.user;
  console.log(JSON.stringify(report));
}

main().catch(() => {
  console.log(JSON.stringify({
    real_api: 'read_only_probe_failed',
    message: 'Проверка ключа не выполнена. Значение ключа не записывается.'
  }));
  process.exitCode = 1;
});
