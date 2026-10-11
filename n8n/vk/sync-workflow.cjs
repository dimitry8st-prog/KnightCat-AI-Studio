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

function nodeByName(workflow, name) {
  const node = workflow.nodes.find((item) => item.name === name);
  if (!node) throw new Error('В workflow нет узла: ' + name);
  return node;
}

function ensureNode(workflow, node) {
  const index = workflow.nodes.findIndex((item) => item.name === node.name);
  if (index === -1) workflow.nodes.push(node);
  else workflow.nodes[index] = Object.assign({}, workflow.nodes[index], node, {
    parameters: node.parameters
  });
}

function syncWorkflow() {
  const workflow = JSON.parse(fs.readFileSync(workflowPath, 'utf8'));
  const source = fs.readFileSync(publisherPath, 'utf8');
  const wrapped = preamble(source);
  if (workflow.active !== false) {
    throw new Error('Отказ: локальный workflow помечен активным. Синхронизация остановлена.');
  }

  nodeByName(workflow, 'Normalize and Authorize').parameters.jsCode = read('normalize.js');
  nodeByName(workflow, 'Load Pending Draft').parameters.jsCode = wrapped + read('load-pending.js');
  nodeByName(workflow, 'Mark as Published').parameters.jsCode = read('mark-telegram.js');
  nodeByName(workflow, 'Reject Draft').parameters.jsCode = wrapped + read('reject.js');

  const parse = nodeByName(workflow, 'Parse and Validate Package');
  if (!parse.parameters.jsCode.includes('Версия VK вне диапазона')) {
    parse.parameters.jsCode = parse.parameters.jsCode.replace(
      "if (lengths.x > 280) warnings.push('Версия X превышает 280 символов.');",
      "if (lengths.x > 280) warnings.push('Версия X превышает 280 символов.');\n"
        + "if (lengths.vk < 500 || lengths.vk > 800) warnings.push('Версия VK вне диапазона 500–800 символов.');"
    );
  }
  if (!parse.parameters.jsCode.includes('post_id: null')) {
    parse.parameters.jsCode = parse.parameters.jsCode.replace(
      `publication: {
    telegram: {
      status: 'not_started',
      message_id: null,
      chat_id: original.config.publish_chat_id
    }
  },`,
      `visual: {
    prompt: String(data.image_prompt),
    image: null
  },
  publication: {
    telegram: {
      status: 'not_started',
      message_id: null,
      chat_id: original.config.publish_chat_id
    },
    vk: {
      status: 'not_started',
      post_id: null,
      owner_id: null,
      url: null,
      attachment: null,
      guid: null,
      content_sha256: null,
      locked_at: null,
      retryable: false,
      error_code: null,
      error_message: null,
      published_at: null
    }
  },`
    );
  }

  const store = nodeByName(workflow, 'Store Pending Draft');
  if (!store.parameters.jsCode.includes('Изображение для стены')) {
    const replaced = store.parameters.jsCode.replace(
      '${pkg.image_prompt}${warnings}\n\nОдобрить:',
      '${pkg.image_prompt}${warnings}\n\nVK: ${pkg.platforms.vk.content.length} символов. Изображение для стены: ${pkg.visual && pkg.visual.image ? \'есть\' : \'ещё не прикреплено\'}.\n\nОдобрить:'
    );
    if (replaced === store.parameters.jsCode) {
      throw new Error('Не удалось обновить предпросмотр черновика.');
    }
    store.parameters.jsCode = replaced;
  }

  const route = nodeByName(workflow, 'Route Event');
  const hasResolveRule = route.parameters.rules.values.some((rule) => rule.outputKey === 'vk_resolve');
  if (!hasResolveRule) {
    route.parameters.rules.values.push({
      conditions: {
        options: {
          caseSensitive: true,
          leftValue: '',
          typeValidation: 'strict',
          version: 2
        },
        conditions: [
          {
            id: 'route-vk-resolve',
            leftValue: '={{ $json.event_type }}',
            rightValue: 'vk_resolve',
            operator: { type: 'string', operation: 'equals' }
          }
        ],
        combinator: 'and'
      },
      renameOutput: true,
      outputKey: 'vk_resolve'
    });
  }

  ensureNode(workflow, {
    parameters: {
      conditions: {
        options: {
          caseSensitive: true,
          leftValue: '',
          typeValidation: 'strict',
          version: 2
        },
        conditions: [
          {
            id: 'need-telegram',
            leftValue: '={{ $json.publish_telegram }}',
            rightValue: true,
            operator: { type: 'boolean', operation: 'true', singleValue: true }
          }
        ],
        combinator: 'and'
      },
      options: {}
    },
    id: '1a000001-0001-4000-8000-000000000021',
    name: 'Need Telegram Publish?',
    type: 'n8n-nodes-base.if',
    typeVersion: 2.2,
    position: [40, 100]
  });

  ensureNode(workflow, {
    parameters: { jsCode: wrapped + read('publish-vk.js') },
    id: '1a000001-0001-4000-8000-000000000022',
    name: 'Publish to VK',
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position: [760, 20]
  });

  ensureNode(workflow, {
    parameters: { jsCode: wrapped + read('resolve-vk.js') },
    id: '1a000001-0001-4000-8000-000000000023',
    name: 'Resolve VK Status',
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position: [-200, 700]
  });

  const connections = workflow.connections;
  connections['Approval Valid?'].main[0] = [{ node: 'Need Telegram Publish?', type: 'main', index: 0 }];
  connections['Need Telegram Publish?'] = {
    main: [
      [{ node: 'Publish to Telegram', type: 'main', index: 0 }],
      [{ node: 'Publish to VK', type: 'main', index: 0 }]
    ]
  };
  connections['Mark as Published'].main[0] = [{ node: 'Publish to VK', type: 'main', index: 0 }];
  connections['Publish to VK'] = {
    main: [[{ node: 'Confirm Publication', type: 'main', index: 0 }]]
  };
  connections['Resolve VK Status'] = {
    main: [[{ node: 'Send Approval Error', type: 'main', index: 0 }]]
  };

  const routeOut = connections['Route Event'].main;
  const resolveLinked = routeOut.some((outs) => outs.some((link) => link.node === 'Resolve VK Status'));
  if (!resolveLinked) {
    const fallback = routeOut[routeOut.length - 1];
    routeOut[routeOut.length - 1] = [{ node: 'Resolve VK Status', type: 'main', index: 0 }];
    routeOut.push(fallback);
  }

  workflow.active = false;
  if (workflow.id !== 'KnightCatMvpTg01') workflow.id = 'KnightCatMvpTg01';
  fs.writeFileSync(workflowPath, JSON.stringify(workflow, null, 2) + '\n');
  return workflowPath;
}

if (require.main === module) {
  syncWorkflow();
}

module.exports = { syncWorkflow, preamble };
