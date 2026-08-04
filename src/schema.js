import { COMMAND, COMMAND_ERROR_CODE } from './commands.js';
import { WORKSPACE_BUSY_CODE } from './state.js';
import { SIDE_MODE } from './view.js';

export const COLLABORATION_SCHEMA_VERSION = 1;

const command = (type, required, optional = {}) => ({
  type,
  required,
  optional,
});

export function collaborationSchema() {
  return {
    format: 'reorg-collaboration-schema',
    version: COLLABORATION_SCHEMA_VERSION,
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
        commands: 'required array',
        expectedRevision: 'optional non-negative integer; defaults to the revision read by the CLI',
        transactionId: 'optional idempotency key string',
        actor: 'optional attribution string',
      },
      commands: [
        command(COMMAND.MOVE, { id: 'string', parentId: 'directory id or "."' }),
        command(COMMAND.RENAME, { id: 'string', name: 'single path component' }),
        command(
          COMMAND.CREATE_FOLDER,
          { parentId: 'directory id or "."', name: 'single path component' },
          { id: 'string beginning "new:"' }
        ),
        command(COMMAND.REMOVE_CREATED, { id: 'created folder id' }),
        command(COMMAND.TRASH, { id: 'string' }),
        command(COMMAND.KEEP, { id: 'string' }),
        command(COMMAND.RESTORE_ENTRY, { id: 'original node id' }),
        command(
          COMMAND.SET_NOTE,
          { target: 'node id or "."', body: 'non-empty string' },
          { id: 'string' }
        ),
        command(COMMAND.DELETE_NOTE, { id: 'note id' }),
        command(COMMAND.RESET_PLAN, {}),
        command(COMMAND.MERGE_SUMMARIES, { summaries: 'object mapping node ids to strings' }),
      ],
    },
    viewUpdate: {
      command: 'reorg view [dir] --input FILE [--data-dir DIR] [--json]',
      focusCommand: 'reorg view [dir] --focus ID [--data-dir DIR] [--json]',
      patch: {
        ui:
          'object with filterText, filterTag, git, heat, theme, and sideW presentation fields',
        treeInitialized: 'boolean',
        collapsed: 'array of directory ids',
        selectedId: 'node id or null',
        side: {
          mode: Object.values(SIDE_MODE),
          targetId: 'preview node id or null',
        },
      },
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
