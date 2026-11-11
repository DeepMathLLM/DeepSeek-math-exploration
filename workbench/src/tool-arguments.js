'use strict';
// Validate before executing a tool. Never silently turn malformed JSON into {}.
function schemaError(value, schema, location = '$', depth = 0) {
  if (!schema || depth > 8) return '';
  const kind = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  const expected = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  if (expected.length && !expected.includes(kind) && !(kind === 'number' && expected.includes('integer') && Number.isInteger(value))) return `${location} must be ${expected.join(' or ')}`;
  if (schema.enum && !schema.enum.some(item => JSON.stringify(item) === JSON.stringify(value))) return `${location} has an unsupported value`;
  if (kind === 'object' && value) {
    for (const name of schema.required || []) if (!Object.hasOwn(value, name)) return `${location}.${name} is required`;
    for (const [name, child] of Object.entries(value)) {
      if (child === undefined) continue; // Optional JS fields disappear on the JSON wire.
      if (schema.additionalProperties === false && !Object.hasOwn(schema.properties || {}, name)) return `${location}.${name} is not allowed`;
      const error = schemaError(child, schema.properties?.[name], `${location}.${name}`, depth + 1); if (error) return error;
    }
  }
  if (kind === 'array' && schema.items) for (let index = 0; index < value.length; index++) {
    const error = schemaError(value[index], schema.items, `${location}[${index}]`, depth + 1); if (error) return error;
  }
  return '';
}
function parseArguments(raw, schema) {
  let args = raw;
  if (typeof raw === 'string') { try { args = JSON.parse(raw); } catch { throw Object.assign(Error('Invalid tool arguments: expected a complete JSON object'), { code: 'INVALID_TOOL_ARGUMENTS' }); } }
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw Object.assign(Error('Invalid tool arguments: expected a JSON object'), { code: 'INVALID_TOOL_ARGUMENTS' });
  const error = schemaError(args, schema);
  if (error) throw Object.assign(Error('Invalid tool arguments: ' + error), { code: 'INVALID_TOOL_ARGUMENTS' });
  return args;
}
module.exports = { schemaError, parseArguments };
