import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  COLLABORATION_SCHEMA_VERSION,
  JSON_SCHEMA_DIALECT,
  collaborationSchema,
} from '../src/schema.js';

function resolveLocalRef(schema, ref) {
  assert.match(ref, /^#\//);
  return ref
    .slice(2)
    .split('/')
    .map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'))
    .reduce((value, part) => {
      assert.ok(value && Object.hasOwn(value, part), `Unresolved schema reference ${ref}`);
      return value[part];
    }, schema);
}

function collectRefs(value, refs = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectRefs(item, refs);
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (key === '$ref') refs.push(item);
      else collectRefs(item, refs);
    }
  }
  return refs;
}

function assertGuidanceMatches(guidance, formal, ignoredProperties = []) {
  const ignored = new Set(ignoredProperties);
  const required = (formal.required || []).filter((name) => !ignored.has(name));
  const optional = Object.keys(formal.properties).filter(
    (name) => !ignored.has(name) && !required.includes(name)
  );
  assert.deepEqual(Object.keys(guidance.required), required);
  assert.deepEqual(Object.keys(guidance.optional), optional);
  for (const [name, description] of Object.entries({
    ...guidance.required,
    ...guidance.optional,
  })) {
    assert.equal(formal.properties[name].description, description);
  }
}

test('collaboration contract embeds resolvable JSON Schema 2020-12 inputs', () => {
  const contract = collaborationSchema();
  assert.equal(contract.version, COLLABORATION_SCHEMA_VERSION);
  assert.equal(contract.version, 2);
  assert.equal(contract.jsonSchemaDialect, JSON_SCHEMA_DIALECT);

  for (const inputSchema of [
    contract.planTransaction.inputSchema,
    contract.viewUpdate.inputSchema,
  ]) {
    assert.equal(inputSchema.$schema, JSON_SCHEMA_DIALECT);
    assert.ok(inputSchema.oneOf.length > 1);
    const refs = collectRefs(inputSchema);
    assert.ok(refs.length > 0);
    for (const ref of refs) resolveLocalRef(inputSchema, ref);
  }
});

test('plan guidance and command schemas derive the same fields and descriptions', () => {
  const plan = collaborationSchema().planTransaction;
  const formal = plan.inputSchema.$defs;
  assert.deepEqual(plan.input.acceptedForms, ['transaction object', 'command array']);
  assertGuidanceMatches(plan.input.transaction, formal.transaction);
  assert.equal(formal.commands.minItems, 1);

  const commandRefs = formal.command.oneOf.map(({ $ref }) => $ref);
  assert.deepEqual(
    commandRefs,
    plan.commands.map(({ type }) => `#/$defs/command-${type}`)
  );
  for (const command of plan.commands) {
    const commandSchema = formal[`command-${command.type}`];
    assert.equal(commandSchema.properties.type.const, command.type);
    assertGuidanceMatches(command, commandSchema, ['type']);
  }

  const renamePattern = new RegExp(formal['command-rename'].properties.name.pattern, 'u');
  assert.equal(renamePattern.test('draft.md'), true);
  assert.equal(renamePattern.test('../draft.md'), false);
  assert.equal(renamePattern.test('  .  '), false);
  assert.equal(renamePattern.test('   '), false);
  assert.equal(renamePattern.test('draft\nnotes.md'), true);
});

test('view guidance matches its strict nested patch schema', () => {
  const view = collaborationSchema().viewUpdate;
  const formal = view.inputSchema.$defs;
  assert.deepEqual(view.input.acceptedForms, ['view patch object', 'transaction object']);
  assertGuidanceMatches(view.input.transaction, formal.transaction);
  assertGuidanceMatches(view.patch, formal.patch);
  assert.equal(formal.patch.additionalProperties, false);
  assert.equal(formal.ui.additionalProperties, false);
  assert.equal(formal.side.additionalProperties, false);
  assert.deepEqual(formal.ui.properties.filterTag.enum, [
    null,
    'moved',
    'renamed',
    'new',
    'trashed',
  ]);
  assert.equal(formal.ui.properties.sideW.minimum, 20);
  assert.equal(formal.ui.properties.sideW.maximum, 80);
  assert.deepEqual(formal.side.properties.mode.enum, [
    'none',
    'preview',
    'review',
    'notes',
    'triage',
    'help',
  ]);
});
