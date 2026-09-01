import { COMMAND, COMMAND_ERROR_CODE } from './commands.js';
import { WORKSPACE_BUSY_CODE } from './state.js';
import { FILTER_TAG, SIDE_MODE, THEME } from './view.js';

export const COLLABORATION_SCHEMA_VERSION = 2;
export const JSON_SCHEMA_DIALECT = 'https://json-schema.org/draft/2020-12/schema';

const PATH_COMPONENT_PATTERN = '^(?!\\s*$)(?!\\s*(?:\\.|\\.\\.)\\s*$)[^/\\u0000]+$';

const field = (description, schema) => Object.freeze({ description, schema });

const shape = (required = {}, optional = {}) => Object.freeze({ required, optional });

const NON_EMPTY_STRING = field('non-empty string', { type: 'string', pattern: '\\S' });
const NODE_ID = field('non-empty node id string', { type: 'string', minLength: 1 });
const NODE_OR_ROOT_ID = field('node id or "."', { type: 'string', minLength: 1 });
const PARENT_ID = field('directory node id or "."', { type: 'string', minLength: 1 });
const PATH_COMPONENT = field('single path component', {
  type: 'string',
  pattern: PATH_COMPONENT_PATTERN,
});
const CREATED_FOLDER_ID = field('string beginning "new:"', {
  type: 'string',
  pattern: '^new:',
});
const NOTE_ID = field('non-empty note id string', { type: 'string', pattern: '\\S' });
const EXPECTED_REVISION = field(
  'non-negative integer; defaults to the revision read by the CLI',
  { type: 'integer', minimum: 0 }
);

const command = (type, required, optional = {}) => Object.freeze({ type, required, optional });

const COMMAND_DEFINITIONS = Object.freeze([
  command(COMMAND.MOVE, { id: NODE_ID, parentId: PARENT_ID }),
  command(COMMAND.RENAME, { id: NODE_ID, name: PATH_COMPONENT }),
  command(
    COMMAND.CREATE_FOLDER,
    { parentId: PARENT_ID, name: PATH_COMPONENT },
    { id: CREATED_FOLDER_ID }
  ),
  command(COMMAND.REMOVE_CREATED, {
    id: field('created folder id', { type: 'string', minLength: 1 }),
  }),
  command(COMMAND.TRASH, { id: NODE_ID }),
  command(COMMAND.KEEP, { id: NODE_ID }),
  command(COMMAND.RESTORE_ENTRY, {
    id: field('original node id', { type: 'string', minLength: 1 }),
  }),
  command(COMMAND.SET_NOTE, { target: NODE_OR_ROOT_ID, body: NON_EMPTY_STRING }, { id: NOTE_ID }),
  command(COMMAND.DELETE_NOTE, { id: NOTE_ID }),
  command(COMMAND.RESET_PLAN, {}),
  command(COMMAND.MERGE_SUMMARIES, {
    summaries: field('object mapping node ids to non-empty strings', {
      type: 'object',
      propertyNames: { minLength: 1 },
      additionalProperties: { type: 'string', pattern: '\\S' },
    }),
  }),
]);

const PLAN_TRANSACTION = shape(
  {
    commands: field('non-empty array of semantic commands', { $ref: '#/$defs/commands' }),
  },
  {
    expectedRevision: EXPECTED_REVISION,
    transactionId: field('non-empty idempotency key string', {
      type: 'string',
      pattern: '\\S',
    }),
    actor: field('non-empty attribution string', { type: 'string', pattern: '\\S' }),
  }
);

const VIEW_UI = shape(
  {},
  {
    filterText: field('filter string or null', { type: ['string', 'null'] }),
    filterTag: field('change filter or null', {
      enum: [null, ...Object.values(FILTER_TAG)],
    }),
    git: field('git presentation toggle or null', { type: ['boolean', 'null'] }),
    heat: field('size presentation toggle or null', { type: ['boolean', 'null'] }),
    theme: field('theme name or null', { enum: [null, ...Object.values(THEME)] }),
    sideW: field('side-panel width from 20 through 80 or null', {
      type: ['number', 'null'],
      minimum: 20,
      maximum: 80,
    }),
  }
);

const VIEW_SIDE = shape(
  {},
  {
    mode: field('side-panel mode', { enum: Object.values(SIDE_MODE) }),
    targetId: field('preview node id or null', { type: ['string', 'null'] }),
  }
);

const VIEW_PATCH = shape(
  {},
  {
    ui: field(
      'object with filterText, filterTag, git, heat, theme, and sideW presentation fields',
      { $ref: '#/$defs/ui' }
    ),
    treeInitialized: field('boolean', { type: 'boolean' }),
    collapsed: field('array of directory ids', {
      type: 'array',
      items: { type: 'string' },
    }),
    selectedId: field('node id or null', { type: ['string', 'null'] }),
    side: field('object with mode and targetId side-panel fields', {
      $ref: '#/$defs/side',
    }),
  }
);

const VIEW_TRANSACTION = shape(
  {
    patch: field('view patch object', { $ref: '#/$defs/patch' }),
  },
  { expectedRevision: EXPECTED_REVISION }
);

function fieldSchema(definition) {
  return { ...definition.schema, description: definition.description };
}

function conciseFields(fields) {
  return Object.fromEntries(
    Object.entries(fields).map(([name, definition]) => [name, definition.description])
  );
}

function conciseShape(definition) {
  return {
    required: conciseFields(definition.required),
    optional: conciseFields(definition.optional),
  };
}

