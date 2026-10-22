'use strict';
const fs = require('fs');
const path = require('path');

const COMPOSE_PATH = path.join(__dirname, 'hetzner', 'compose.json');

function loadHetznerDeploy() {
  const text = fs.readFileSync(COMPOSE_PATH, 'utf8');
  const deploy = JSON.parse(text);
  deploy.composePath = COMPOSE_PATH;
  deploy.raw = text;
  return deploy;
}

function localGatewayUrl(template, port) {
  const url = new URL(template);
  if (url.hostname !== 'validator') {
    throw new Error('VALIDATOR_RPC must target the in-host validator gateway');
  }
  url.hostname = '127.0.0.1';
  url.port = String(port);
  return url.toString().replace(/\/$/, '');
}

module.exports = {
  COMPOSE_PATH,
  loadHetznerDeploy,
  localGatewayUrl,
};
