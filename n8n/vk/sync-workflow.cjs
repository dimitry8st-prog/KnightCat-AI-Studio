'use strict';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const workflowPath = path.join(root, 'n8n', 'workflows', 'knightcat-minimal-telegram.json');
const publisherPath = path.join(__dirname, 'vk-publisher.cjs');

function read(name) {
  return fs.readFileSync(path.join(__dirname, 'nodes', name), 'utf8').replace(/\r\n/g, '\n').trim() + '\n';
}

function preamble(source) {
  return [
    'const vkPublisher = (function () {',
    '  const module = { exports: {} };',
    '  const exports = module.exports;',
    '  /* BEGIN vk-publisher.cjs */',
    source.replace(/\r\n/g, '\n').trim(),
    '  /* END vk-publisher.cjs */',
    '  return module.exports;',
    '})();',
    ''
  ].join('\n');
}

function codeNode(source, id, name, position, file, embed) {
  return {
    parameters: { jsCode: (embed ? preamble(source) : '') + read(file) },
    id,
    name,
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position
  };
}

function ifNode(id, name, position, condition) {
  return {
    parameters: {
      conditions: {
        options: {
          caseSensitive: true,
          leftValue: '',
          typeValidation: 'strict',
          version: 2
        },
        conditions: [Object.assign({ id }, condition)],
        combinator: 'and'
      },
      options: {}
    },
    id,
    name,
    type: 'n8n-nodes-base.if',
    typeVersion: 2.2,
    position
  };
}

function vkApiNode(id, name, position, method, credentialId, credentialName, urlExpression) {
  return {
    parameters: {
      method: 'POST',
      url: urlExpression || ('https://api.vk.ru/method/' + method),
      authentication: 'genericCredentialType',
      genericAuthType: 'httpBearerAuth',
      sendBody: true,
      contentType: 'raw',
      rawContentType: 'application/x-www-form-urlencoded',
      body: '={{ $json.vk_request_body }}',
      options: {
        timeout: 20000,
        response: { response: { responseFormat: 'json' } }
      }
    },
    id,
    name,
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4.2,
    position,
    retryOnFail: false,
    onError: 'continueErrorOutput',
    credentials: {
      httpBearerAuth: { id: credentialId, name: credentialName }
    }
  };
}

function ensureNode(workflow, node) {
  const index = workflow.nodes.findIndex((item) => item.name === node.name);
  if (index === -1) workflow.nodes.push(node);
  else workflow.nodes[index] = node;
}

function link(connections, from, outputIndex, to) {
  if (!connections[from]) connections[from] = { main: [] };
  while (connections[from].main.length <= outputIndex) connections[from].main.push([]);
  connections[from].main[outputIndex] = [{ node: to, type: 'main', index: 0 }];
}