function objectSchema(definition, { additionalProperties }) {
  const requiredNames = Object.keys(definition.required);
  return {
    type: 'object',
    properties: Object.fromEntries(
      [...Object.entries(definition.required), ...Object.entries(definition.optional)].map(
        ([name, fieldDefinition]) => [name, fieldSchema(fieldDefinition)]
      )
    ),
    ...(requiredNames.length ? { required: requiredNames } : {}),
    additionalProperties,
  };
}

function commandSchema(definition) {
  return {
    description: `${definition.type} semantic command`,
    type: 'object',
    properties: {
      type: { const: definition.type, description: 'command discriminator' },
      ...Object.fromEntries(
        [...Object.entries(definition.required), ...Object.entries(definition.optional)].map(
          ([name, fieldDefinition]) => [name, fieldSchema(fieldDefinition)]
        )
      ),
    },
    required: ['type', ...Object.keys(definition.required)],
    additionalProperties: true,
  };
}

function planInputSchema() {
  const commandSchemas = Object.fromEntries(
    COMMAND_DEFINITIONS.map((definition) => [
      `command-${definition.type}`,
      commandSchema(definition),
    ])
  );
  return {
    $schema: JSON_SCHEMA_DIALECT,
    title: 'Reorg plan transaction input',
    description: 'Input accepted by reorg mutate',
    oneOf: [{ $ref: '#/$defs/transaction' }, { $ref: '#/$defs/commands' }],
    $defs: {
      transaction: {
        description: 'Revision-aware semantic plan transaction',
        ...objectSchema(PLAN_TRANSACTION, { additionalProperties: true }),
      },
      commands: {
        description: 'Non-empty semantic command array',
        type: 'array',
        minItems: 1,
        items: { $ref: '#/$defs/command' },
      },
      command: {
        description: 'One supported semantic command',
        oneOf: COMMAND_DEFINITIONS.map(({ type }) => ({
          $ref: `#/$defs/command-${type}`,
        })),
      },
      ...commandSchemas,
    },
  };
}

function viewInputSchema() {
  return {
    $schema: JSON_SCHEMA_DIALECT,
    title: 'Reorg view update input',
    description: 'Input accepted by reorg view',
    oneOf: [{ $ref: '#/$defs/transaction' }, { $ref: '#/$defs/patch' }],
    $defs: {
      transaction: {
        description: 'Revision-aware shared view transaction',
        ...objectSchema(VIEW_TRANSACTION, { additionalProperties: true }),
      },
      patch: {
        description: 'Partial shared view update',
        ...objectSchema(VIEW_PATCH, { additionalProperties: false }),
      },
      ui: {
        description: 'Partial presentation settings update',
        ...objectSchema(VIEW_UI, { additionalProperties: false }),
      },
      side: {
        description: 'Partial side-panel state update',
        ...objectSchema(VIEW_SIDE, { additionalProperties: false }),
      },
    },
  };
}

export function collaborationSchema() {
  return {
    format: 'reorg-collaboration-schema',
    version: COLLABORATION_SCHEMA_VERSION,
    jsonSchemaDialect: JSON_SCHEMA_DIALECT,
    inspect: {
      command: 'reorg inspect [dir] --json [--data-dir DIR]',
      rescanCommand: 'reorg rescan [dir] --json [--data-dir DIR]',
      returns: [
        'workspace',
        'dataDir',
        'scan',
        'plan',
        'transactions',
        'view',
        'projection',
        'resolved',
      ],
    },
    planTransaction: {
      command: 'reorg mutate [dir] --input FILE [--data-dir DIR] [--json]',
      input: {
        acceptedForms: ['transaction object', 'command array'],
        transaction: conciseShape(PLAN_TRANSACTION),
      },
      commands: COMMAND_DEFINITIONS.map(({ type, required, optional }) => ({
        type,
        ...conciseShape({ required, optional }),
      })),
      inputSchema: planInputSchema(),
    },
    viewUpdate: {
      command: 'reorg view [dir] --input FILE [--data-dir DIR] [--json]',
      focusCommand: 'reorg view [dir] --focus ID [--data-dir DIR] [--json]',
      input: {
        acceptedForms: ['view patch object', 'transaction object'],
        transaction: conciseShape(VIEW_TRANSACTION),
      },
      patch: conciseShape(VIEW_PATCH),
      inputSchema: viewInputSchema(),
    },
    portability: {
      moveData: 'reorg state move DEST --data-dir SOURCE',
      rebindRoot: 'reorg state rebind NEW_ROOT --data-dir DIR',
    },
    safety: {
      directStateFileMutationSupported: false,
      stateCommandsModifySourceFilesystem: false,
      browserApplyEnabledByDefault: false,
      browserApplyEnableFlag: '--allow-apply',
      filesystemApplyCommand: 'reorg apply [dir] --yes [--data-dir DIR]',
    },
    errors: {
      jsonFlag: 'Machine-readable errors are written as one JSON object to stderr',
      codes: {
        [COMMAND_ERROR_CODE.REVISION_CONFLICT]:
          'inspect again before reconsidering the intended mutation',
        [WORKSPACE_BUSY_CODE]: 'retry the same transaction id after a short delay',
        [COMMAND_ERROR_CODE.IDEMPOTENCY_CONFLICT]:
          'choose a new id only for genuinely different commands',
        [COMMAND_ERROR_CODE.SCAN_CONFLICT]: 'prepare the apply again from the latest scan',
        [COMMAND_ERROR_CODE.INVALID]: 'correct the command before retrying',
      },
    },
  };
}
