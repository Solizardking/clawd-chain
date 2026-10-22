// Local verdict for an SVM quote. Measurement pin plus signature check.
const { verifyAttestation } = require('./attest');

function createRelayer({ measurement, signer } = {}) {
  const seen = new Set();
  return {
    verdict(attestation) {
      return verifyAttestation(attestation, { measurement, signer, seen });
    },
  };
}

module.exports = { createRelayer };
