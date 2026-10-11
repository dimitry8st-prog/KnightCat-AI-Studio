'use strict';

const crypto = require('crypto');

function sha256Hex(input) {
  const data = Buffer.isBuffer(input) ? input : Buffer.from(input || []);
  return crypto.createHash('sha256').update(data).digest('hex');
}

module.exports = { sha256Hex };
