// Pure checks for an agent registration document.
// Required: type "agent", name, description, and at least one service name + endpoint.

function asObject(input) {
  if (typeof input === 'string') {
    try { return { ok: true, value: JSON.parse(input) }; } catch { return { ok: false, reason: 'invalid json' }; }
  }
  return { ok: true, value: input };
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function validateAgentDocument(input) {
  const parsed = asObject(input);
  if (!parsed.ok) return parsed;
  const doc = parsed.value;
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    return { ok: false, reason: 'agent document must be an object' };
  }
  const errors = [];
  if (typeof doc.type !== 'string' || doc.type.trim() !== 'agent') errors.push('type must be agent');
  if (!nonEmpty(doc.name)) errors.push('name is required');
  if (!nonEmpty(doc.description)) errors.push('description is required');
  if (!Array.isArray(doc.services) || doc.services.length < 1) errors.push('at least one service is required');
  const services = [];
  if (Array.isArray(doc.services)) {
    doc.services.forEach((service, index) => {
      if (!service || typeof service !== 'object') {
        errors.push(`service ${index} is invalid`);
        return;
      }
      if (!nonEmpty(service.name)) errors.push(`service ${index} name is required`);
      if (!nonEmpty(service.endpoint)) errors.push(`service ${index} endpoint is required`);
      if (nonEmpty(service.name) && nonEmpty(service.endpoint)) {
        services.push({ name: service.name.trim(), endpoint: service.endpoint.trim() });
      }
    });
  }
  if (errors.length) return { ok: false, reason: errors.join('; '), errors };
  const document = {
    type: 'agent',
    name: doc.name.trim(),
    description: doc.description.trim(),
    services,
  };
  if (doc.registrations != null) document.registrations = doc.registrations;
  if (doc.supportedTrust != null) document.supportedTrust = doc.supportedTrust;
  return { ok: true, document };
}

module.exports = { validateAgentDocument };