function syncWorkflow() {
  const workflow = JSON.parse(fs.readFileSync(workflowPath, 'utf8'));
  const source = fs.readFileSync(publisherPath, 'utf8');
  if (workflow.active !== false) throw new Error('Отказ: workflow помечен активным.');

  const removed = new Set(['Publish to VK', 'Resolve VK Status']);
  workflow.nodes = workflow.nodes.filter((node) => !removed.has(node.name));
  for (const name of removed) delete workflow.connections[name];

  const byName = (name) => {
    const node = workflow.nodes.find((item) => item.name === name);
    if (!node) throw new Error('Нет узла ' + name);
    return node;
  };

  byName('Normalize and Authorize').parameters.jsCode = read('normalize.js');
  byName('Load Pending Draft').parameters.jsCode = preamble(source) + read('load-pending.js');
  byName('Mark as Published').parameters.jsCode = read('mark-telegram.js');
  byName('Reject Draft').parameters.jsCode = preamble(source) + read('reject.js');
  byName('Parse and Validate Package').parameters.jsCode = preamble(source) + read('parse-package.js');

  const store = byName('Store Pending Draft');
  if (!store.parameters.jsCode.includes('Изображение для стены')) {
    const replaced = store.parameters.jsCode.replace(
      '${pkg.image_prompt}${warnings}\n\nОдобрить:',
      '${pkg.image_prompt}${warnings}\n\nVK: ${pkg.platforms.vk.content.length} символов. Изображение для стены: ${pkg.visual && pkg.visual.image ? \'есть\' : \'ещё не прикреплено\'}.\n\nОдобрить:'
    );
    if (replaced === store.parameters.jsCode) throw new Error('Не удалось обновить предпросмотр.');
    store.parameters.jsCode = replaced;
  }

  const route = byName('Route Event');
  if (!route.parameters.rules.values.some((rule) => rule.outputKey === 'vk_resolve')) {
    route.parameters.rules.values.push({
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
        conditions: [{
          id: 'route-vk-resolve',
          leftValue: '={{ $json.event_type }}',
          rightValue: 'vk_resolve',
          operator: { type: 'string', operation: 'equals' }
        }],
        combinator: 'and'
      },
      renameOutput: true,
      outputKey: 'vk_resolve'
    });
  }

  const nodes = [
    ifNode('1a000001-0001-4000-8000-000000000030', 'Has Draft Photo?', [520, -120], {
      leftValue: "={{ $json.source_photo_file_id || '' }}",
      rightValue: '',
      operator: { type: 'string', operation: 'notEquals' }
    }),
    {
      parameters: {
        resource: 'file',
        operation: 'get',
        fileId: '={{ $json.source_photo_file_id }}',
        download: true,
        additionalFields: {}
      },
      id: '1a000001-0001-4000-8000-000000000031',
      name: 'Download Draft Photo',
      type: 'n8n-nodes-base.telegram',
      typeVersion: 1.2,
      position: [760, -220],
      onError: 'continueErrorOutput',
      credentials: {
        telegramApi: { id: 'REPLACE_TELEGRAM_CREDENTIAL_ID', name: 'KnightCat Telegram Bot' }
      }
    },
    codeNode(source, '1a000001-0001-4000-8000-000000000032', 'Attach Draft Image', [980, -220], 'attach-image.js', true),
    codeNode(source, '1a000001-0001-4000-8000-000000000033', 'Draft Photo Failed', [980, -40], 'draft-photo-failed.js', false),
    ifNode('1a000001-0001-4000-8000-000000000034', 'Image Accepted?', [1200, -220], {
      leftValue: '={{ $json.package_valid }}',
      rightValue: true,
      operator: { type: 'boolean', operation: 'true', singleValue: true }
    }),
    codeNode(source, '1a000001-0001-4000-8000-000000000035', 'Claim VK Publish', [760, 20], 'claim-vk.js', true),
    {
      parameters: {
        mode: 'rules',
        rules: {
          values: ['publish', 'reconcile', 'stop'].map((key) => ({
            conditions: {
              options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
              conditions: [{
                id: 'vk-action-' + key,
                leftValue: '={{ $json.vk_action }}',
                rightValue: key,
                operator: { type: 'string', operation: 'equals' }
              }],
              combinator: 'and'
            },
            renameOutput: true,
            outputKey: key
          }))
        },
        options: { fallbackOutput: 'extra' }
      },
      id: '1a000001-0001-4000-8000-000000000036',
      name: 'VK Action',
      type: 'n8n-nodes-base.switch',
      typeVersion: 3.2,
      position: [980, 20]
    },
    codeNode(source, '1a000001-0001-4000-8000-000000000037', 'Prepare VK Upload Server', [1200, -40], 'prepare-upload-server.js', true),
    ifNode('1a000001-0001-4000-8000-000000000038', 'VK Upload Server Ready?', [1420, -40], {
      leftValue: '={{ $json.vk_ready }}',
      rightValue: true,
      operator: { type: 'boolean', operation: 'true', singleValue: true }
    }),
    vkApiNode('1a000001-0001-4000-8000-000000000039', 'VK Get Upload Server', [1640, -80], 'photos.getWallUploadServer', 'REPLACE_VK_USER_BEARER_ID', 'VK User Token'),
    codeNode(source, '1a000001-0001-4000-8000-000000000040', 'Accept VK Upload Server', [1860, -80], 'accept-upload-server.js', true),
    ifNode('1a000001-0001-4000-8000-000000000041', 'VK Photo Upload Ready?', [2080, -80], {
      leftValue: '={{ $json.vk_ready }}',
      rightValue: true,
      operator: { type: 'boolean', operation: 'true', singleValue: true }
    }),
    {
      parameters: {
        method: 'POST',
        url: '={{ $json.vk_upload_url }}',
        sendBody: true,
        contentType: 'multipart-form-data',
        bodyParameters: {
          parameters: [{
            parameterType: 'formBinaryData',
            name: 'photo',
            inputDataFieldName: 'photo'
          }]
        },
        options: {
          timeout: 30000,
          response: { response: { responseFormat: 'json' } }
        }
      },
      id: '1a000001-0001-4000-8000-000000000042',
      name: 'VK Upload Photo',
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.2,
      position: [2300, -80],
      retryOnFail: false,
      onError: 'continueErrorOutput'
    },
    codeNode(source, '1a000001-0001-4000-8000-000000000043', 'Accept VK Photo Upload', [2520, -80], 'accept-photo-upload.js', true),
    ifNode('1a000001-0001-4000-8000-000000000044', 'VK Save Photo Ready?', [2740, -80], {
      leftValue: '={{ $json.vk_ready }}',
      rightValue: true,
      operator: { type: 'boolean', operation: 'true', singleValue: true }
    }),
    vkApiNode('1a000001-0001-4000-8000-000000000045', 'VK Save Wall Photo', [2960, -80], 'photos.saveWallPhoto', 'REPLACE_VK_USER_BEARER_ID', 'VK User Token'),
    codeNode(source, '1a000001-0001-4000-8000-000000000046', 'Arm VK Wall Post', [3180, -80], 'arm-wall-post.js', true),
    ifNode('1a000001-0001-4000-8000-000000000047', 'VK Wall Post Ready?', [3400, -80], {
      leftValue: '={{ $json.vk_ready }}',
      rightValue: true,
      operator: { type: 'boolean', operation: 'true', singleValue: true }
    }),
    vkApiNode('1a000001-0001-4000-8000-000000000048', 'VK Wall Post', [3620, -80], 'wall.post', 'REPLACE_VK_COMMUNITY_BEARER_ID', 'VK Community Token'),
    codeNode(source, '1a000001-0001-4000-8000-000000000049', 'Save VK Post', [3840, -120], 'save-vk-post.js', true),
    codeNode(source, '1a000001-0001-4000-8000-000000000050', 'Mark VK Unknown', [3840, 40], 'mark-unknown.js', true),
    codeNode(source, '1a000001-0001-4000-8000-000000000051', 'Record VK Upload Failure', [1860, 80], 'record-upload-failure.js', true),
    codeNode(source, '1a000001-0001-4000-8000-000000000052', 'Prepare VK Reconcile', [1200, 180], 'prepare-reconcile.js', true),
    ifNode('1a000001-0001-4000-8000-000000000053', 'VK Reconcile Ready?', [1420, 180], {
      leftValue: '={{ $json.vk_ready }}',
      rightValue: true,
      operator: { type: 'boolean', operation: 'true', singleValue: true }
    }),
    vkApiNode('1a000001-0001-4000-8000-000000000054', 'VK Reconcile Wall', [1640, 180], 'wall.get', 'REPLACE_VK_COMMUNITY_BEARER_ID', 'VK Community Token', '={{ $json.vk_request_url }}'),
    codeNode(source, '1a000001-0001-4000-8000-000000000055', 'Apply VK Reconcile', [1860, 140], 'apply-reconcile.js', true),
    codeNode(source, '1a000001-0001-4000-8000-000000000056', 'Record VK Reconcile Failure', [1860, 260], 'record-reconcile-failure.js', true),
    codeNode(source, '1a000001-0001-4000-8000-000000000057', 'Plan VK Resolve', [-200, 700], 'plan-resolve.js', true),
    ifNode('1a000001-0001-4000-8000-000000000058', 'Resolve Needs HTTP?', [40, 700], {
      leftValue: '={{ $json.vk_action }}',
      rightValue: 'reconcile',
      operator: { type: 'string', operation: 'equals' }
    })
  ];
  for (const node of nodes) ensureNode(workflow, node);

  const connections = workflow.connections;
  link(connections, 'Package Valid?', 0, 'Has Draft Photo?');
  link(connections, 'Package Valid?', 1, 'Send Processing Error');
  link(connections, 'Has Draft Photo?', 0, 'Download Draft Photo');
  link(connections, 'Has Draft Photo?', 1, 'Store Pending Draft');
  link(connections, 'Download Draft Photo', 0, 'Attach Draft Image');
  link(connections, 'Download Draft Photo', 1, 'Draft Photo Failed');
  link(connections, 'Draft Photo Failed', 0, 'Send Processing Error');
  link(connections, 'Attach Draft Image', 0, 'Image Accepted?');
  link(connections, 'Image Accepted?', 0, 'Store Pending Draft');
  link(connections, 'Image Accepted?', 1, 'Send Processing Error');
  link(connections, 'Need Telegram Publish?', 0, 'Publish to Telegram');
  link(connections, 'Need Telegram Publish?', 1, 'Claim VK Publish');
  link(connections, 'Mark as Published', 0, 'Claim VK Publish');
  link(connections, 'Claim VK Publish', 0, 'VK Action');
  link(connections, 'VK Action', 0, 'Prepare VK Upload Server');
  link(connections, 'VK Action', 1, 'Prepare VK Reconcile');
  link(connections, 'VK Action', 2, 'Confirm Publication');
  link(connections, 'VK Action', 3, 'Confirm Publication');
  link(connections, 'Prepare VK Upload Server', 0, 'VK Upload Server Ready?');
  link(connections, 'VK Upload Server Ready?', 0, 'VK Get Upload Server');
  link(connections, 'VK Upload Server Ready?', 1, 'Confirm Publication');
  link(connections, 'VK Get Upload Server', 0, 'Accept VK Upload Server');
  link(connections, 'VK Get Upload Server', 1, 'Record VK Upload Failure');
  link(connections, 'Accept VK Upload Server', 0, 'VK Photo Upload Ready?');
  link(connections, 'VK Photo Upload Ready?', 0, 'VK Upload Photo');
  link(connections, 'VK Photo Upload Ready?', 1, 'Confirm Publication');
  link(connections, 'VK Upload Photo', 0, 'Accept VK Photo Upload');
  link(connections, 'VK Upload Photo', 1, 'Record VK Upload Failure');
  link(connections, 'Accept VK Photo Upload', 0, 'VK Save Photo Ready?');
  link(connections, 'VK Save Photo Ready?', 0, 'VK Save Wall Photo');
  link(connections, 'VK Save Photo Ready?', 1, 'Confirm Publication');
  link(connections, 'VK Save Wall Photo', 0, 'Arm VK Wall Post');
  link(connections, 'VK Save Wall Photo', 1, 'Record VK Upload Failure');
  link(connections, 'Arm VK Wall Post', 0, 'VK Wall Post Ready?');
  link(connections, 'VK Wall Post Ready?', 0, 'VK Wall Post');
  link(connections, 'VK Wall Post Ready?', 1, 'Confirm Publication');
  link(connections, 'VK Wall Post', 0, 'Save VK Post');
  link(connections, 'VK Wall Post', 1, 'Mark VK Unknown');
  link(connections, 'Save VK Post', 0, 'Confirm Publication');
  link(connections, 'Mark VK Unknown', 0, 'Confirm Publication');
  link(connections, 'Record VK Upload Failure', 0, 'Confirm Publication');
  link(connections, 'Prepare VK Reconcile', 0, 'VK Reconcile Ready?');
  link(connections, 'VK Reconcile Ready?', 0, 'VK Reconcile Wall');
  link(connections, 'VK Reconcile Ready?', 1, 'Confirm Publication');
  link(connections, 'VK Reconcile Wall', 0, 'Apply VK Reconcile');
  link(connections, 'VK Reconcile Wall', 1, 'Record VK Reconcile Failure');
  link(connections, 'Apply VK Reconcile', 0, 'Confirm Publication');
  link(connections, 'Record VK Reconcile Failure', 0, 'Confirm Publication');
  link(connections, 'Route Event', 3, 'Plan VK Resolve');
  link(connections, 'Route Event', 4, 'Send Help or Access Error');
  link(connections, 'Plan VK Resolve', 0, 'Resolve Needs HTTP?');
  link(connections, 'Resolve Needs HTTP?', 0, 'Prepare VK Reconcile');
  link(connections, 'Resolve Needs HTTP?', 1, 'Send Approval Error');

  workflow.active = false;
  workflow.id = 'KnightCatMvpTg01';
  fs.writeFileSync(workflowPath, JSON.stringify(workflow, null, 2) + '\n');
  return workflowPath;
}

if (require.main === module) syncWorkflow();

module.exports = { syncWorkflow };
